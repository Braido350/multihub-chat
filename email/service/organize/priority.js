// Prioritários: pontuação de relevância (0–100) de cada e-mail da Caixa de entrada. Tudo local; o LLM (opcional)
// só é consultado nos casos ambíguos.
//
// Nota exibida = nota calculada + ajuste manual + pontos de atividade (limitada a 0–100):
//   - nota calculada: regra padrão (categoria da organização) misturada com o aprendido (remetente, domínio,
//     tópicos e k vizinhos pelo vetor do conteúdo). A própria mensagem não entra no aprendizado dela mesma.
//   - ajuste manual: ★ Importante +10 / Não importante -10, guardado à parte (o recálculo não apaga).
//   - atividade: abrir, ler, responder, encaminhar, favoritar, baixar anexo, clicar em link, excluir/arquivar sem ler.
// Marcações e atividades perdem peso com a idade (meia-vida de 45 dias) e ensinam remetente/domínio/tópicos.
// Detalhes e pesos: docs/ORGANIZACAO.md, seção "Prioritários".
const { words, stripHtml, FREEMAIL, NAME } = require("./rules");

const DIM = 256; // dimensões do vetor do conteúdo
const HALF_LIFE_DAYS = 45; // um feedback de 45 dias vale metade de um de hoje
const K = 7; // vizinhos mais próximos
const MIN_SIM = 0.2;
const FULL_AT = 15; // com 15 feedbacks o aprendido vale 100%
const WINDOW_DAYS = 60; // pontua as mensagens dos últimos 60 dias
const MAX_SCORE = 4000;
const LLM_DAYS = 3; // o LLM só olha mensagens recentes (custo)
const LLM_BAND = 12; // ambíguo = até 12 pontos do limiar
const LLM_PER_RUN = 15;
const DEFAULTS = { threshold: 60, llm: true };
const BASE = { importante: 72, outros: 40, propaganda: 12, suspeito: 0 };

// ---------- vetor do conteúdo ("embedding" local, sem rede) ----------
function fnv(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
// Alguns remetentes mandam HTML na parte de texto: tira as marcas antes de extrair palavras
const looksHtml = (t) => /<\/?(html|body|div|table|td|tr|span|p|br|font|center|style|a)\b[^>]*>/i.test(t);
const bodyText = (m) => {
  const t = m.text || "";
  if (t && !looksHtml(t)) return t;
  return stripHtml(t || m.html || "") || m.snippet || "";
};
// Restos de HTML/CSS que não são assunto do e-mail
const HTML_WORDS = new Set(
  ("bgcolor center class style width height align valign border cellpadding cellspacing color font face size span " +
    "table nbsp href target blank src img alt div body html head meta charset px solid none auto important " +
    "padding margin display block inline background left right top bottom text decoration underline arial helvetica " +
    "sans serif verdana tahoma family weight bold normal line rgba rgb hidden visibility mso").split(" ")
);
const isTopic = (w) => w.length >= 4 && w !== "#" && !HTML_WORDS.has(w);

/** Vetor normalizado (hashing de palavras e pares de palavras): e-mails sobre o mesmo assunto ficam próximos. */
function embed(subject, text) {
  const v = new Float32Array(DIM);
  const add = (tok, w) => {
    const h = fnv(tok);
    v[h % DIM] += (h & 0x80000000 ? -1 : 1) * w;
  };
  const sw = words(subject, 30, "");
  const tw = words(text, 400, "");
  for (const w of sw) add(w, 2);
  for (const w of tw) add(w, 1);
  for (let i = 1; i < tw.length; i++) add(tw[i - 1] + " " + tw[i], 0.5);
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < DIM; i++) v[i] /= n;
  return v;
}
const toBlob = (v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
const fromBlob = (b) => (b && b.length === DIM * 4 ? new Float32Array(new Uint8Array(b).buffer) : null);
function cos(a, b) {
  let s = 0;
  for (let i = 0; i < DIM; i++) s += a[i] * b[i];
  return s;
}

/** Palavras-chave (tópicos): as mais frequentes, com o assunto valendo 3×. */
function topicsOf(subject, text) {
  const c = new Map();
  for (const w of words(subject, 30, "")) if (isTopic(w)) c.set(w, (c.get(w) || 0) + 3);
  for (const w of words(text, 400, "")) if (isTopic(w)) c.set(w, (c.get(w) || 0) + 1);
  return [...c].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([w]) => w);
}
const domainOf = (addr) => String(addr || "").toLowerCase().split("@")[1] || "";
const decay = (at, now) => Math.pow(0.5, Math.max(0, now - at) / (HALF_LIFE_DAYS * 864e5));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const plural = (n, s, p) => `${n} ${n === 1 ? s : p}`;

