// Escrever, responder, encaminhar, rascunhos e envio.
// Cada janela de composição é uma "sessão" no serviço, que guarda os anexos (bytes) para não
// trafegarem de novo a cada salvamento de rascunho.
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const MailComposer = require("nodemailer/lib/mail-composer");
const addressparser = require("nodemailer/lib/addressparser");
const sanitizeHtml = require("sanitize-html");
const { readStream } = require("./body");

const UNDO_MS = 5000; // tempo para "Desfazer" antes de enviar de verdade
const MAX_ATTACHMENTS = 25 * 1024 * 1024; // limite do Gmail; a maioria dos servidores aceita até isso
const SESSION_TTL = 24 * 60 * 60 * 1000;

const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const isEmail = (v) => /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/.test(v);

// ---------- HTML ----------
const TAGS = [
  "a", "b", "blockquote", "br", "center", "code", "div", "em", "font", "h1", "h2", "h3", "h4", "hr", "i", "img", "li",
  "ol", "p", "pre", "s", "small", "span", "strike", "strong", "sub", "sup", "table", "tbody", "td", "tfoot", "th",
  "thead", "tr", "u", "ul",
];
const ATTRS = ["style", "align", "valign", "width", "height", "bgcolor", "border", "dir", "cellpadding", "cellspacing", "colspan", "rowspan", "color", "face", "size"];

/** Citação dentro do editor: sem <style> e sem classes (afetariam a própria tela do app). */
function forEditor(html) {
  return sanitizeHtml(String(html || ""), {
    allowedTags: TAGS,
    allowedAttributes: { "*": ATTRS, a: ["href", "target", "rel"], img: ["src", "alt", "data-remote-src"] },
    allowedSchemes: ["http", "https", "mailto", "tel"],
    allowedSchemesByTag: { img: ["data"] },
    nonTextTags: ["style", "script", "title", "noscript", "textarea", "option", "xml"],
    parseStyleAttributes: false,
  });
}

/** HTML que sai: imagens remotas da citação voltam a apontar para a origem. */
function outgoing(html) {
  return sanitizeHtml(String(html || ""), {
    allowedTags: TAGS,
    allowedAttributes: { "*": ATTRS, a: ["href", "target", "rel"], img: ["src", "alt", "width", "height"] },
    allowedSchemes: ["http", "https", "mailto", "tel"],
    allowedSchemesByTag: { img: ["data", "cid", "http", "https"] },
    nonTextTags: ["style", "script", "title", "noscript", "textarea", "option", "xml"],
    parseStyleAttributes: false,
    transformTags: {
      img: (tagName, attribs) => {
        const out = { ...attribs };
        if (!out.src && out["data-remote-src"]) out.src = out["data-remote-src"];
        delete out["data-remote-src"];
        return { tagName, attribs: out };
      },
    },
  });
}

const fmtDate = new Intl.DateTimeFormat("pt-BR", { dateStyle: "full", timeStyle: "short" });
const who = (name, addr) => (name ? `${name} <${addr}>` : addr);
const people = (list) => (list || []).map((a) => who(a.name, a.address)).join(", ");

function prefixed(subject, prefix) {
  const s = String(subject || "").trim();
  const re = prefix === "Re" ? /^(re|res|resp|aw)\s*:/i : /^(fwd?|enc|encaminhad[ao])\s*:/i;
  return re.test(s) ? s : `${prefix}: ${s}`;
}

/** Endereços digitados ("Ana <ana@x.com>, b@y.com") -> [{name, address}], validando. */
function parseRecipients(list, label, lenient = false) {
  const raw = Array.isArray(list) ? list.join(", ") : String(list || "");
  const out = [];
  for (const a of addressparser(raw, { flatten: true })) {
    const address = String(a.address || "").trim();
    if (!address) continue;
    if (!isEmail(address)) {
      if (lenient) continue; // rascunho: endereço ainda sendo digitado
      throw new Error(`Endereço inválido em ${label}: ${address}`);
    }
    out.push({ name: String(a.name || "").trim(), address });
  }
  return out;
}

