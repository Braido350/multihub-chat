// Fila de triagem: analisa em segundo plano cada mensagem da Caixa de entrada e do Spam.
// Fase 6a: só sinais determinísticos + reputação local (modo sombra: rotula, não move nada).
// Cada mensagem é analisada uma vez (chave = Message-ID); mover entre pastas não reprocessa.
const { analyze, linkSignals, score, sig, VERSION, ARCHIVE } = require("./signals");
const { expand } = require("./expand");
const { inspectZip } = require("./zip");
const av = require("./clamav");
const { readStream } = require("../body");
const sanitizeHtml = require("sanitize-html");
const { merge, PROMPT_VERSION } = require("./llm/prompt");

const LLM_BACKLOG_DAYS = 3; // o agente LLM só olha mensagens recentes (custo)

const BACKLOG_DAYS = 14; // mensagens antigas além disso não são analisadas
const AV_DAYS = 3; // antivírus (pesado) só nas mensagens dos últimos dias
const AV_MAX_FILE = 15 * 1024 * 1024;
const MAX_SHORT_LINKS = 3;
const BATCH = 10;

// Tipos que valem examinar com o antivírus (imagens comuns ficam de fora)
const AV_WORTHY = /\.(zip|rar|7z|gz|tar|cab|iso|img|exe|scr|msi|dll|js|vbs|jar|apk|bat|cmd|ps1|hta|lnk|docm?|xlsm?|xlsb|pptm?|rtf|pdf|html?|svg|one|xls|ppt)$/i;
const RISKY_INSIDE = /\.(exe|scr|com|pif|bat|cmd|js|jse|vbs|vbe|wsf|hta|lnk|msi|ps1|jar|iso|img|vhd|html?|svg|docm|xlsm|pptm)$/i;

