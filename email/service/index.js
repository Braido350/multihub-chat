// Serviço de e-mail. Roda em um utilityProcess do Electron (Node puro, fora do processo
// principal), para que IMAP, SQLite e sincronização nunca travem a janela.
//
// Canais:
//  - process.parentPort  <-> processo principal (init, criptografia, abrir navegador, contadores)
//  - MessagePort         <-> interface da aba de E-mail (RPC + eventos)
process.removeAllListeners("warning"); // aviso "SQLite is experimental" do Node
process.on("warning", (w) => {
  if (w.name !== "ExperimentalWarning") console.warn(w.message);
});

// "Happy eyeballs" do Node: com vários IPs (Gmail tem 2 IPv4 + 2 IPv6), cada endereço ganha só 250 ms.
// Em redes sem IPv6 ou com latência maior, todos estouram e o login falha com ETIMEDOUT em ~0,5 s.
// 2 s por endereço mantém o fallback IPv6→IPv4 e tolera redes lentas.
require("net").setDefaultAutoSelectFamilyAttemptTimeout(2000);

const nodemailer = require("nodemailer");
const { ImapFlow } = require("imapflow");
const db = require("./db");
const { Store } = require("./store");
const { AccountWorker, describeError } = require("./sync");
const google = require("./google-oauth");
const { fetchBody, readStream } = require("./body");
const { createCompose } = require("./compose");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { pipeline } = require("stream/promises");

const parent = process.parentPort;
const log = (...a) => console.log("[email]", ...a); // nunca registrar senhas, tokens ou conteúdo

let store = null;
let cryptoInfo = { available: false, backend: "unknown" };
const ports = new Set();
const workers = new Map(); // accountId -> AccountWorker
const secrets = new Map(); // accountId -> segredo descriptografado (só em memória)
const accessTokens = new Map(); // accountId -> { accessToken, expiresAt }
let ready;
const readyPromise = new Promise((r) => (ready = r));

// ---------- Ponte com o processo principal ----------
let seq = 0;
const waiting = new Map();
function askMain(t, payload) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, { resolve, reject });
    parent.postMessage({ t, id, ...payload });
  });
}
const encrypt = (obj) => askMain("encrypt", { text: JSON.stringify(obj) });
const decrypt = async (b64) => JSON.parse(await askMain("decrypt", { b64 }));

parent.on("message", (e) => {
  const msg = e.data || {};
  if (msg.t === "init") {
    store = new Store(db.open(msg.dataDir));
    cryptoInfo = msg.crypto || cryptoInfo;
    ready();
    startWorkers().catch((err) => log("falha ao iniciar contas:", err.message));
  } else if (msg.t === "port" && e.ports[0]) {
    attachPort(e.ports[0]);
  } else if (msg.t === "reply") {
    const w = waiting.get(msg.id);
    if (!w) return;
    waiting.delete(msg.id);
    msg.error ? w.reject(new Error(msg.error)) : w.resolve(msg.result);
  } else if (msg.t === "sync-all") {
    for (const w of workers.values()) w.reconnect();
  } else if (msg.t === "shutdown") {
    Promise.all([...workers.values()].map((w) => w.stop())).finally(() => process.exit(0));
  }
});

// ---------- Interface (MessagePort) ----------
function attachPort(port) {
  ports.add(port);
  port.on("message", async (e) => {
    const { id, method, params } = e.data || {};
    try {
      await readyPromise;
      const fn = API[method];
      if (!fn) throw new Error(`Método desconhecido: ${method}`);
      port.postMessage({ id, result: await fn(params || {}) });
    } catch (err) {
      port.postMessage({ id, error: err.message || String(err) });
    }
  });
  port.on("close", () => ports.delete(port));
  port.start();
}

function emit(event, data) {
  for (const p of ports) p.postMessage({ event, data });
}

let countsTimer = null;
function emitCounts() {
  clearTimeout(countsTimer);
  countsTimer = setTimeout(() => {
    const byAccount = store.counts();
    const total = Object.values(byAccount).reduce((n, r) => n + (r.inbox || 0), 0);
    emit("counts", { byAccount, total });
    parent.postMessage({ t: "counts", total });
  }, 200);
}

