// Organização da caixa de entrada em grupos virtuais: Importante, Propaganda, Outros (+ Suspeitos e Já lidos).
// Tudo local, sem LLM e sem serviço externo. Nada é movido no servidor: o grupo fica só no banco do app.
//
// Camadas da decisão (a primeira que tiver confiança decide; abaixo do limiar vai para Outros):
//   1. você moveu a mensagem                     (manual)
//   2. regra de remetente / lista de confiáveis   (remetente)
//   3. reputação pelas suas correções             (reputacao)
//   4. regras com confiança muito alta (≥ 90)     (regra)
//   5. reputação pelo histórico do remetente      (reputacao)
//   6. regras acima do limiar da categoria        (regra)
//   7. modelo Naive Bayes treinado aqui           (modelo)
//   8. na dúvida: Outros                          (padrao)
//
// Processo em segundo plano: varre o banco em lotes (idempotente e retomável: o estado fica em inbox_class),
// classifica, treina e, quando o modelo ou a reputação mudam o bastante, reclassifica as decisões automáticas.
const { tx } = require("../db");
const { extract, scoreRules, tokensOf, NAME, MIN_CONF } = require("./rules");
const { NaiveBayes } = require("./bayes");
const { Reputation } = require("./reputation");
const { createConfig, matchSender, isRisky } = require("./config");
const { HDR_FIELDS, parseHdr } = require("./headers");