function createTriage(ctx) {
  const { store, workerFor, loadBody, emit, emitCounts, log, llm } = ctx;
  let timer = null;
  let running = false;
  let wakeTimer = null;
  // det-1 marcava "Respostas vão para um e-mail gratuito" mesmo quando o endereço era seu: refaz essas análises
  try {
    store.db.exec("DELETE FROM triage WHERE pipeline_version = 'det-1' AND signals LIKE '%REPLYTO_FREEMAIL%'");
    // det-3: domínios oficiais da Microsoft (ex.: microsoftrewards.com) eram apontados como "não oficiais"
    store.db.exec("DELETE FROM triage WHERE pipeline_version IN ('det-1', 'det-2') AND signals LIKE '%Microsoft%'");
  } catch {}

  function kick(delay = 2000) {
    clearTimeout(timer);
    timer = setTimeout(run, delay);
  }

  async function run() {
    if (running) return;
    running = true;
    try {
      for (;;) {
        const batch = store.triagePending(Date.now() - BACKLOG_DAYS * 864e5, BATCH);
        if (!batch.length) break;
        let progressed = 0;
        for (const row of batch) {
          try {
            await triageOne(row);
            progressed++;
          } catch (err) {
            if (err.code === "OFFLINE") continue; // tenta de novo quando a conta reconectar
            store.saveTriage({ accountId: row.account_id, key: row.msg_key, status: "error", error: String(err.message).slice(0, 300), pipeline: VERSION });
            progressed++;
            log(`triagem: mensagem ${row.id}: ${err.code || err.message}`);
          }
          emit("triage-changed", { accountId: row.account_id });
          await new Promise((r) => setTimeout(r, 50)); // não monopoliza a conexão IMAP
        }
        if (!progressed) break; // todas offline: espera a próxima sincronização
      }
      await runLlm();
    } finally {
      running = false;
    }
  }

  /** Volta sozinho quando um limite de uso expirar (no máximo em 1 h). */
  function wakeIn(ms) {
    clearTimeout(wakeTimer);
    wakeTimer = setTimeout(() => kick(100), Math.min(Math.max(ms, 5000), 60 * 60_000));
  }

  // ---------- Etapa 2: agente LLM ----------
  async function runLlm() {
    const provider = await llm.provider().catch(() => null);
    if (!provider) return;
    for (;;) {
      // Gratuitos: só não lidas que chegaram depois que a chave foi colocada
      const free = await llm.freeSince();
      const since = Math.max(Date.now() - LLM_BACKLOG_DAYS * 864e5, free || 0);
      const rows = store.triageLlmPending({ since, requireFree: provider.restricted, limit: 5 });
      if (!rows.length) return;
      for (const row of rows) {
        const det = { level: row.det_level, score: row.det_score, signals: JSON.parse(row.signals || "[]") };
        const from = { name: row.from_name, address: row.from_addr };

        // Listas do usuário decidem sem gastar nada
        const listed = llm.fromLists(from, det);
        if (listed) {
          store.saveTriageLlm(row.triage_id, { ...listed, confidence: 100, promptVersion: "lista" });
          emit("triage-changed", { accountId: row.account_id });
          emitCounts();
          continue;
        }

        let r;
        try {
          const body = store.getBody(row.id) || (await loadBody(row.id));
          const text = body.text || sanitizeHtml(body.html || "", { allowedTags: [], nonTextTags: ["style", "script", "title"] });
          r = await llm.classify(
            { from, subject: row.subject, text, links: JSON.parse(body.links || "[]"), attachments: JSON.parse(body.attachments || "[]") },
            det,
            { triage_allow_free: row.triage_allow_free }
          );
        } catch (err) {
          const kind = err.kind || (err.code === "OFFLINE" ? "network" : "other");
          if (kind === "auth") return log(`triagem LLM: ${err.message}`); // configuração errada: para até o usuário corrigir
          if (kind === "rate" || kind === "network") {
            store.triageLlmFail(row.triage_id, { retryAt: Date.now() + (err.retryAfterMs || 60_000), countAttempt: false, error: err.message });
            wakeIn(err.retryAfterMs || 60_000);
            return; // limite é do provedor inteiro: não adianta tentar as próximas agora
          }
          store.triageLlmFail(row.triage_id, { retryAt: Date.now() + 5 * 60_000, countAttempt: true, error: err.message });
          if (row.llm_attempts + 1 >= 3) {
            // Desiste: fica com o veredito das regras ("verificar" se não havia risco)
            const danger = det.level === "suspeito" || det.level === "perigoso";
            store.saveTriageLlm(row.triage_id, {
              category: danger ? "suspeito" : "incerto",
              risk: det.score,
              action: danger ? "quarentena" : "verificar",
              reasons: [`O agente não conseguiu analisar: ${err.message}`.slice(0, 160)],
              model: null,
              promptVersion: PROMPT_VERSION,
            });
          }
          emit("triage-changed", { accountId: row.account_id });
          continue;
        }
        if (!r) return; // agente desligado (ou conta não liberou modelos gratuitos)

        const m = merge(det, r.result);
        store.saveTriageLlm(row.triage_id, {
          category: m.category,
          risk: m.risk,
          priority: m.priority,
          confidence: r.result.confidence,
          action: m.action,
          // Se a regra de ouro corrigiu o modelo, o resumo dele (ex.: "aviso do banco") enganaria: fica de fora
          summary: m.notes.length && r.result.category !== m.category ? null : r.result.summary,
          reasons: [...m.notes, ...r.result.reasons].slice(0, 5),
          deadlines: r.result.deadlines,
          // Auditoria: o que o modelo respondeu (sem o corpo do e-mail), qual modelo, se escalou, se foi restrito, custo
          llm: { ...r.result, model: r.model, firstModel: r.firstModel || null, escalated: !!r.escalated, restricted: !!r.restricted, cost: r.cost || 0, note: r.note || null },
          model: r.model,
          promptVersion: PROMPT_VERSION,
        });
        emit("triage-changed", { accountId: row.account_id });
        emitCounts();
      }
    }
  }

  async function triageOne(row) {
    // Corpo em cache de antes da fase 6 não tem cabeçalhos/links: baixa de novo
    let body = store.getBody(row.id);
    if (body && body.headers == null) {
      store.deleteBody(row.id);
      body = null;
    }
    if (!body) body = await loadBody(row.id);

    const headers = JSON.parse(body.headers || "{}");
    const links = JSON.parse(body.links || "[]");
    const attachments = JSON.parse(body.attachments || "[]");
    const myAddresses = store.listAccounts().map((a) => String(a.email || "").toLowerCase());
    const result = analyze({ from: { name: row.from_name, address: row.from_addr }, headers, links, attachments, myAddresses });
    const signals = result.signals;

    // Camada 2a: links encurtados -> destino real (só redirecionamentos, sem abrir a página)
    for (const href of result.shorteners.slice(0, MAX_SHORT_LINKS)) {
      const r = await expand(href);
      if (r.error) {
        signals.push(sig("LINK_SHORT_UNRESOLVED", 5, "low", `Não foi possível ver o destino de ${href.slice(0, 80)} (${r.error})`));
      } else if (r.final !== href) {
        signals.push(sig("LINK_SHORT_EXPANDED", 0, "info", `${new URL(href).hostname} leva para ${new URL(r.final).hostname}`, { url: href, final: r.final }));
        const again = linkSignals([{ href: r.final, text: "" }], result.fromReg).signals.filter((s) => s.id !== "LINK_SHORTENER");
        for (const s of again) signals.push({ ...s, id: s.id + "_VIA_SHORTENER", detail: s.detail + " (por trás de um link encurtado)" });
      }
    }

    // Camada 2b: anexos -> zip com senha / executável dentro + antivírus local
    let avStatus = "skipped";
    const candidates = attachments.filter((a) => !a.inline && AV_WORTHY.test(a.filename || "") && (a.size || 0) <= AV_MAX_FILE);
    const recent = row.date > Date.now() - AV_DAYS * 864e5;
    if (candidates.length && recent) {
      const files = await download(row, candidates);
      for (const f of files) {
        if (!ARCHIVE.test(f.name) || !/\.zip$/i.test(f.name)) continue;
        const z = inspectZip(f.content);
        if (z.encrypted) signals.push(sig("ATT_ENCRYPTED_ARCHIVE", 40, "high", `Zip protegido por senha (o antivírus não consegue ver dentro): "${f.name}"`));
        const bad = z.entries.filter((e) => RISKY_INSIDE.test(e));
        if (bad.length) signals.push(sig("ATT_ARCHIVE_RISKY", 45, "critical", `"${f.name}" contém arquivo de risco: ${bad.slice(0, 3).join(", ")}`));
      }
      const scan = await av.scan(files);
      avStatus = scan.status;
      for (const hit of scan.found) {
        signals.push(sig("AV_INFECTED", 100, "critical", `Antivírus (ClamAV) detectou ${hit.signature} em "${hit.name}"`));
      }
      if (scan.status === "error") signals.push(sig("AV_ERROR", 0, "info", "O antivírus falhou ao examinar os anexos"));
    }

    const final = score(signals);
    store.saveTriage({
      accountId: row.account_id,
      key: row.msg_key,
      status: "done",
      detScore: final.score,
      detLevel: final.level,
      signals: final.signals,
      avStatus,
      pipeline: VERSION,
    });
  }

  async function download(row, list) {
    const w = workerFor(row.account_id);
    const out = [];
    await w.withMailbox(row.folder_path, async (c) => {
      for (const a of list) {
        const dl = await c.download(String(row.uid), a.part, { uid: true, maxBytes: AV_MAX_FILE });
        if (dl && dl.content) out.push({ name: a.filename, content: await readStream(dl.content, AV_MAX_FILE) });
      }
    });
    return out;
  }

  return {
    kick,
    /** Refaz a análise de uma mensagem (ex.: depois de mudar as regras). */
    async retriage(id) {
      const [m] = store.messagesByIds([Number(id)]);
      if (!m) return;
      store.deleteTriage(m.account_id, m.message_id || `u:${m.folder_id}:${m.uid}`);
      kick(100);
    },
    async status() {
      const engine = await av.detect();
      return { antivirus: engine.mode, version: VERSION, llm: await llm.status() };
    },
  };
}

module.exports = { createTriage };