// ---------- marcações e atividade ----------
const MANUAL_STEP = 10; // ★ Importante soma 10; Não importante tira 10
/** Ações dentro do e-mail: pontos somados à nota (sem LLM) e rótulo exibido no motivo. */
const ACTIONS = {
  open: { points: 2, label: "aberto" },
  read: { points: 3, label: "lido por mais de 20 s" },
  reply: { points: 8, label: "respondido" },
  forward: { points: 6, label: "encaminhado" },
  flag: { points: 5, label: "favoritado" },
  attachment: { points: 4, label: "anexo baixado" },
  link: { points: 3, label: "link clicado" },
  delete_unopened: { points: -8, label: "excluído sem abrir" },
  archive_unread: { points: -4, label: "arquivado sem ler" },
};
const EXPLICIT_LEARN = 1; // peso de uma marcação explícita no aprendizado
const ACTIVITY_LEARN = 0.35; // atividade ensina menos que o clique explícito (0,35 a cada 8 pontos)
const ACTIVITY_CAP = 0.5; // e no máximo metade de um clique por e-mail
const keyOf = (m) => m.account_id + "|" + m.msg_key;
const parseList = (s) => {
  try {
    const v = JSON.parse(s || "[]");
    return Array.isArray(v) ? v.filter((w) => typeof w === "string" && !HTML_WORDS.has(w)) : []; // marcações antigas com restos de HTML
  } catch {
    return [];
  }
};
const signed = (n) => (n > 0 ? `+${n}` : `${n}`);

// ---------- modelo (montado em memória a partir das marcações e da atividade) ----------
/**
 * @param fbRows  linhas de priority_feedback (marcações explícitas)
 * @param actRows linhas de priority_activity (ações dentro do e-mail)
 */
function buildModel(fbRows, actRows = [], now = Date.now()) {
  const senders = new Map();
  const domains = new Map();
  const topics = new Map();
  const vectors = [];
  const fb = new Map(); // chave -> {label, adjust}
  const acts = new Map(); // chave -> [{action, points, at}]
  const own = new Map(); // chave -> contribuições dela mesma (para tirar ao pontuar a própria mensagem)
  const addTo = (map, k, w, kind) => {
    const x = map.get(k) || { w: 0, pos: 0, neg: 0, act: 0, n: 0 };
    x.w += w;
    x.n++;
    if (kind === "pos") x.pos++;
    else if (kind === "neg") x.neg++;
    else x.act++;
    map.set(k, x);
  };
  const learn = (key, from, domain, tl, w, kind) => {
    if (!w) return;
    addTo(senders, from, w, kind);
    const dom = domain && !FREEMAIL.has(domain) ? domain : null;
    if (dom) addTo(domains, dom, w, kind);
    for (const t of tl) addTo(topics, t, w, kind);
    const list = own.get(key) || [];
    list.push({ from, dom, tl, w, kind });
    own.set(key, list);
  };
  for (const f of fbRows) {
    const key = keyOf(f);
    fb.set(key, { label: f.label, adjust: f.adjust ?? f.label * MANUAL_STEP });
    const d = decay(f.created_at, now);
    learn(key, f.from_addr, f.domain, parseList(f.topics), f.label * EXPLICIT_LEARN * d, f.label > 0 ? "pos" : "neg");
    const emb = fromBlob(f.embedding);
    if (emb) vectors.push({ emb, label: f.label, d, key });
  }
  // Atividade: soma os pontos de cada e-mail (com a queda por idade) e ensina uma vez por e-mail, com teto
  const net = new Map();
  for (const a of actRows) {
    const key = keyOf(a);
    const list = acts.get(key) || [];
    list.push({ action: a.action, points: a.points, at: a.created_at });
    acts.set(key, list);
    const x = net.get(key) || { a, pts: 0 };
    x.pts += a.points * decay(a.created_at, now);
    net.set(key, x);
  }
  for (const [key, { a, pts }] of net) {
    const w = Math.sign(pts) * Math.min(ACTIVITY_CAP, (Math.abs(pts) / 8) * ACTIVITY_LEARN);
    learn(key, a.from_addr, a.domain, parseList(a.topics), w, "act");
  }
  return { n: fbRows.length, nAct: net.size, senders, domains, topics, vectors, fb, acts, own, now };
}

