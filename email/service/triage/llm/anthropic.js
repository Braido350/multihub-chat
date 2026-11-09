// Provedor Claude API: Haiku em todos os e-mails, Sonnet só nos casos ambíguos.
const AnthropicSDK = require("@anthropic-ai/sdk");
const Anthropic = AnthropicSDK.default || AnthropicSDK;
const { SYSTEM_PROMPT, SCHEMA, extractJson, validate } = require("./prompt");
const TRIAGE_TASK = { system: SYSTEM_PROMPT, schema: SCHEMA, name: "triagem", validate };

const TRIAGE_MODEL = "claude-haiku-5-5";
const ESCALATION_MODEL = "claude-sonnet-5-5";
// US$ por milhão de tokens (entrada, saída, leitura de cache) para a estimativa de custo
const PRICES = {
  [TRIAGE_MODEL]: { in: 0.1, out: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  [ESCALATION_MODEL]: { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5 },
};

class ProviderError extends Error {
  /** @param {"auth"|"rate"|"network"|"refusal"|"invalid"|"other"} kind */
  constructor(message, kind, retryAfterMs) {
    super(message);
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
  }
}

function costOf(model, usage) {
  const p = PRICES[model] || PRICES[ESCALATION_MODEL];
  if (!usage) return 0;
  return (
    ((usage.input_tokens || 0) * p.in +
      (usage.output_tokens || 0) * p.out +
      (usage.cache_read_input_tokens || 0) * p.cacheRead +
      (usage.cache_creation_input_tokens || 0) * p.cacheWrite) /
    1e6
  );
}

function createAnthropicProvider({ apiKey }) {
  const client = new Anthropic({
    apiKey,
    baseURL: process.env.MULTIHUB_ANTHROPIC_BASE_URL || undefined, // só para testes com servidor simulado
    maxRetries: 2,
    timeout: 90_000,
  });

  async function call(model, userMessage, escalation, task = TRIAGE_TASK) {
    const req = {
      model,
      max_tokens: 4096, // folga para o raciocínio interno + o JSON
      // Prompt do sistema fixo e cacheado: cada e-mail paga só o próprio conteúdo
      system: [{ type: "text", text: task.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: userMessage }],
      output_config: { effort: escalation ? "medium" : "low", format: { type: "json_schema", schema: task.schema } },
    };
    let res;
    try {
      res = escalation
        ? // Sonnet 5.5: se os filtros de segurança recusarem (conteúdo de golpe), o servidor tenta outro modelo
          await client.beta.messages.create({ ...req, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" })
        : await client.messages.create(req);
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
        throw new ProviderError("Chave da API do Claude inválida ou sem permissão.", "auth");
      }
      if (err instanceof Anthropic.RateLimitError) {
        const ra = Number(err.headers && (err.headers.get ? err.headers.get("retry-after") : err.headers["retry-after"]));
        throw new ProviderError("Limite de uso da API do Claude atingido.", "rate", (Number.isFinite(ra) ? ra : 60) * 1000);
      }
      if (err instanceof Anthropic.BadRequestError) throw new ProviderError(`Requisição recusada: ${err.message}`.slice(0, 300), "other");
      if (err instanceof Anthropic.APIConnectionError) throw new ProviderError("Sem conexão com a API do Claude.", "network", 60_000);
      if (err instanceof Anthropic.APIError) throw new ProviderError(`Erro da API do Claude (${err.status}).`, "network", 120_000);
      throw err;
    }
    if (res.stop_reason === "refusal") {
      throw new ProviderError(`O modelo se recusou a analisar (${(res.stop_details && res.stop_details.category) || "sem categoria"}).`, "refusal");
    }
    if (res.stop_reason === "max_tokens") throw new ProviderError("Resposta cortada (limite de tokens).", "invalid");
    const text = (res.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    let parsed;
    try {
      parsed = task.validate(extractJson(text));
    } catch (err) {
      throw new ProviderError(`Resposta fora do formato: ${err.message}`, "invalid");
    }
    return { result: parsed, model: res.model || model, usage: res.usage, cost: costOf(model, res.usage) };
  }

  /** Precisa de uma segunda opinião (modelo maior)? */
  function ambiguous(det, r) {
    const detDanger = det.level === "suspeito" || det.level === "perigoso";
    return (
      r.category === "incerto" ||
      r.confidence < 60 ||
      (detDanger && r.category !== "suspeito") || // discorda das regras
      (!detDanger && r.category === "suspeito") // vai para quarentena só pelo LLM: confirmar antes
    );
  }

  return {
    name: "anthropic",
    restricted: false,
    /** Pedido genérico com resposta JSON ({system, schema, validate}), no modelo rápido. */
    async ask(task, userMessage) {
      const r = await call(TRIAGE_MODEL, userMessage, false, task);
      return { ...r, escalated: false };
    },
    /**
     * @returns {Promise<{result, model, usage, cost, escalated: boolean}>}
     */
    async classify(userMessage, det) {
      let first;
      try {
        first = await call(TRIAGE_MODEL, userMessage, false);
      } catch (err) {
        // Haiku não tem fallback no servidor: recusa ou formato inválido sobem direto para o Sonnet
        if (!(err instanceof ProviderError) || !["refusal", "invalid"].includes(err.kind)) throw err;
        const second = await call(ESCALATION_MODEL, userMessage, true);
        return { ...second, escalated: true, note: `Haiku: ${err.message}` };
      }
      if (!ambiguous(det, first.result)) return { ...first, escalated: false };
      const second = await call(ESCALATION_MODEL, userMessage, true).catch((err) => {
        if (err instanceof ProviderError && err.kind === "auth") throw err;
        return null; // sem segunda opinião: fica com a primeira (a regra de ouro continua valendo)
      });
      if (!second) return { ...first, escalated: false };
      return { ...second, cost: first.cost + second.cost, escalated: true, firstModel: first.model };
    },
  };
}

module.exports = { createAnthropicProvider, ProviderError, TRIAGE_MODEL, ESCALATION_MODEL };
