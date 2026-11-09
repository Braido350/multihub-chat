// Provedor OpenRouter: modelos gratuitos em rodízio (ou uma lista escolhida), com a mesma validação.
// Modelos gratuitos podem guardar o conteúdo enviado: por isso eles SEMPRE recebem o e-mail no modo restrito.
const { SYSTEM_PROMPT, SCHEMA, extractJson, validate } = require("./prompt");
const { ProviderError } = require("./anthropic");
const TRIAGE_TASK = { system: SYSTEM_PROMPT, schema: SCHEMA, name: "triagem", validate };

const BASE = process.env.MULTIHUB_OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";
const MODELS_TTL = 24 * 60 * 60 * 1000;
const MAX_TRIES = 4; // modelos tentados por e-mail antes de desistir e tentar mais tarde

const nextUtcMidnight = () => {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) + 60_000;
};

const isFree = (m) => /:free$/.test(m.id) || (m.pricing && Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0);

function createOpenRouterProvider({ apiKey, mode, models, getCache, setCache, log }) {
  const cooldown = new Map(); // modelo -> timestamp até quando fica de lado
  const support = new Map(); // modelo -> "schema" | "json" | "none"

  /** Lista de modelos gratuitos (cache de 24 h). */
  async function freeModels() {
    const cached = getCache();
    if (cached && Date.now() - cached.at < MODELS_TTL && cached.models.length) return cached.models;
    const res = await fetch(`${BASE}/models`, { signal: AbortSignal.timeout(20_000) }).catch(() => null);
    if (!res || !res.ok) {
      if (cached && cached.models.length) return cached.models; // usa a lista antiga se a API falhar
      throw new ProviderError("Não foi possível obter a lista de modelos da OpenRouter.", "network", 10 * 60_000);
    }
    const data = (await res.json()).data || [];
    const list = data
      .filter((m) => isFree(m) && (m.context_length || 0) >= 8000)
      .map((m) => {
        const p = m.supported_parameters || [];
        return { id: m.id, ctx: m.context_length, fmt: p.includes("structured_outputs") ? "schema" : p.includes("response_format") ? "json" : "none" };
      })
      // Primeiro os que garantem o formato JSON, depois os de contexto maior
      .sort((a, b) => ["schema", "json", "none"].indexOf(a.fmt) - ["schema", "json", "none"].indexOf(b.fmt) || b.ctx - a.ctx)
      .slice(0, 25);
    setCache({ at: Date.now(), models: list });
    return list;
  }

  async function candidates() {
    const list = mode === "chosen" ? (models || []).map((id) => ({ id, fmt: support.get(id) || "schema" })) : await freeModels();
    const now = Date.now();
    return list.filter((m) => !(cooldown.get(m.id) > now));
  }

  async function callModel(m, userMessage, task = TRIAGE_TASK) {
    const body = {
      model: m.id,
      messages: [
        { role: "system", content: task.system },
        { role: "user", content: userMessage },
      ],
      max_tokens: 2000,
      temperature: 0,
    };
    if (m.fmt === "schema") body.response_format = { type: "json_schema", json_schema: { name: task.name, strict: true, schema: task.schema } };
    else if (m.fmt === "json") body.response_format = { type: "json_object" };
    // Modelos pagos escolhidos: só provedores que não guardam os dados enviados
    if (mode === "chosen") body.provider = { data_collection: "deny" };

    let res;
    try {
      res = await fetch(`${BASE}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "X-Title": "MultiHub Chat" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(90_000),
      });
    } catch {
      return { error: "network", wait: 30 * 60_000 };
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) throw new ProviderError("Chave da OpenRouter inválida.", "auth");
    if (res.status === 429) {
      const ra = Number(res.headers.get("retry-after"));
      return { error: "rate", wait: (Number.isFinite(ra) && ra > 0 ? ra : 600) * 1000 };
    }
    if (res.status === 402) return { error: "quota", wait: nextUtcMidnight() - Date.now() }; // crédito/limite diário
    if (res.status === 400 && body.response_format && /response_format|json_schema|structured/i.test(JSON.stringify(data))) {
      support.set(m.id, m.fmt === "schema" ? "json" : "none"); // o modelo não aceita esse formato: rebaixa e tenta de novo
      return { error: "format", retry: true };
    }
    if (!res.ok || data.error) return { error: `http ${res.status}`, wait: 30 * 60_000 };
    const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    try {
      return { result: task.validate(extractJson(text)), model: data.model || m.id, usage: data.usage };
    } catch {
      return { error: "invalid", wait: 30 * 60_000 };
    }
  }

  return {
    name: "openrouter",
    // Gratuitos: sempre restrito. Escolhidos (pagos, sem guardar dados): modo normal
    restricted: mode !== "chosen",
    async classify(userMessage) {
      return this.ask(TRIAGE_TASK, userMessage);
    },
    /** Pedido genérico com resposta JSON ({system, schema, name, validate}): rodízio entre os modelos. */
    async ask(task, userMessage) {
      const list = await candidates();
      if (!list.length) {
        const until = Math.min(...[...cooldown.values()].filter((t) => t > Date.now()), Date.now() + 30 * 60_000);
        throw new ProviderError("Nenhum modelo da OpenRouter disponível agora (limites esgotados).", "rate", until - Date.now());
      }
      const tried = [];
      for (const m of list.slice(0, MAX_TRIES)) {
        let r = await callModel(m, userMessage, task);
        if (r.retry) r = await callModel({ ...m, fmt: support.get(m.id) }, userMessage, task);
        if (r.result) return { result: r.result, model: r.model, usage: r.usage, cost: 0, escalated: false, tried };
        cooldown.set(m.id, Date.now() + (r.wait || 30 * 60_000));
        tried.push(`${m.id}: ${r.error}`);
        log(`openrouter: ${m.id} indisponível (${r.error}); tentando o próximo`);
      }
      throw new ProviderError(`Modelos da OpenRouter falharam: ${tried.join("; ")}`.slice(0, 300), "rate", 10 * 60_000);
    },
    status() {
      const now = Date.now();
      return { cooling: [...cooldown].filter(([, t]) => t > now).map(([id, t]) => ({ id, until: t })) };
    },
    freeModels,
  };
}

module.exports = { createOpenRouterProvider };