/** Contribuição da própria mensagem a tirar de um item do mapa (leave-one-out). */
function without(x, mine) {
  if (!x) return null;
  const r = { ...x };
  for (const c of mine) {
    r.w -= c.w;
    r.n--;
    if (c.kind === "pos") r.pos--;
    else if (c.kind === "neg") r.neg--;
    else r.act--;
  }
  return r.n > 0 ? r : null;
}

/** Regra padrão (sem marcações): categoria da organização. */
function defaultScore(m) {
  const grp = m.risk >= 2 ? "suspeito" : m.grp || "outros";
  return { score: BASE[grp] ?? 40, reason: `regra padrão: categoria ${NAME[grp] || "Outros"}` };
}

/**
 * Nota calculada (sem o ajuste manual nem a atividade da própria mensagem).
 * @returns {{score, source, reason}}
 */
function baseScore(model, m) {
  const def = defaultScore(m);
  if (m.risk >= 2 || m.grp === "suspeito") return { score: Math.min(def.score, 5), source: "padrao", reason: "suspeito na análise de segurança" };
  const key = keyOf(m);
  const mine = model.own.get(key) || [];
  const ownExplicit = mine.filter((c) => c.kind !== "act").length;
  const n = model.n - ownExplicit + 0.3 * (model.nAct - mine.filter((c) => c.kind === "act").length);
  if (n <= 0) return { ...def, source: "padrao" };

  let z = 0;
  let evidence = 0;
  const why = [];
  const addr = String(m.from_addr || "").toLowerCase();
  const s = without(model.senders.get(addr), mine.filter((c) => c.from === addr));
  if (s && Math.abs(s.w) > 0.01) {
    z += 1.6 * Math.tanh(s.w / 1.2);
    evidence += Math.min(1, s.pos + s.neg + 0.4 * s.act);
    const parts = [s.pos && plural(s.pos, "importante", "importantes"), s.neg && plural(s.neg, "não importante", "não importantes"), s.act && `atividade em ${plural(s.act, "e-mail", "e-mails")}`];
    why.push(`remetente (${parts.filter(Boolean).join(", ")})`);
  }
  const dom = domainOf(addr);
  const d = !FREEMAIL.has(dom) && without(model.domains.get(dom), mine.filter((c) => c.dom === dom));
  if (d && Math.abs(d.w) > 0.01 && !(s && s.n === d.n)) {
    z += 0.8 * Math.tanh(d.w / 2.5);
    evidence += 0.6;
    why.push(`domínio ${dom} ${d.w >= 0 ? "costuma ser importante" : "costuma não ser importante"}`);
  }
  const text = bodyText(m);
  const tl = topicsOf(m.subject, text);
  const tw = [];
  for (const t of tl) {
    const x = without(model.topics.get(t), mine.filter((c) => c.tl.includes(t)));
    if (x && x.n >= 2) tw.push([t, x.w / (x.n + 1)]);
  }
  if (tw.length) {
    tw.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    const top = tw.slice(0, 5);
    const avg = top.reduce((a, [, w]) => a + w, 0) / top.length;
    z += 1.0 * Math.tanh(2 * avg);
    evidence += 0.5;
    const pos = top.filter(([, w]) => w > 0.1).map(([t]) => t);
    const neg = top.filter(([, w]) => w < -0.1).map(([t]) => t);
    if (pos.length) why.push(`tópicos aprovados: ${pos.slice(0, 3).join(", ")}`);
    if (neg.length) why.push(`tópicos rejeitados: ${neg.slice(0, 3).join(", ")}`);
  }
  const others = model.vectors.filter((x) => x.key !== key);
  if (others.length) {
    const v = embed(m.subject, text);
    const near = [];
    for (const x of others) {
      const sim = cos(v, x.emb);
      if (sim >= MIN_SIM) near.push([sim, x]);
    }
    near.sort((a, b) => b[0] - a[0]);
    const top = near.slice(0, K);
    if (top.length) {
      let num = 0;
      let den = 0;
      let simSum = 0;
      for (const [sim, x] of top) {
        num += sim * x.d * x.label;
        den += sim * x.d;
        simSum += sim;
      }
      const strength = Math.min(1, simSum / 1.5);
      z += 1.4 * (den ? num / den : 0) * strength;
      evidence += strength;
      const p = top.filter(([, x]) => x.label > 0).length;
      why.push(`parecido com ${[p && plural(p, "importante", "importantes"), top.length - p && plural(top.length - p, "não importante", "não importantes")].filter(Boolean).join(" e ")}`);
    }
  }
  if (!evidence) return { ...def, source: "padrao" };
  const learned = 50 + 50 * Math.tanh(z / 1.5);
  // Poucas marcações: a regra padrão ainda pesa; com FULL_AT ou mais, vale o aprendido
  const alpha = clamp((n / FULL_AT) * Math.min(1, evidence), 0.35, 1);
  const score = clamp(Math.round((1 - alpha) * def.score + alpha * learned), 0, 100);
  const reason = "aprendido: " + why.slice(0, 3).join("; ") + (alpha < 1 ? `; ${def.reason}` : "");
  return { score, source: "aprendido", reason };
}