// ---------- Provedores ----------
const PRESETS = {
  gmail: { imap_host: "imap.gmail.com", imap_port: 993, imap_secure: 1, smtp_host: "smtp.gmail.com", smtp_port: 465, smtp_secure: 1 },
  locaweb: { imap_host: "email-ssl.com.br", imap_port: 993, imap_secure: 1, smtp_host: "email-ssl.com.br", smtp_port: 465, smtp_secure: 1 },
};
const COLORS = ["#1f93ff", "#f5a524", "#17c964", "#f31260", "#9353d3", "#06b7db", "#ff7a45", "#8a94a0"];

async function googleClient() {
  if (process.env.MULTIHUB_GOOGLE_CLIENT_ID && process.env.MULTIHUB_GOOGLE_CLIENT_SECRET) {
    return { clientId: process.env.MULTIHUB_GOOGLE_CLIENT_ID, clientSecret: process.env.MULTIHUB_GOOGLE_CLIENT_SECRET, fromEnv: true };
  }
  const enc = store.getSetting("google_client");
  return enc ? decrypt(enc) : null;
}

async function accountSecret(account) {
  if (!secrets.has(account.id)) secrets.set(account.id, await decrypt(account.secret));
  return secrets.get(account.id);
}

async function googleAccessToken(account) {
  const cached = accessTokens.get(account.id);
  if (cached && cached.expiresAt - 60e3 > Date.now()) return cached.accessToken;
  const client = await googleClient();
  if (!client) throw Object.assign(new Error("Configure o Client ID do Google."), { code: "invalid_grant" });
  const { refreshToken } = await accountSecret(account);
  const t = await google.refresh({ ...client, refreshToken });
  accessTokens.set(account.id, t);
  return t.accessToken;
}

async function getImapAuth(account) {
  if (account.auth === "oauth-google") return { user: account.username, accessToken: await googleAccessToken(account) };
  return { user: account.username, pass: (await accountSecret(account)).pass };
}

async function getSmtpAuth(account) {
  if (account.auth === "oauth-google") return { type: "OAuth2", user: account.username, accessToken: await googleAccessToken(account) };
  return { user: account.username, pass: (await accountSecret(account)).pass };
}

const svc = {
  get store() {
    return store;
  },
  getImapAuth,
  emit,
  emitCounts,
  log,
  prefetch,
};

// ---------- Corpo das mensagens ----------
const PREFETCH_COUNT = 15; // corpos das mensagens mais recentes da Caixa de entrada, para abrir na hora
const PREFETCH_MAX_SIZE = 2 * 1024 * 1024;
const MAX_ATTACHMENT = 50 * 1024 * 1024;
const bodyJobs = new Map(); // messageId -> Promise (evita baixar a mesma mensagem duas vezes)

function workerFor(accountId) {
  const w = workers.get(accountId);
  if (!w) throw new Error("Conta não encontrada.");
  return w;
}

async function loadBody(messageId) {
  const cached = store.getBody(messageId);
  if (cached) return cached;
  if (bodyJobs.has(messageId)) return bodyJobs.get(messageId);
  const job = (async () => {
    const [m] = store.messagesByIds([messageId]);
    if (!m) throw new Error("Mensagem não encontrada.");
    const w = workerFor(m.account_id);
    const b = await w.withMailbox(m.folder_path, (client) => fetchBody(client, m.uid));
    store.saveBody({ messageId, ...b });
    if (b.snippet) emit("messages-changed", { accountId: m.account_id });
    return store.getBody(messageId);
  })();
  bodyJobs.set(messageId, job);
  try {
    return await job;
  } finally {
    bodyJobs.delete(messageId);
  }
}

const prefetching = new Set();
async function prefetch(worker) {
  const id = worker.account.id;
  if (prefetching.has(id)) return;
  prefetching.add(id);
  try {
    const inbox = worker.folders().find((f) => f.role === "inbox");
    if (!inbox) return;
    for (const mid of store.messagesWithoutBody(inbox.id, PREFETCH_MAX_SIZE, PREFETCH_COUNT)) {
      if (worker.stopped || worker.pending) break; // sincronização tem prioridade
      await loadBody(mid).catch(() => {});
    }
  } finally {
    prefetching.delete(id);
  }
}