const BATCH = 200;
const MODEL_MIN_CONF = { importante: 75, propaganda: 90, outros: 60 };
const AUTO_SOURCES = new Set(["pendente", "reputacao", "regra", "modelo", "padrao"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createOrganizer({ store, emit, log, listWorkers }) {
  const config = createConfig(store);
  const model = new NaiveBayes(store);
  let rep = new Reputation();
  let ctx = null;
  let ctxAt = 0;
  let running = false;
  let again = false;
  let timer = null;
  let lastEmit = 0;
  const progress = { running: false, phase: "idle", done: 0, total: 0, finishedAt: null };

  const getInt = (key, def) => {
    const v = Number(store.getSetting(key));
    return Number.isFinite(v) && store.getSetting(key) != null ? v : def;
  };
  const bump = (key) => store.setSetting(key, String(getInt(key, 0) + 1));

  function context(force) {
    if (!force && ctx && Date.now() - ctxAt < 60_000) return ctx;
    const myAddrs = new Set(store.listAccounts().map((a) => String(a.email).toLowerCase()));
    ctx = {
      myAddrs,
      myDomains: new Set([...myAddrs].map((a) => a.split("@")[1]).filter(Boolean)),
      contacts: store.sentContacts(),
      senders: config.getSenders(),
      security: config.getSecurity(),
      organize: config.getOrganize(),
      version: getInt("organize_version", 1),
      gen: getInt("organize_gen", 0),
      cfgv: getInt("organize_cfgv", 0),
    };
    ctxAt = Date.now();
    return ctx;
  }
  const refreshReputation = () => (rep = new Reputation(store.senderStats(), context().myDomains));

  // ---------- Decisão ----------
  function decide(row, f, r, tokens, c) {
    if (row.manual) return { category: row.manual, confidence: 100, source: "manual", reason: `Você moveu para ${NAME[row.manual]}` };

    const rule = config.senderRule(f.fromAddr, c.senders);
    if (rule) {
      return { category: rule.category, confidence: 100, source: "remetente", reason: `Regra: sempre classificar ${rule.match} como ${NAME[rule.category]}` };
    }
    if (matchSender(c.senders.trusted, f.fromAddr)) {
      return { category: "importante", confidence: 95, source: "remetente", reason: "Remetente confiável (sua lista)" };
    }

    const byRule = () => ({ category: r.category, confidence: r.confidence, source: "regra", reason: r.reasons(r.category).slice(0, 3).join("; ") });
    const ruleOk = r.scores[r.category] >= 25 && r.confidence >= MIN_CONF[r.category];

    const rm = rep.manual(f.fromAddr);
    if (rm) return { ...rm, source: "reputacao" };

    if (ruleOk && r.confidence >= 90) return byRule();

    const rh = rep.history(f.fromAddr);
    // Histórico de propaganda não esconde uma mensagem com sinais fortes de ser pessoal
    if (rh && rh.confidence >= MIN_CONF[rh.category] && !(rh.category === "propaganda" && r.scores.importante >= 40)) {
      return { ...rh, source: "reputacao" };
    }

    if (ruleOk) return byRule();

    const p = model.predict(tokens);
    if (p) {
      let conf = Math.min(95, Math.round(p.p * 100));
      // Regras apontando para o mesmo lado reforçam o modelo
      if (p.best === r.category && r.scores[r.category] >= 25) conf = Math.min(97, Math.round(conf + ((100 - conf) * r.confidence) / 200));
      // O modelo sozinho nunca manda para Propaganda algo com relação pessoal (esconder Importante é o pior erro)
      const personal =
        f.answered || f.flagged || f.repliedThread || f.known || f.fromMe || f.sameDomain || r.scores.importante >= 45 || rep.engaged(f.fromAddr);
      if (!(p.best === "propaganda" && personal) && conf >= MODEL_MIN_CONF[p.best]) {
        return {
          category: p.best,
          confidence: conf,
          source: "modelo",
          reason: `Modelo: parecida com e-mails de ${NAME[p.best]}` + (p.top.length ? ` (${p.top.join(", ")})` : ""),
        };
      }
    }

    if (r.category !== "outros" && r.scores[r.category] >= 25) {
      return { category: "outros", confidence: 50, source: "padrao", reason: `Parece ${NAME[r.category]}, mas sem confiança suficiente (${r.confidence}%): na dúvida, Outros` };
    }
    if (r.category === "outros" && r.scores.outros >= 25) {
      return { category: "outros", confidence: r.confidence, source: "padrao", reason: r.reasons("outros").slice(0, 2).join("; ") };
    }
    return { category: "outros", confidence: 50, source: "padrao", reason: "Sem sinais claros: na dúvida, Outros" };
  }

  /** Rótulo de treino (fraco): suas ações, regras de alta confiança e sinais de uso. Nunca a decisão do próprio modelo. */
  function weakLabel(row, f, r, risky, c) {
    if (row.manual) return ["manual", row.manual, 3]; // mover entre grupos pesa mais
    if (risky) return null; // texto de golpe não ensina nada sobre Importante/Propaganda
    const rule = config.senderRule(f.fromAddr, c.senders);
    if (rule) return ["regra-remetente", rule.category, 2];
    if (matchSender(c.senders.trusted, f.fromAddr)) return ["confiavel", "importante", 2];
    if (f.answered || f.repliedThread || f.flagged) return ["uso", "importante", 1.5];
    if (r.scores[r.category] >= 25 && r.confidence >= 85) return ["regra", r.category, 1];
    if (!row.seen && (row.role === "archive" || row.role === "trash")) {
      return r.scores.propaganda >= 40 ? ["uso", "propaganda", 1] : ["uso", "outros", 0.5];
    }
    return null;
  }

  /** Treina ou destreina para que o modelo reflita exatamente o rótulo atual da mensagem. */
  function applyTraining(row, label, tokens) {
    const want = label ? { label: label[1], weight: label[2], tokens: tokens.join(" ") } : { label: null, weight: 0, tokens: null };
    if (row.train_label === want.label && row.train_weight === want.weight && (row.train_tokens || null) === want.tokens) return want;
    if (row.train_label) model.untrain((row.train_tokens || "").split(" ").filter(Boolean), row.train_label, row.train_weight);
    if (want.label) model.train(tokens, want.label, want.weight);
    return want;
  }

  // ---------- Varredura ----------
  function fingerprints(s, c) {
    return {
      fpc: [s.answered, s.flagged, s.rt, s.has_hdr, s.has_body, s.det_level || "", s.llm_category || "", (s.det_score || 0) >= 25 ? 1 : 0, c.cfgv].join("|"),
      fpt: [s.seen, s.role, c.organize.learning ? 1 : 0].join("|"),
    };
  }

  /** O que precisa ser (re)processado: classificação completa ou só o rótulo de treino. */
  function scanTodo(c, filter) {
    const todo = [];
    for (const s of store.organizeScan()) {
      if (filter && !filter(s)) continue;
      const { fpc, fpt } = fingerprints(s, c);
      let mode = null;
      if (!s.cid || s.version < c.version || s.fp_class !== fpc || (AUTO_SOURCES.has(s.source) && s.role === "inbox" && s.gen < c.gen)) mode = "full";
      else if (s.fp_train !== fpt) mode = "train";
      if (mode) todo.push({ id: s.id, mode, rt: s.rt, fpc, fpt, isNew: !s.cid });
    }
    return todo;
  }

  function processBatch(items, c) {
    if (!items.length) return 0;
    const rows = new Map(store.organizeLoad(items.map((i) => i.id)).map((r) => [r.id, r]));
    let changed = 0;
    tx(store.db, () => {
      for (const it of items) {
        const row = rows.get(it.id);
        if (!row) continue;
        const body = row.has_body
          ? { text: row.b_text, html: row.b_html, links: row.b_links, headers: row.b_headers, remote_images: row.b_remote }
          : null;
        const f = extract(row, body, { ...c, repliedThread: !!it.rt });
        const r = scoreRules(f);
        const tokens = tokensOf(f);
        const risky = isRisky(row, c.security, c.senders);
        const train = c.organize.learning
          ? applyTraining(row, weakLabel(row, f, r, risky, c), tokens)
          : { label: row.train_label, weight: row.train_weight || 0, tokens: row.train_tokens };

        if (it.mode === "full") {
          const d = decide(row, f, r, tokens, c);
          const grp = row.manual ? row.manual : !c.security.shadow && risky ? "suspeito" : d.category;
          if (row.old_grp !== grp || row.old_category !== d.category) changed++;
          if (grp === "suspeito") {
            const why = matchSender(c.senders.blocked, f.fromAddr)
              ? "remetente bloqueado"
              : row.llm_category === "suspeito"
              ? "apontada pelo agente LLM"
              : `nível ${row.det_level}`;
            d.reason = `Análise de segurança: ${why} · categoria ${NAME[d.category]} (${d.reason})`;
          }
          store.saveClass({
            account_id: row.account_id,
            msg_key: row.msg_key,
            category: d.category,
            grp,
            confidence: d.confidence,
            source: d.source,
            reason: String(d.reason || "").slice(0, 200),
            manual: row.manual || null,
            version: c.version,
            gen: c.gen,
            fp_class: it.fpc,
            fp_train: it.fpt,
            train,
          });
        } else {
          store.saveTrain(row.cid, it.fpt, train);
        }
      }
    });
    model.flush();
    return changed;
  }

  // ---------- Processo em segundo plano ----------
  function kick(delay = 1500) {
    clearTimeout(timer);
    timer = setTimeout(() => run().catch((err) => log("organização:", err.message)), delay);
  }

  function emitProgress(force) {
    if (!force && Date.now() - lastEmit < 700) return;
    lastEmit = Date.now();
    emit("organize-progress", { ...progress });
  }

  async function run() {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        const c = context(true);
        refreshReputation();
        const todo = scanTodo(c);
        Object.assign(progress, { running: true, phase: todo.some((t) => t.isNew) ? "classificando" : "reclassificando", done: 0, total: todo.length });
        if (todo.length) emitProgress(true);
        let changed = 0;
        for (let i = 0; i < todo.length; i += BATCH) {
          changed += processBatch(todo.slice(i, i + BATCH), c);
          progress.done = Math.min(todo.length, i + BATCH);
          emitProgress();
          // A interface atualiza enquanto o processo anda (as mais recentes vêm primeiro)
          if (changed && (i / BATCH) % 5 === 4) emit("organize-changed", {});
          if (i && (i / BATCH) % 5 === 0) refreshReputation();
          await sleep(15); // devolve a vez para o RPC da interface e para a sincronização
        }
        if (todo.length) {
          refreshReputation();
          // Modelo ou reputação mudaram o bastante: nova geração e as decisões automáticas são refeitas
          const lastDocs = getInt("organize_gen_docs", 0);
          const shortcuts = rep.shortcuts();
          const grewModel = model.totalDocs - lastDocs >= Math.max(10, lastDocs * 0.1);
          if (grewModel || shortcuts !== getInt("organize_gen_shortcuts", 0)) {
            tx(store.db, () => {
              bump("organize_gen");
              store.setSetting("organize_gen_docs", String(model.totalDocs));
              store.setSetting("organize_gen_shortcuts", String(shortcuts));
            });
            again = true;
          }
          if (changed || !again) emit("organize-changed", {});
        }
        if (!again && (await backfillHeaders())) again = true;
      } while (again);
    } finally {
      running = false;
      Object.assign(progress, { running: false, phase: "idle", finishedAt: Date.now() });
      emitProgress(true);
    }
  }

  /**
   * Mensagens novas que acabaram de chegar: classifica na hora, dentro da sincronização, para que já
   * apareçam no grupo certo (sem passar por "Outros" e pular depois).
   */
  function classifyNew() {
    try {
      const c = context();
      const todo = scanTodo(c).filter((t) => t.isNew).slice(0, 300);
      if (processBatch(todo, c)) emit("organize-changed", {});
    } catch (err) {
      log("organização (novas):", err.message);
    }
    kick();
  }

  /**
   * Cabeçalhos de envio em massa das mensagens que já estavam no cache antes desta versão:
   * busca só esses campos no servidor (poucos bytes), em lotes, com a conta ociosa.
   */
  async function backfillHeaders() {
    let did = false;
    for (const w of listWorkers()) {
      if (w.stopped || w.status !== "idle" || w.pending || w.running || !w.client || !w.client.usable) continue;
      const inbox = w.folders().find((f) => f.role === "inbox");
      if (!inbox) continue;
      const uids = store.missingHdr(inbox.id, 200);
      if (!uids.length) continue;
      const got = new Map();
      try {
        await w.withMailbox(inbox.path, async (client) => {
          for await (const msg of client.fetch(uids.join(","), { uid: true, headers: HDR_FIELDS }, { uid: true })) {
            got.set(msg.uid, parseHdr(msg.headers));
          }
        });
      } catch (err) {
        if (err.code !== "OFFLINE") log(`organização: cabeçalhos da conta ${w.account.id}: ${err.code || err.message}`);
        continue;
      }
      // UID que não voltou não existe mais no servidor: marca como vazio para não pedir de novo
      store.setHdr(inbox.id, uids.map((u) => [u, got.get(u) || "{}"]));
      did = true;
    }
    return did;
  }

  // ---------- Ajustes manuais ----------
  /** Processa já (sem esperar o processo) as mensagens que casam com o filtro. */
  function processNow(filter) {
    const c = context(true);
    refreshReputation();
    const todo = scanTodo(c, filter);
    for (let i = 0; i < todo.length; i += BATCH) processBatch(todo.slice(i, i + BATCH), c);
  }

  /** Arrastar / "Mover para": grava a sua escolha (category = null desfaz e volta ao automático). */
  function setCategory(ids, category, threads) {
    if (category != null && !["importante", "propaganda", "outros"].includes(category)) throw new Error("Grupo inválido.");
    const keys = store.classKeysFor(ids, threads);
    if (!keys.length) return { changed: 0 };
    store.setManual(keys, category || null);
    const senders = new Set(keys.map((k) => k.from_addr).filter(Boolean));
    // A correção vale para a mensagem e ensina a reputação do remetente: as outras dele são refeitas
    store.invalidateSenders([...senders]);
    processNow((s) => senders.has(s.from_addr));
    kick();
    return { changed: keys.length };
  }

  /** "Sempre classificar este remetente como". */
  function setSenderRule(match, category) {
    const senders = config.setSenderRule(match, category || null);
    ctxAt = 0;
    const m = String(match).trim().toLowerCase();
    store.invalidateSenders([m]);
    processNow((s) => matchSender([m], s.from_addr));
    kick();
    return senders;
  }

  /** Configuração mudou de um jeito que afeta todos: refaz tudo em segundo plano. */
  function configChanged() {
    bump("organize_cfgv");
    ctxAt = 0;
    kick(300);
  }

  return {
    config,
    kick,
    /** Roda o processo até não sobrar nada (usado pelos testes). */
    runNow: () => run(),
    classifyNew,
    setCategory,
    setSenderRule,
    configChanged,
    reclassifyAll() {
      bump("organize_version");
      ctxAt = 0;
      kick(100);
    },
    resetLearning() {
      model.reset();
      tx(store.db, () => {
        store.resetLearning();
        for (const k of ["organize_gen", "organize_gen_docs", "organize_gen_shortcuts"]) store.setSetting(k, null);
        bump("organize_version");
      });
      ctxAt = 0;
      refreshReputation();
      kick(100);
    },
    status() {
      context();
      return {
        progress: { ...progress },
        model: model.stats(),
        stats: store.classStats(),
        shortcuts: rep.shortcuts(),
        learning: config.getOrganize().learning,
      };
    },
  };
}

module.exports = { createOrganizer };