/**
 * Ajuste manual e pontos de atividade da própria mensagem (guardados à parte da nota calculada).
 * Respondida/favorita no servidor sem ação gravada (de outro programa) conta como a ação, na data do e-mail.
 */
function adjustments(model, m, now = Date.now()) {
  const key = keyOf(m);
  const f = model.fb.get(key);
  const manual = f ? f.adjust : 0;
  const parts = [];
  if (manual) parts.push({ n: manual, label: manual > 0 ? "marcado importante" : "marcado não importante" });
  const list = [...(model.acts.get(key) || [])];
  const has = new Set(list.map((a) => a.action));
  if (m.answered && !has.has("reply")) list.push({ action: "reply", points: ACTIONS.reply.points, at: m.date });
  if (m.flagged && !has.has("flag")) list.push({ action: "flag", points: ACTIONS.flag.points, at: m.date });
  let activity = 0;
  for (const a of list) {
    const pts = Math.round(a.points * decay(a.at, now));
    if (!pts) continue;
    activity += pts;
    parts.push({ n: pts, label: (ACTIONS[a.action] || { label: a.action }).label });
  }
  parts.sort((a, b) => Math.abs(b.n) - Math.abs(a.n));
  return { manual, activity, parts };
}

/**
 * Nota exibida = calculada (+ opinião do LLM, se houver) + ajuste manual + atividade, de 0 a 100.
 * @returns {{score, base, manual, activity, source, reason, ambiguous}}
 */
function scoreMessage(model, m, threshold, now = Date.now()) {
  let b = baseScore(model, m);
  if (m.llm_verdict != null) {
    const v = Math.round(0.4 * b.score + 0.6 * m.llm_verdict);
    b = { score: v, source: "llm", reason: `IA: ${m.llm_reason || "sem motivo"} (antes ${b.score}, ${b.reason})` };
  }
  const adj = adjustments(model, m, now);
  const score = clamp(b.score + adj.manual + adj.activity, 0, 100);
  const head = adj.parts.length ? adj.parts.map((p) => `${signed(p.n)} ${p.label}`).join(", ") + " · " : "";
  const reason = `${head}nota calculada ${b.score} (${b.reason})`;
  const source = adj.manual ? "manual" : b.source;
  return { score, base: b.score, manual: adj.manual, activity: adj.activity, source, reason, ambiguous: b.source !== "llm" && Math.abs(score - threshold) <= LLM_BAND };
}