function publicBody(b) {
  return {
    html: b.html,
    remoteImages: b.remote_images,
    attachments: JSON.parse(b.attachments || "[]"),
    truncated: !!b.truncated,
  };
}

// ---------- Ações nas mensagens ----------
/** Agrupa por conta e pasta para mandar um comando IMAP por pasta. */
function groupRows(ids) {
  const rows = store.messagesByIds((ids || []).map(Number).filter(Number.isFinite));
  const byAccount = new Map();
  for (const r of rows) {
    if (!byAccount.has(r.account_id)) byAccount.set(r.account_id, new Map());
    const byFolder = byAccount.get(r.account_id);
    if (!byFolder.has(r.folder_id)) byFolder.set(r.folder_id, []);
    byFolder.get(r.folder_id).push(r);
  }
  return byAccount;
}

const uidSet = (rows) => rows.map((r) => r.uid).join(",");

async function setFlag(ids, flag, on) {
  for (const [accountId, byFolder] of groupRows(ids)) {
    const w = workerFor(accountId);
    for (const rows of byFolder.values()) {
      await w.withMailbox(rows[0].folder_path, (c) =>
        on ? c.messageFlagsAdd(uidSet(rows), [flag], { uid: true }) : c.messageFlagsRemove(uidSet(rows), [flag], { uid: true })
      );
      if (flag === "\\Seen") store.setSeenLocal(rows, on);
      else store.setFlaggedLocal(rows, on);
    }
    emit("messages-changed", { accountId });
  }
  emitCounts();
}

/** Move para a pasta de um papel (archive/trash/junk/inbox) ou para uma pasta específica. */
async function moveTo(ids, { role, folderId }) {
  let moved = 0;
  for (const [accountId, byFolder] of groupRows(ids)) {
    const w = workerFor(accountId);
    const dest = folderId ? store.getFolder(Number(folderId)) : await w.folderForRole(role);
    if (!dest || dest.account_id !== accountId) {
      const names = { archive: "Arquivo", trash: "Lixeira", junk: "Spam", inbox: "Caixa de entrada" };
      throw new Error(`A conta ${w.account.email} não tem a pasta ${names[role] || "de destino"}.`);
    }
    for (const rows of byFolder.values()) {
      if (rows[0].folder_id === dest.id) continue;
      const gmailAll = w.isGmail && rows[0].special_use === "\\All";
      await w.withMailbox(rows[0].folder_path, (c) =>
        // No Gmail, tirar de "Todos os e-mails" apaga a mensagem: copiar só adiciona o marcador
        gmailAll ? c.messageCopy(uidSet(rows), dest.path, { uid: true }) : c.messageMove(uidSet(rows), dest.path, { uid: true })
      );
      store.removeLocal(rows);
      moved += rows.length;
      w.requestSync(rows[0].folder_id);
    }
    w.requestSync(dest.id);
    emit("messages-changed", { accountId });
  }
  emitCounts();
  return { moved };
}

async function deleteForever(ids) {
  for (const [accountId, byFolder] of groupRows(ids)) {
    const w = workerFor(accountId);
    for (const rows of byFolder.values()) {
      await w.withMailbox(rows[0].folder_path, (c) => c.messageDelete(uidSet(rows), { uid: true }));
      store.removeLocal(rows);
    }
    emit("messages-changed", { accountId });
  }
  emitCounts();
}

// ---------- Escrever / responder / enviar ----------
let composer = null;
const compose = () =>
  (composer ||= createCompose({ store, workerFor, loadBody, getSmtpAuth, emit, log, setFlag, describeError }));

// ---------- Anexos ----------
// Nunca abrir direto: o usuário pode salvar, mas o app não executa nada
const BLOCKED_EXT =
  /\.(exe|com|bat|cmd|msi|msix|msp|scr|pif|cpl|hta|jar|js|jse|vbs|vbe|wsf|wsh|ps1|psm1|reg|lnk|url|scf|inf|dll|sys|sh|bash|run|bin|appimage|desktop|deb|rpm|apk|app|command|py|pl|rb|iso|img|vhd|vhdx|docm|xlsm|pptm)$/i;