function createCompose(ctx) {
  const { store, workerFor, loadBody, getSmtpAuth, emit, log, setFlag, describeError } = ctx;
  const sessions = new Map();

  function session(id) {
    const s = sessions.get(String(id));
    if (!s) throw new Error("Esta mensagem não está mais aberta. Feche e escreva de novo.");
    s.touched = Date.now();
    return s;
  }

  function newSession() {
    const s = {
      id: crypto.randomUUID(),
      attachments: new Map(),
      draft: null, // { accountId, folderId, uid }
      replyToRowId: null,
      inReplyTo: null,
      references: [],
      timer: null,
      saving: Promise.resolve(),
      touched: Date.now(),
    };
    sessions.set(s.id, s);
    // Sessões esquecidas (janela fechada sem descartar) não ficam para sempre na memória
    for (const [k, v] of sessions) if (Date.now() - v.touched > SESSION_TTL && !v.timer) sessions.delete(k);
    return s;
  }

  const attachmentList = (s) =>
    [...s.attachments.values()].map((a) => ({ id: a.id, filename: a.filename, contentType: a.contentType, size: a.content.length }));
  const totalSize = (s) => [...s.attachments.values()].reduce((n, a) => n + a.content.length, 0);

  function addAttachment(s, { filename, contentType, content }) {
    if (totalSize(s) + content.length > MAX_ATTACHMENTS) {
      throw new Error(`"${filename}" passa do limite de 25 MB de anexos por mensagem.`);
    }
    const a = {
      id: crypto.randomUUID(),
      filename: String(filename || "anexo").replace(/[\\/\x00-\x1f]/g, "_").slice(0, 200),
      contentType: String(contentType || "application/octet-stream"),
      content,
    };
    s.attachments.set(a.id, a);
    return a;
  }

  /** Copia os anexos de uma mensagem do servidor para a sessão (encaminhar / abrir rascunho). */
  async function copyAttachments(s, row) {
    const body = await loadBody(row.id);
    const list = JSON.parse(body.attachments || "[]").filter((a) => !a.inline);
    const skipped = [];
    if (!list.length) return skipped;
    const w = workerFor(row.account_id);
    await w.withMailbox(row.folder_path, async (c) => {
      for (const a of list) {
        if (totalSize(s) + (a.size || 0) > MAX_ATTACHMENTS) {
          skipped.push(a.filename);
          continue;
        }
        const dl = await c.download(String(row.uid), a.part, { uid: true, maxBytes: MAX_ATTACHMENTS });
        if (!dl || !dl.content) continue;
        const content = await readStream(dl.content, MAX_ATTACHMENTS + 1);
        try {
          addAttachment(s, { filename: a.filename, contentType: a.contentType, content });
        } catch {
          skipped.push(a.filename);
        }
      }
    });
    return skipped;
  }

  const ownAddresses = () => new Set(store.listAccounts().map((a) => a.email.toLowerCase()));

  // ---------- Abrir ----------
  async function start({ mode = "new", messageId, accountId, draft }) {
    const s = newSession();
    const accounts = store.listAccounts();
    if (!accounts.length) throw new Error("Adicione uma conta de e-mail primeiro.");
    const out = {
      composeId: s.id,
      mode,
      accountId: accounts.some((a) => a.id === Number(accountId)) ? Number(accountId) : accounts[0].id,
      to: [],
      cc: [],
      bcc: [],
      subject: "",
      html: "",
      quote: "",
      attachments: [],
      skipped: [],
    };
    if (mode === "new") {
      // Retomando um rascunho já salvo (aba recarregada): os próximos salvamentos o substituem
      const f = draft && store.getFolder(Number(draft.folderId));
      if (f && f.account_id === Number(draft.accountId) && f.role === "drafts") {
        s.draft = { accountId: f.account_id, folderId: f.id, uid: Number(draft.uid) };
      }
      return out;
    }

    const [row] = store.messagesByIds([Number(messageId)]);
    if (!row) throw new Error("Mensagem não encontrada.");
    out.accountId = row.account_id; // responde pela conta que recebeu
    const body = await loadBody(row.id);
    const from = { name: row.from_name, address: row.from_addr };
    const to = JSON.parse(row.to_json || "[]");
    const cc = JSON.parse(row.cc_json || "[]");
    const replyTo = JSON.parse(row.reply_to_json || "[]");

    if (mode === "draft") {
      out.to = to;
      out.cc = cc;
      out.subject = row.subject;
      out.html = forEditor(body.html);
      s.inReplyTo = row.in_reply_to || null;
      s.references = row.refs ? row.refs.split(/\s+/) : [];
      s.draft = { accountId: row.account_id, folderId: row.folder_id, uid: row.uid };
      out.skipped = await copyAttachments(s, row);
    } else if (mode === "forward") {
      out.subject = prefixed(row.subject, "Fwd");
      out.quote =
        `<div>---------- Mensagem encaminhada ----------<br>` +
        `De: ${escapeHtml(who(from.name, from.address))}<br>` +
        `Data: ${escapeHtml(fmtDate.format(new Date(row.date)))}<br>` +
        `Assunto: ${escapeHtml(row.subject)}<br>` +
        `Para: ${escapeHtml(people(to))}<br>` +
        (cc.length ? `Cc: ${escapeHtml(people(cc))}<br>` : "") +
        `</div><br>${forEditor(body.html)}`;
      out.skipped = await copyAttachments(s, row);
    } else {
      // Responder / responder a todos
      const mine = ownAddresses();
      const account = store.getAccount(row.account_id);
      const sentByMe = mine.has(from.address.toLowerCase());
      // Resposta a uma mensagem que eu mesmo enviei vai para os destinatários dela
      const primary = sentByMe ? to : replyTo.length ? replyTo : [from];
      out.to = primary;
      if (mode === "replyAll") {
        const seen = new Set(primary.map((a) => a.address.toLowerCase()));
        const keep = (a) => {
          const k = a.address.toLowerCase();
          if (seen.has(k) || mine.has(k) || k === account.email.toLowerCase()) return false;
          seen.add(k);
          return true;
        };
        out.to = primary.concat(sentByMe ? [] : to.filter(keep));
        out.cc = cc.filter(keep);
      }
      out.subject = prefixed(row.subject, "Re");
      out.quote =
        `<div>Em ${escapeHtml(fmtDate.format(new Date(row.date)))}, ${escapeHtml(who(from.name, from.address))} escreveu:</div>` +
        `<blockquote style="margin:0 0 0 .8ex;border-left:2px solid #ccc;padding-left:1ex">${forEditor(body.html)}</blockquote>`;
      s.replyToRowId = row.id;
      s.inReplyTo = row.message_id || null;
      s.references = [...(row.refs ? row.refs.split(/\s+/) : []), row.message_id].filter(Boolean).slice(-20);
    }
    out.attachments = attachmentList(s);
    return out;
  }

  // ---------- Montar a mensagem ----------
  function build(s, p, { keepBcc = false, messageId, date, lenient = false } = {}) {
    const a = store.getAccount(Number(p.accountId));
    if (!a) throw new Error("Conta remetente não encontrada.");
    const to = parseRecipients(p.to, "Para", lenient);
    const cc = parseRecipients(p.cc, "Cc", lenient);
    const bcc = parseRecipients(p.bcc, "Cco", lenient);
    const domain = a.email.split("@")[1] || "localhost";
    const opts = {
      from: a.sender_name ? { name: a.sender_name, address: a.email } : a.email,
      to,
      cc,
      bcc,
      subject: String(p.subject || ""),
      html: outgoing(p.html),
      text: String(p.text || ""),
      messageId: messageId || `<${crypto.randomUUID()}@${domain}>`,
      date: date || new Date(),
      inReplyTo: s.inReplyTo || undefined,
      references: s.references.length ? s.references : undefined,
      attachments: [...s.attachments.values()].map((x) => ({ filename: x.filename, contentType: x.contentType, content: x.content })),
      headers: { "X-Mailer": "MultiHub Chat" },
    };
    const node = new MailComposer(opts).compile();
    node.keepBcc = keepBcc;
    return { account: a, to, cc, bcc, opts, raw: node.build() };
  }

  // ---------- Rascunhos ----------
  async function appendDraft(s, p) {
    const { account, raw, opts } = build(s, p, { keepBcc: true, lenient: true });
    const w = workerFor(account.id);
    const drafts = await w.folderForRole("drafts");
    if (!drafts) throw new Error("Esta conta não tem pasta de Rascunhos.");
    const buf = await raw;
    const res = await w.withMailbox(drafts.path, async (c) => {
      const r = await c.append(drafts.path, buf, ["\\Draft", "\\Seen"]);
      if (r && r.uid) return r.uid;
      // Servidor sem UIDPLUS: procura pelo Message-ID
      const found = await c.search({ header: { "message-id": opts.messageId } }, { uid: true });
      return Array.isArray(found) && found.length ? found[found.length - 1] : null;
    });
    const old = s.draft;
    s.draft = res ? { accountId: account.id, folderId: drafts.id, uid: res } : null;
    if (old && !(old.accountId === account.id && old.uid === res)) await deleteDraft(old).catch((e) => log("rascunho antigo: " + e.message));
    w.requestSync(drafts.id);
    emit("messages-changed", { accountId: account.id });
  }

  async function deleteDraft(d) {
    const folder = store.getFolder(d.folderId);
    if (!folder) return;
    const w = workerFor(d.accountId);
    await w.withMailbox(folder.path, (c) => c.messageDelete(String(d.uid), { uid: true }));
    store.deleteMessages(folder.id, [d.uid]);
    w.requestSync(folder.id);
    emit("messages-changed", { accountId: d.accountId });
  }

  // ---------- Enviar ----------
  async function deliver(s, p) {
    const date = new Date();
    const first = build(s, p, { date });
    const { account, to, cc, bcc, opts } = first;
    const raw = await first.raw;
    const rcpts = [...to, ...cc, ...bcc].map((x) => x.address);

    const transport = nodemailer.createTransport({
      host: account.smtp_host,
      port: account.smtp_port,
      secure: !!account.smtp_secure,
      requireTLS: !account.smtp_secure,
      auth: await getSmtpAuth(account),
      connectionTimeout: 30e3,
      greetingTimeout: 20e3,
      socketTimeout: 120e3,
      logger: false,
    });
    try {
      await transport.sendMail({ envelope: { from: account.email, to: rcpts }, raw });
    } catch (err) {
      const msg =
        err.code === "EAUTH"
          ? "O servidor de envio recusou o login."
          : err.responseCode === 552 || /size|too large/i.test(err.response || "")
          ? "O servidor recusou: mensagem grande demais."
          : err.response
          ? `O servidor recusou o envio: ${String(err.response).slice(0, 200)}`
          : describeError(err, { ...account, imap_host: account.smtp_host, imap_port: account.smtp_port });
      throw new Error(msg);
    } finally {
      transport.close();
    }

    const w = workerFor(account.id);
    // Cópia em Enviados (o Gmail já guarda sozinho tudo o que passa pelo SMTP dele)
    try {
      const sent = await w.folderForRole("sent");
      if (sent) {
        if (account.provider !== "gmail") {
          const copy = await build(s, p, { keepBcc: true, messageId: opts.messageId, date }).raw;
          await w.withMailbox(sent.path, (c) => c.append(sent.path, copy, ["\\Seen"]));
        }
        w.requestSync(sent.id);
      }
    } catch (err) {
      log("cópia em Enviados falhou: " + (err.code || err.message));
    }
    if (s.replyToRowId) await setFlag([s.replyToRowId], "\\Answered", true).catch(() => {});
    if (s.draft) await deleteDraft(s.draft).catch((e) => log("apagar rascunho: " + e.message));
  }

  return {
    start,

    async addAttachment({ composeId, filename, contentType, data }) {
      const s = session(composeId);
      const content = Buffer.from(data instanceof Uint8Array ? data : new Uint8Array(data || []));
      const a = addAttachment(s, { filename, contentType, content });
      return { id: a.id, filename: a.filename, contentType: a.contentType, size: a.content.length };
    },

    async removeAttachment({ composeId, id }) {
      session(composeId).attachments.delete(String(id));
      return { ok: true };
    },

    async saveDraft(p) {
      const s = session(p.composeId);
      // Um salvamento por vez (o seguinte substitui o anterior no servidor)
      const job = s.saving.then(() => appendDraft(s, p));
      s.saving = job.catch(() => {});
      await job;
      return { savedAt: Date.now(), draft: s.draft };
    },

    async send(p) {
      const s = session(p.composeId);
      const { to, cc, bcc } = build(s, p); // valida antes de agendar
      if (!to.length && !cc.length && !bcc.length) throw new Error("Informe pelo menos um destinatário.");
      clearTimeout(s.timer);
      s.timer = setTimeout(async () => {
        s.timer = null;
        try {
          await s.saving; // espera um salvamento de rascunho em andamento
          await deliver(s, p);
          sessions.delete(s.id);
          emit("compose-sent", { composeId: s.id, accountId: Number(p.accountId) });
        } catch (err) {
          log("envio falhou: " + (err.code || err.message));
          emit("compose-failed", { composeId: s.id, error: err.message });
        }
      }, UNDO_MS);
      return { scheduled: true, undoMs: UNDO_MS };
    },

    async cancelSend({ composeId }) {
      const s = sessions.get(String(composeId));
      if (!s || !s.timer) return { cancelled: false };
      clearTimeout(s.timer);
      s.timer = null;
      return { cancelled: true };
    },

    async discard({ composeId }) {
      const s = sessions.get(String(composeId));
      if (!s) return { ok: true };
      clearTimeout(s.timer);
      sessions.delete(s.id);
      await s.saving;
      if (s.draft) await deleteDraft(s.draft);
      return { ok: true };
    },

    contacts({ q }) {
      return store.contacts(q);
    },
  };
}

module.exports = { createCompose, outgoing, forEditor, parseRecipients };