/** Perfil resumido para o LLM: principais remetentes, tópicos aprovados/rejeitados e poucos exemplos. */
function buildProfile(model, rows) {
  const top = (map, sign, n) =>
    [...map]
      .filter(([, x]) => Math.sign(x.w) === sign)
      .sort((a, b) => Math.abs(b[1].w) - Math.abs(a[1].w))
      .slice(0, n)
      .map(([k]) => k);
  const ex = (label) =>
    rows
      .filter((f) => f.label === label)
      .slice(0, 3)
      .map((f) => ({ de: f.from_addr, assunto: String(f.subject).slice(0, 120) }));
  return {
    remetentes_importantes: top(model.senders, 1, 8),
    remetentes_nao_importantes: top(model.senders, -1, 8),
    topicos_aprovados: top(model.topics, 1, 10),
    topicos_rejeitados: top(model.topics, -1, 10),
    exemplos_importantes: ex(1),
    exemplos_nao_importantes: ex(-1),
    total_feedbacks: rows.length,
  };
}

function createPriority({ store, llm, emit, log }) {
  let model = null;
  let profile = null;
  let timer = null;
  let running = false;
  let again = false;
  let llmBlockedUntil = 0;
  let lastRun = null;
  let lastLlmError = null;

  function getConfig() {
    let c = {};
    try {
      c = JSON.parse(store.getSetting("priority_config") || "{}");
    } catch {}
    return { ...DEFAULTS, ...c };
  }
  function setConfig(p) {
    const c = getConfig();
    if (p.threshold !== undefined) c.threshold = clamp(Math.round(Number(p.threshold) || 0), 0, 100);
    if (p.llm !== undefined) c.llm = !!p.llm;
    store.setSetting("priority_config", JSON.stringify(c));
    kick(200);
    return c;
  }

  function rebuild() {
    const rows = store.listPriorityFeedback();
    model = buildModel(rows, store.listPriorityActivity());
    profile = buildProfile(model, rows);
    store.setSetting("priority_profile", JSON.stringify({ ...profile, atualizado: new Date().toISOString() }));
  }
  const getModel = () => (model || rebuild(), model);

  const row = (m, r, now) => ({
    $a: m.account_id, $k: m.msg_key, $score: r.score, $base: r.base, $manual: r.manual, $activity: r.activity,
    $source: r.source, $reason: r.reason, $lv: m.llm_verdict ?? null, $lr: m.llm_reason ?? null, $lat: m.llm_at ?? null, $now: now,
  });

  /** Recalcula a pontuação de mensagens (todas as recentes, ou só algumas) e grava o que mudou. */
  function rescore(ids) {
    const m0 = getModel();
    const { threshold } = getConfig();
    const rows = store.priorityCandidates(ids ? { ids } : { since: Date.now() - WINDOW_DAYS * 864e5, limit: MAX_SCORE });
    const out = [];
    const now = Date.now();
    const ask = [];
    const seen = new Set();
    for (const m of rows) {
      const key = keyOf(m);
      if (seen.has(key)) continue;
      seen.add(key);
      const r = scoreMessage(m0, m, threshold, now);
      if (r.ambiguous && !r.manual && m.llm_verdict == null && m.date >= now - LLM_DAYS * 864e5) ask.push(m);
      if (m.old_score !== r.score || m.old_source !== r.source || m.old_reason !== r.reason || m.old_base !== r.base) out.push(row(m, r, now));
    }
    store.savePriorityScores(out);
    return { changed: out.length, ask };
  }

  async function askLlm(list) {
    const cfg = getConfig();
    if (!cfg.llm || !list.length || Date.now() < llmBlockedUntil || !llm) return 0;
    const p = await llm().provider().catch(() => null);
    if (!p) return 0;
    // Gratuitos: só não lidas que chegaram depois que a chave foi colocada
    const free = llm().freeSince ? await llm().freeSince() : null;
    if (free) list = list.filter((m) => !m.seen && m.date >= free);
    let done = 0;
    for (const m of list.slice(0, LLM_PER_RUN)) {
      try {
        const r = await llm().askPriority({ accountId: m.account_id, profile: profile || (getModel(), profile), email: { de: m.from_addr, nome: m.from_name, assunto: m.subject, texto: bodyText(m).slice(0, 1200) } });
        if (!r) continue; // conta não liberou modelos gratuitos
        m.llm_verdict = clamp(Math.round(r.prioritario ? r.confianca : 100 - r.confianca), 0, 100);
        m.llm_reason = String(r.motivo || "").slice(0, 200);
        m.llm_at = Date.now();
        store.savePriorityScores([row(m, scoreMessage(getModel(), m, cfg.threshold), Date.now())]);
        done++;
        lastLlmError = null;
      } catch (err) {
        lastLlmError = err.message;
        llmBlockedUntil = Date.now() + Math.max(err.retryAfterMs || 0, 10 * 60_000);
        log(`prioritários: LLM indisponível (${err.message})`);
        break;
      }
    }
    return done;
  }

  async function run() {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      const t0 = Date.now();
      const r = rescore();
      lastRun = { at: Date.now(), ms: Date.now() - t0, changed: r.changed, ambiguous: r.ask.length };
      if (r.changed) emit("priority-changed", {});
      if (await askLlm(r.ask)) emit("priority-changed", {});
    } catch (err) {
      log(`prioritários: ${err.message}`);
    } finally {
      running = false;
      if (again) {
        again = false;
        kick(500);
      }
    }
  }
  function kick(delay = 1500) {
    clearTimeout(timer);
    timer = setTimeout(run, delay);
  }

  /** Depois de uma marcação ou ação: refaz o modelo (e o perfil do LLM), a própria mensagem na hora e o resto depois. */
  function changed(m) {
    rebuild();
    rescore([m.id]);
    kick(300);
    emit("priority-changed", {});
  }
  const about = (m) => {
    const text = bodyText(m);
    return { text, from: String(m.from_addr || "").toLowerCase(), dom: domainOf(m.from_addr), topics: topicsOf(m.subject, text) };
  };

  /** ★ Importante (1) / Não importante (-1): soma ou tira 10 da nota; 0 desfaz. */
  function feedback(id, label) {
    const m = store.priorityMessage(id);
    if (!m) throw new Error("Mensagem não encontrada.");
    if (!label) store.deletePriorityFeedback(m.account_id, m.msg_key);
    else {
      const a = about(m);
      const l = label > 0 ? 1 : -1;
      store.setPriorityFeedback({
        $a: m.account_id, $k: m.msg_key, $mid: m.id, $from: a.from, $dom: a.dom, $subj: m.subject || "",
        $topics: JSON.stringify(a.topics), $emb: toBlob(embed(m.subject, a.text)), $label: l, $adjust: l * MANUAL_STEP, $now: Date.now(),
      });
    }
    changed(m);
    return get(id);
  }

  /**
   * Ação dentro do e-mail (uma vez por mensagem e tipo). on = false desfaz (ex.: tirar dos favoritos).
   * @param {keyof ACTIONS} action
   */
  function activity(id, action, on = true) {
    const def = ACTIONS[action];
    if (!def) throw new Error(`Ação desconhecida: ${action}`);
    const m = store.priorityMessage(id);
    if (!m) return null;
    if (!on) store.removePriorityActivity(m.account_id, m.msg_key, action);
    else {
      const a = about(m);
      const added = store.addPriorityActivity({
        $a: m.account_id, $k: m.msg_key, $mid: m.id, $action: action, $points: def.points, $from: a.from, $dom: a.dom,
        $topics: JSON.stringify(a.topics), $now: Date.now(),
      });
      if (!added) return get(id); // já registrada
    }
    changed(m);
    return get(id);
  }

  function get(id) {
    const m = store.priorityMessage(id);
    if (!m) return null;
    const f = store.getPriorityFeedback(m.account_id, m.msg_key);
    const s = store.getPriorityScore(m.account_id, m.msg_key);
    return {
      label: f ? f.label : 0,
      score: s ? s.score : null,
      base: s ? s.base : null,
      manual: s ? s.manual : 0,
      activity: s ? s.activity : 0,
      source: s ? s.source : null,
      reason: s ? s.reason : null,
      threshold: getConfig().threshold,
    };
  }

  function status() {
    const c = getConfig();
    return { config: c, counts: store.priorityCounts(c.threshold), lastRun, lastLlmError, profile: profile || (getModel(), profile) };
  }

  function reset() {
    store.clearPriorityFeedback();
    rebuild();
    kick(100);
  }

  return { kick, feedback, activity, get, getConfig, setConfig, status, reset, runNow: run, rescore };
}

module.exports = { createPriority, embed, topicsOf, buildModel, scoreMessage, baseScore, adjustments, defaultScore, buildProfile, cos, ACTIONS, MANUAL_STEP };