async function downloadAttachment(id, part, file) {
  const [m] = store.messagesByIds([Number(id)]);
  if (!m) throw new Error("Mensagem não encontrada.");
  const w = workerFor(m.account_id);
  await w.withMailbox(m.folder_path, async (c) => {
    const dl = await c.download(String(m.uid), String(part), { uid: true, maxBytes: MAX_ATTACHMENT });
    if (!dl || !dl.content) throw new Error("Anexo não encontrado no servidor.");
    if (dl.meta && dl.meta.expectedSize > MAX_ATTACHMENT) {
      dl.content.destroy();
      throw new Error("Anexo maior que 50 MB: abra pelo webmail.");
    }
    await pipeline(dl.content, fs.createWriteStream(file, { mode: 0o600 }));
  });
}

function attachmentInfo(id, part) {
  const b = store.getBody(Number(id));
  const list = b ? JSON.parse(b.attachments || "[]") : [];
  const a = list.find((x) => x.part === String(part));
  if (!a) throw new Error("Anexo não encontrado.");
  return a;
}

const TMP_ROOT = path.join(os.tmpdir(), "multihub-mail");

// ---------- Imagens remotas (só quando o usuário pede) ----------
const MAX_IMAGE = 5 * 1024 * 1024;
const PRIVATE_HOST = /^(localhost|.*\.local|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1\]?|\[?f[cd][0-9a-f]{2}:|\[?fe80:)/i;

// Cache em memória: voltar a um e-mail (ou o mesmo logo em vários e-mails) não baixa de novo
const IMAGE_TTL = 60 * 60 * 1000; // 60 min
const IMAGE_FAIL_TTL = 5 * 60 * 1000; // falhas: tenta de novo só depois de 5 min
const IMAGE_CACHE_MAX = 100 * 1024 * 1024; // 100 MB no total; sai primeiro o que foi usado há mais tempo
const imageCache = new Map(); // url -> { data, bytes, expires } (ordem do Map = uso mais recente por último)
const imageInFlight = new Map(); // url -> Promise (dois e-mails pedindo a mesma imagem ao mesmo tempo)
let imageCacheBytes = 0;

function imageCacheGet(url) {
  const e = imageCache.get(url);
  if (!e) return undefined;
  imageCache.delete(url);
  if (e.expires < Date.now()) {
    imageCacheBytes -= e.bytes;
    return undefined;
  }
  imageCache.set(url, e); // marca como usado agora
  return e.data;
}

function imageCacheSet(url, data) {
  const bytes = data ? data.length : 0;
  if (bytes > IMAGE_CACHE_MAX / 10) return; // imagem enorme: não ocupa o cache
  const old = imageCache.get(url);
  if (old) {
    imageCacheBytes -= old.bytes;
    imageCache.delete(url);
  }
  const now = Date.now();
  for (const [u, e] of imageCache) {
    if (imageCacheBytes + bytes <= IMAGE_CACHE_MAX && e.expires >= now) break;
    imageCache.delete(u);
    imageCacheBytes -= e.bytes;
  }
  imageCache.set(url, { data, bytes, expires: now + (data ? IMAGE_TTL : IMAGE_FAIL_TTL) });
  imageCacheBytes += bytes;
}

async function cachedImage(url) {
  const hit = imageCacheGet(url);
  if (hit !== undefined) return hit;
  if (imageInFlight.has(url)) return imageInFlight.get(url);
  const p = fetchImage(url)
    .then((data) => {
      imageCacheSet(url, data);
      return data;
    })
    .finally(() => imageInFlight.delete(url));
  imageInFlight.set(url, p);
  return p;
}

async function fetchImage(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol) || PRIVATE_HOST.test(u.hostname)) return null;
  try {
    const res = await fetch(u, { signal: AbortSignal.timeout(10000), redirect: "follow", headers: { Accept: "image/*" } });
    const type = String(res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!res.ok || !/^image\/(png|jpe?g|gif|webp|bmp|svg\+xml|x-icon|vnd\.microsoft\.icon|avif)$/.test(type)) return null;
    const buf = await readStream(res.body, MAX_IMAGE);
    if (buf.length >= MAX_IMAGE) return null;
    return `data:${type};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

async function startWorkers() {
  for (const a of store.listAccounts()) startWorker(a.id);
  emitCounts();
}

function startWorker(id) {
  const full = store.getAccount(id);
  if (!full) return;
  const w = new AccountWorker(svc, full);
  workers.set(id, w);
  w.start();
}

async function stopWorker(id) {
  const w = workers.get(id);
  workers.delete(id);
  if (w) await w.stop();
}

// ---------- Validação de conexão ----------
const TIMEOUT_CODES = new Set(["ETIMEDOUT", "ETIMEOUT", "ESOCKETTIMEDOUT", "CONNECT_TIMEOUT", "GREETING_TIMEOUT", "ECONNRESET"]);

/** Uma falha de rede momentânea não deve impedir o cadastro: tenta de novo uma vez. */
async function withRetry(label, fn) {
  try {
    return await fn();
  } catch (err) {
    if (!TIMEOUT_CODES.has(err.code)) throw err;
    log(`${label}: ${err.code} na 1ª tentativa; tentando de novo`);
    return fn();
  }
}

async function testImap(cfg, auth) {
  try {
    await withRetry(`IMAP ${cfg.imap_host}:${cfg.imap_port}`, async () => {
      const client = new ImapFlow({
        host: cfg.imap_host,
        port: cfg.imap_port,
        secure: !!cfg.imap_secure,
        auth,
        logger: false,
        verifyOnly: true,
        connectionTimeout: 30e3,
        greetingTimeout: 20e3,
      });
      client.on("error", () => {}); // o erro chega pelo connect()
      try {
        await client.connect();
      } finally {
        client.close();
      }
    });
  } catch (err) {
    log(`IMAP ${cfg.imap_host}:${cfg.imap_port} falhou: ${err.code || err.message}${err.responseText ? ` — ${err.responseText}` : ""}`);
    throw new Error("IMAP: " + describeError(err, cfg));
  }
}

async function testSmtp(cfg, auth) {
  const verify = async () => {
    const t = nodemailer.createTransport({
      host: cfg.smtp_host,
      port: cfg.smtp_port,
      secure: !!cfg.smtp_secure,
      requireTLS: !cfg.smtp_secure,
      auth,
      connectionTimeout: 30e3,
      greetingTimeout: 20e3,
      logger: false,
    });
    try {
      await t.verify();
    } finally {
      t.close();
    }
  };
  try {
    await withRetry(`SMTP ${cfg.smtp_host}:${cfg.smtp_port}`, verify);
  } catch (err) {
    log(`SMTP ${cfg.smtp_host}:${cfg.smtp_port} falhou: ${err.code || err.message}`);
    const msg = err.code === "EAUTH" ? "usuário ou senha recusados" : describeError(err, { ...cfg, imap_host: cfg.smtp_host, imap_port: cfg.smtp_port });
    throw new Error("SMTP: " + msg);
  }
}

// ---------- Saneamento de entrada ----------
const str = (v, max = 200) => String(v ?? "").trim().slice(0, max);
const port = (v, def) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : def;
};
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const host = (v) => {
  const h = str(v, 253).toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(h)) throw new Error("Servidor inválido.");
  return h;
};

function pickColor() {
  const used = new Set(store.listAccounts().map((a) => a.color));
  return COLORS.find((c) => !used.has(c)) || COLORS[store.listAccounts().length % COLORS.length];
}

function requireCrypto() {
  if (!cryptoInfo.available) {
    throw new Error("O sistema não oferece armazenamento seguro de senhas (chaveiro). Não é possível salvar a conta.");
  }
}

function publicAccount(a) {
  const w = workers.get(a.id);
  return { ...a, status: w ? w.status : "offline", error: w ? w.error : null };
}

// ---------- API usada pela interface ----------
const API = {
  async getState() {
    const gc = await googleClient().catch(() => null);
    return {
      accounts: store.listAccounts().map(publicAccount),
      counts: store.counts(),
      crypto: cryptoInfo,
      google: { configured: !!gc, fromEnv: !!(gc && gc.fromEnv) },
    };
  },

  async listMessages(p) {
    return store.listMessages({
      accountId: p.accountId ? Number(p.accountId) : null,
      role: p.role,
      unread: !!p.unread,
      attachments: !!p.attachments,
      flagged: !!p.flagged,
      q: str(p.q, 200),
      cursor: p.cursor,
      limit: p.limit,
      threads: p.threads !== false,
    });
  },

  /** Conversa da mensagem: cabeçalhos de todas, da mais antiga para a mais nova. */
  async getThread({ id }) {
    const anchor = store.getMessage(Number(id));
    if (!anchor) return null;
    const hidden = new Set(["trash", "junk"].filter((r) => r !== anchor.role));
    const seen = new Set();
    const list = [];
    // A mensagem clicada primeiro, para que uma cópia dela em outra pasta não a substitua
    const rows = store.getThread(anchor.id).sort((a, b) => (a.id === anchor.id ? -1 : b.id === anchor.id ? 1 : 0));
    for (const m of rows) {
      if (m.id !== anchor.id && hidden.has(m.role)) continue;
      const key = m.message_id || `id:${m.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      list.push(m);
    }
    list.sort((a, b) => a.date - b.date || a.id - b.id);
    return {
      anchorId: anchor.id,
      accountId: anchor.account_id,
      role: anchor.role,
      subject: anchor.subject,
      messages: list.map((m) => ({
        id: m.id,
        role: m.role,
        subject: m.subject,
        from_name: m.from_name,
        from_addr: m.from_addr,
        to: JSON.parse(m.to_json),
        cc: JSON.parse(m.cc_json),
        date: m.date,
        seen: m.seen,
        flagged: m.flagged,
        has_attachments: m.has_attachments,
        snippet: m.snippet,
        size: m.size,
      })),
    };
  },

  async getBody({ id }) {
    return publicBody(await loadBody(Number(id)));
  },

  async fetchImages({ urls }) {
    const list = [...new Set((Array.isArray(urls) ? urls : []).map(String))].slice(0, 60);
    const out = {};
    const missing = [];
    for (const u of list) {
      const hit = imageCacheGet(u);
      if (hit !== undefined) out[u] = hit;
      else missing.push(u);
    }
    for (let i = 0; i < missing.length; i += 6) {
      const batch = missing.slice(i, i + 6);
      const res = await Promise.all(batch.map(cachedImage));
      batch.forEach((u, j) => (out[u] = res[j]));
    }
    return out;
  },

  async setSeen({ ids, seen }) {
    await setFlag(ids, "\\Seen", !!seen);
    return { ok: true };
  },
  async setFlagged({ ids, flagged }) {
    await setFlag(ids, "\\Flagged", !!flagged);
    return { ok: true };
  },
  async archive({ ids }) {
    return moveTo(ids, { role: "archive" });
  },
  async trash({ ids }) {
    return moveTo(ids, { role: "trash" });
  },
  async spam({ ids, spam }) {
    return moveTo(ids, { role: spam === false ? "inbox" : "junk" });
  },
  async move({ ids, folderId }) {
    return moveTo(ids, { folderId });
  },
  async deleteForever({ ids }) {
    await deleteForever(ids);
    return { ok: true };
  },
  async composeStart(p) {
    return compose().start(p);
  },
  async composeAddAttachment(p) {
    return compose().addAttachment(p);
  },
  async composeRemoveAttachment(p) {
    return compose().removeAttachment(p);
  },
  async composeSaveDraft(p) {
    return compose().saveDraft(p);
  },
  async composeSend(p) {
    return compose().send(p);
  },
  async composeCancelSend(p) {
    return compose().cancelSend(p);
  },
  async composeDiscard(p) {
    return compose().discard(p);
  },
  async contacts(p) {
    return compose().contacts(p);
  },

  async listFolders({ accountId }) {
    return store.allFolders(Number(accountId));
  },

  async saveAttachment({ id, part }) {
    const a = attachmentInfo(id, part);
    const file = await askMain("save-dialog", { defaultName: a.filename });
    if (!file) return { cancelled: true };
    await downloadAttachment(id, part, file);
    return { path: file };
  },

  async openAttachment({ id, part }) {
    const a = attachmentInfo(id, part);
    if (BLOCKED_EXT.test(a.filename)) {
      throw new Error(`Por segurança, "${a.filename}" não é aberto pelo app. Use "Salvar" e verifique o arquivo antes.`);
    }
    const dir = path.join(TMP_ROOT, crypto.randomBytes(8).toString("hex"));
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, a.filename);
    await downloadAttachment(id, part, file);
    await askMain("open-path", { file });
    return { ok: true };
  },

  async getMessage({ id }) {
    const m = store.getMessage(Number(id));
    if (!m) return null;
    return {
      id: m.id,
      account_id: m.account_id,
      role: m.role,
      folder: m.folder_path,
      subject: m.subject,
      from_name: m.from_name,
      from_addr: m.from_addr,
      to: JSON.parse(m.to_json),
      cc: JSON.parse(m.cc_json),
      reply_to: JSON.parse(m.reply_to_json),
      date: m.date,
      size: m.size,
      seen: m.seen,
      flagged: m.flagged,
      has_attachments: m.has_attachments,
    };
  },

  /** Conta com senha (Locaweb, senha de app do Gmail ou qualquer IMAP/SMTP). */
  async addPasswordAccount(p) {
    requireCrypto();
    const provider = ["gmail", "locaweb", "imap"].includes(p.provider) ? p.provider : "imap";
    const email = str(p.email, 254).toLowerCase();
    if (!isEmail(email)) throw new Error("E-mail inválido.");
    let password = String(p.password || "");
    // Senha de app do Google aparece como "abcd efgh ijkl mnop": os espaços não fazem parte dela
    if (provider === "gmail") password = password.replace(/\s+/g, "");
    if (!password) throw new Error("Informe a senha.");
    if (store.findAccountByEmail(email)) throw new Error("Essa conta já está cadastrada.");

    const preset = PRESETS[provider] || {};
    const cfg = {
      provider,
      auth: "password",
      imap_host: provider === "imap" ? host(p.imap_host) : preset.imap_host,
      imap_port: provider === "imap" ? port(p.imap_port, 993) : preset.imap_port,
      imap_secure: provider === "imap" ? (p.imap_secure === false ? 0 : 1) : preset.imap_secure,
      smtp_host: provider === "imap" ? host(p.smtp_host) : preset.smtp_host,
      smtp_port: provider === "imap" ? port(p.smtp_port, 465) : preset.smtp_port,
      smtp_secure: provider === "imap" ? (p.smtp_secure === false ? 0 : 1) : preset.smtp_secure,
    };
    if (p.advanced && provider !== "imap") {
      // Locaweb/Gmail com servidores alterados pelo usuário em "Avançado"
      Object.assign(cfg, {
        imap_host: host(p.imap_host || cfg.imap_host),
        imap_port: port(p.imap_port, cfg.imap_port),
        smtp_host: host(p.smtp_host || cfg.smtp_host),
        smtp_port: port(p.smtp_port, cfg.smtp_port),
        smtp_secure: p.smtp_secure === false ? 0 : 1,
      });
    }
    const username = str(p.username, 254) || email;
    const auth = { user: username, pass: password };
    await testImap(cfg, auth);
    await testSmtp(cfg, auth);

    const id = store.insertAccount({
      $email: email,
      $name: str(p.name, 60) || email,
      $provider: cfg.provider,
      $auth: cfg.auth,
      $username: username,
      $imap_host: cfg.imap_host,
      $imap_port: cfg.imap_port,
      $imap_secure: cfg.imap_secure,
      $smtp_host: cfg.smtp_host,
      $smtp_port: cfg.smtp_port,
      $smtp_secure: cfg.smtp_secure,
      $secret: await encrypt({ pass: password }),
      $color: pickColor(),
      $signature: "",
      $auto_images: p.autoImages ? 1 : 0,
      $sender_name: str(p.senderName, 80),
    });
    startWorker(id);
    emit("accounts-changed", {});
    return { id };
  },

  async setGoogleClient({ clientId, clientSecret }) {
    requireCrypto();
    clientId = str(clientId, 300);
    clientSecret = str(clientSecret, 300);
    if (!/\.apps\.googleusercontent\.com$/.test(clientId)) throw new Error("Client ID inválido (termina em .apps.googleusercontent.com).");
    if (!clientSecret) throw new Error("Informe o Client secret.");
    store.setSetting("google_client", await encrypt({ clientId, clientSecret }));
    return { ok: true };
  },

  /** Login com Google (OAuth2). Com accountId, reconecta uma conta existente. */
  async connectGoogle({ accountId, name, autoImages, senderName }) {
    requireCrypto();
    const client = await googleClient();
    if (!client) throw new Error("Configure o Client ID e o Client secret do Google primeiro.");
    const existing = accountId ? store.getAccount(Number(accountId)) : null;

    const r = await google.authorize({
      ...client,
      loginHint: existing ? existing.email : undefined,
      openExternal: (url) => parent.postMessage({ t: "open-external", url }),
    });

    const secret = await encrypt({ refreshToken: r.refreshToken });
    let id;
    if (existing) {
      if (existing.email !== r.email) throw new Error(`Você entrou com ${r.email}, mas a conta é ${existing.email}.`);
      id = existing.id;
      store.updateAccountSecret(id, secret);
      secrets.delete(id);
      await stopWorker(id);
    } else {
      const dup = store.findAccountByEmail(r.email);
      if (dup) throw new Error(`${r.email} já está cadastrada. Use "Reconectar" nela.`);
      const cfg = { ...PRESETS.gmail, provider: "gmail", auth: "oauth-google" };
      await testImap(cfg, { user: r.email, accessToken: r.accessToken });
      id = store.insertAccount({
        $email: r.email,
        $name: str(name, 60) || r.email,
        $provider: "gmail",
        $auth: "oauth-google",
        $username: r.email,
        $imap_host: cfg.imap_host,
        $imap_port: cfg.imap_port,
        $imap_secure: cfg.imap_secure,
        $smtp_host: cfg.smtp_host,
        $smtp_port: cfg.smtp_port,
        $smtp_secure: cfg.smtp_secure,
        $secret: secret,
        $color: pickColor(),
        $signature: "",
        $auto_images: autoImages ? 1 : 0,
        $sender_name: str(senderName, 80),
      });
    }
    accessTokens.set(id, { accessToken: r.accessToken, expiresAt: r.expiresAt });
    startWorker(id);
    emit("accounts-changed", {});
    return { id, email: r.email };
  },

  async cancelGoogle() {
    google.cancel();
    return { ok: true };
  },

  async updateAccount({ id, name, color, signature, autoImages, senderName }) {
    const a = store.getAccount(Number(id));
    if (!a) throw new Error("Conta não encontrada.");
    store.updateAccountInfo(a.id, {
      name: str(name, 60) || a.name,
      color: /^#[0-9a-f]{6}$/i.test(color || "") ? color : a.color,
      signature: signature == null ? a.signature : String(signature).slice(0, 10000),
      autoImages: autoImages == null ? !!a.auto_images : !!autoImages,
      senderName: senderName == null ? a.sender_name : str(senderName, 80),
    });
    const w = workers.get(a.id);
    if (w) w.account = store.getAccount(a.id);
    emit("accounts-changed", {});
    return { ok: true };
  },

  async removeAccount({ id }) {
    id = Number(id);
    await stopWorker(id);
    secrets.delete(id);
    accessTokens.delete(id);
    store.deleteAccount(id); // o cache da conta sai junto (ON DELETE CASCADE)
    emit("accounts-changed", {});
    emitCounts();
    return { ok: true };
  },

  async syncNow({ accountId }) {
    const list = accountId ? [workers.get(Number(accountId))] : [...workers.values()];
    for (const w of list) if (w) w.client && w.client.usable ? w.requestSync("all") : w.reconnect();
    return { ok: true };
  },

  async reconnect({ accountId }) {
    const w = workers.get(Number(accountId));
    if (w) {
      secrets.delete(w.account.id);
      accessTokens.delete(w.account.id);
      w.reconnect();
    }
    return { ok: true };
  },
};

