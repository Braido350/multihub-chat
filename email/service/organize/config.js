// Configurações da organização da caixa de entrada e da segurança (tabela settings, em JSON).
// Ficam fora da configuração do agente LLM: valem com ou sem LLM.
const CATS = ["importante", "propaganda", "outros"];

const DEFAULT_SENDERS = {
  trusted: [], // "pessoa@x.com" ou "@dominio.com": vão para Importante (se nada indicar imitação)
  blocked: [], // vão para Suspeitos
  rules: [], // [{ match: "pessoa@x.com" | "@dominio.com", category }] — "Sempre classificar como"
};
const DEFAULT_SECURITY = {
  shadow: false, // modo sombra: só o selo de risco; suspeitos ficam no grupo da categoria
  sensitivity: "normal", // baixa | normal | alta
  neutralize: true, // quarentena: links desativados e anexos só para salvar nas mensagens suspeitas
};
const DEFAULT_ORGANIZE = {
  learning: true, // aprender com o uso (treino do modelo e reputação)
};

const clean = (v) => String(v || "").trim().toLowerCase();

/** Lista de remetentes: um por linha, vírgula ou ponto e vírgula; sem repetidos. */
function senderList(v) {
  const arr = Array.isArray(v) ? v : String(v || "").split(/[\n,;]+/);
  return [...new Set(arr.map(clean).filter((x) => /^@?[^\s@]+(@[^\s@]+)?$/.test(x)))].slice(0, 1000);
}

/** "pessoa@x.com" casa só o endereço; "@x.com" ou "x.com" casa o domínio e os subdomínios. */
function matches(entry, address) {
  const a = clean(address);
  const e = clean(entry);
  if (!e || !a) return false;
  if (e.includes("@") && !e.startsWith("@")) return e === a;
  const d = e.replace(/^@/, "");
  const domain = a.split("@")[1] || "";
  return domain === d || domain.endsWith("." + d);
}
const matchSender = (list, address) => (list || []).some((e) => matches(e, address));

function createConfig(store) {
  const read = (key, def) => {
    try {
      const v = JSON.parse(store.getSetting(key) || "null");
      return v && typeof v === "object" ? { ...def, ...v } : null;
    } catch {
      return null;
    }
  };

  function getSenders() {
    let c = read("senders_config", DEFAULT_SENDERS);
    if (!c) {
      // Primeira vez: as listas moram hoje na configuração do agente LLM; trazemos para cá
      const old = read("triage_config", {}) || {};
      c = { ...DEFAULT_SENDERS, trusted: senderList(old.trusted), blocked: senderList(old.blocked) };
      store.setSetting("senders_config", JSON.stringify(c));
    }
    return c;
  }

  function setSenders(patch) {
    const c = { ...getSenders() };
    if (patch.trusted !== undefined) c.trusted = senderList(patch.trusted);
    if (patch.blocked !== undefined) c.blocked = senderList(patch.blocked);
    if (patch.rules !== undefined) {
      const byMatch = new Map();
      for (const r of Array.isArray(patch.rules) ? patch.rules : []) {
        const m = senderList([r && r.match])[0];
        if (m && CATS.includes(r.category)) byMatch.set(m, { match: m, category: r.category });
      }
      c.rules = [...byMatch.values()].slice(0, 1000);
    }
    store.setSetting("senders_config", JSON.stringify(c));
    return c;
  }

  /** Regra "sempre classificar como": endereço exato vence domínio; domínio mais específico vence. */
  function senderRule(address, c = getSenders()) {
    const a = clean(address);
    const exact = c.rules.find((r) => r.match === a);
    if (exact) return exact;
    return c.rules.filter((r) => matches(r.match, a)).sort((x, y) => y.match.length - x.match.length)[0] || null;
  }

  /** Cria, troca ou remove (category = null) a regra de um remetente. */
  function setSenderRule(match, category) {
    const m = senderList([match])[0];
    if (!m) throw new Error("Remetente inválido.");
    const c = getSenders();
    const rules = c.rules.filter((r) => r.match !== m);
    if (category) {
      if (!CATS.includes(category)) throw new Error("Categoria inválida.");
      rules.push({ match: m, category });
    }
    return setSenders({ rules });
  }

  function getSecurity() {
    return read("security_config", DEFAULT_SECURITY) || { ...DEFAULT_SECURITY };
  }
  function setSecurity(patch) {
    const c = { ...getSecurity() };
    if (patch.shadow !== undefined) c.shadow = !!patch.shadow;
    if (patch.neutralize !== undefined) c.neutralize = !!patch.neutralize;
    if (patch.sensitivity !== undefined) c.sensitivity = ["baixa", "normal", "alta"].includes(patch.sensitivity) ? patch.sensitivity : "normal";
    store.setSetting("security_config", JSON.stringify(c));
    return c;
  }

  function getOrganize() {
    return read("organize_config", DEFAULT_ORGANIZE) || { ...DEFAULT_ORGANIZE };
  }
  function setOrganize(patch) {
    const c = { ...getOrganize() };
    if (patch.learning !== undefined) c.learning = !!patch.learning;
    store.setSetting("organize_config", JSON.stringify(c));
    return c;
  }

  return { getSenders, setSenders, senderRule, setSenderRule, getSecurity, setSecurity, getOrganize, setOrganize };
}

/**
 * A mensagem é suspeita? Usa a análise de risco (regras, antivírus e, se ligado, o LLM), a lista de bloqueados
 * e a sensibilidade escolhida.
 * @param {{det_level?:string, det_score?:number, signals?:string, llm_category?:string, from_addr?:string}} r
 */
function isRisky(r, security, senders) {
  if (r.llm_category === "liberado") return false; // você tirou da quarentena: vale mais que regras, agente e listas
  if (senders && matchSender(senders.blocked, r.from_addr)) return true;
  if (r.llm_category === "suspeito") return true;
  const level = r.det_level || "ok";
  const sens = (security && security.sensitivity) || "normal";
  if (sens === "alta") return level === "suspeito" || level === "perigoso" || (r.det_score || 0) >= 25;
  if (sens === "baixa") return level === "perigoso" || (level === "suspeito" && /"severity":"critical"/.test(r.signals || ""));
  return level === "suspeito" || level === "perigoso";
}

module.exports = { createConfig, matchSender, senderList, isRisky, CATS };
