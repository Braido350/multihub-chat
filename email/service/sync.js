// Uma conexão IMAP por conta: sincronização incremental das pastas principais
// e IMAP IDLE na Caixa de entrada para receber mensagens novas quase na hora.
const { ImapFlow } = require("imapflow");
const { HDR_FIELDS, parseHdr } = require("./organize/headers");

const INITIAL_WINDOW = 300; // mensagens mais recentes baixadas por pasta no primeiro acesso
const FULL_SYNC_EVERY = 5 * 60 * 1000; // as outras pastas (sem IDLE) são verificadas a cada 5 min
const RETRY_DELAYS = [5e3, 15e3, 60e3, 5 * 60e3];
const AUTH_RETRY = 30 * 60e3;
// Diagnóstico: MULTIHUB_EMAIL_DEBUG=1 mostra eventos IMAP (pastas e contagens, nunca conteúdo)
const DEBUG = !!process.env.MULTIHUB_EMAIL_DEBUG;

const ROLE_BY_SPECIAL = {
  "\\Inbox": "inbox",
  "\\Sent": "sent",
  "\\Drafts": "drafts",
  "\\Archive": "archive",
  "\\All": "archive", // Gmail: "Todos os e-mails" (filtrado pelos marcadores, ver abaixo)
  "\\Junk": "junk",
  "\\Trash": "trash",
};

// Palpite pelo nome (em português e inglês) quando o servidor não declara SPECIAL-USE
const ROLE_BY_NAME = [
  ["sent", /^(enviad[oa]s?|itens enviados|mensagens enviadas|sent( items| messages| mail)?)$/i],
  ["drafts", /^(rascunhos?|drafts?)$/i],
  ["archive", /^(arquivo|arquivad[oa]s|archives?)$/i],
  ["junk", /^(spam|lixo eletr[ôo]nico|junk( e-?mail)?|bulk mail)$/i],
  ["trash", /^(lixeira|itens exclu[íi]dos|trash|deleted( items| messages)?|bin)$/i],
];
const roleByName = (name) => (ROLE_BY_NAME.find(([, re]) => re.test(String(name || "").trim())) || [])[0];

/** Escolhe no máximo uma pasta por papel. Prefere o que o servidor declara (SPECIAL-USE) ao palpite pelo nome. */
function assignRoles(list) {
  const rank = (f) => (f.specialUse ? (f.specialUseSource === "name" ? 1 : 0) : 3) + (f.specialUse === "\\All" ? 2 : 0);
  const chosen = {};
  for (const f of list) {
    if (f.flags && (f.flags.has("\\Noselect") || f.flags.has("\\NonExistent"))) continue;
    const role = f.path.toUpperCase() === "INBOX" ? "inbox" : ROLE_BY_SPECIAL[f.specialUse] || roleByName(f.name);
    if (!role) continue;
    if (!chosen[role] || rank(f) < rank(chosen[role])) chosen[role] = f;
  }
  return list.map((f) => ({
    path: f.path,
    name: f.name,
    delimiter: f.delimiter,
    specialUse: f.specialUse || null,
    role: Object.keys(chosen).find((r) => chosen[r] === f) || null,
  }));
}

const ts = (d) => {
  const t = d ? new Date(d).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
};

const addr = (list) => JSON.stringify((list || []).map((a) => ({ name: a.name || "", address: a.address || "" })));

function hasAttachments(node) {
  if (!node) return false;
  if (node.childNodes && node.childNodes.length) return node.childNodes.some(hasAttachments);
  const type = String(node.type || "").toLowerCase();
  const disp = String(node.disposition || "").toLowerCase();
  const name = (node.dispositionParameters && node.dispositionParameters.filename) || (node.parameters && node.parameters.name);
  if (disp === "attachment") return true;
  if (!name || /^(text|multipart)\//.test(type)) return false;
  return !(disp === "inline" && type.startsWith("image/")); // imagem embutida na assinatura não conta
}

function parseRefs(headers) {
  if (!headers) return [];
  const m = /^references:\s*([\s\S]*?)(?:\r?\n(?!\s)|$)/im.exec(headers.toString("utf8"));
  return m ? m[1].match(/<[^<>\s]+>/g) || [] : [];
}

const flagRow = (folderId, msg) => {
  const fl = msg.flags || new Set();
  return {
    $folder_id: folderId,
    $uid: msg.uid,
    $seen: fl.has("\\Seen") ? 1 : 0,
    $flagged: fl.has("\\Flagged") ? 1 : 0,
    $answered: fl.has("\\Answered") ? 1 : 0,
    $draft: fl.has("\\Draft") ? 1 : 0,
    $labels: msg.labels ? JSON.stringify([...msg.labels]) : null,
  };
};

// No Gmail, "Todos os e-mails" contém tudo; o "Arquivo" do app é só o que saiu da Caixa de entrada
const GMAIL_ELSEWHERE = ["\\Inbox", "\\Sent", "\\Draft"];
const gmailArchived = (msg) => !msg.labels || !GMAIL_ELSEWHERE.some((l) => msg.labels.has(l));

class AccountWorker {
  /**
   * @param {object} svc  serviço: { store, getImapAuth(account), emit(event, data), log(...) }
   * @param {object} account  linha da tabela accounts
   */
  constructor(svc, account) {
    this.svc = svc;
    this.account = account;
    this.client = null;
    this.stopped = false;
    this.status = "connecting"; // connecting | syncing | idle | offline | error | auth
    this.error = null;
    this.retry = 0;
    this.pending = null; // Set de ids de pasta (null = nada; "all" = todas)
    this.running = false;
    this.timers = new Set();
  }

  get isGmail() {
    return this.account.provider === "gmail";
  }

  setStatus(status, error = null) {
    this.status = status;
    this.error = error;
    this.svc.emit("account-status", { id: this.account.id, status, error });
  }

  later(fn, ms) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
    return t;
  }

  start() {
    this.stopped = false;
    this.connect();
    const tick = () => {
      if (this.stopped) return;
      this.requestSync("all");
      this.later(tick, FULL_SYNC_EVERY);
    };
    this.later(tick, FULL_SYNC_EVERY);
  }

  async stop() {
    this.stopped = true;
    if (this.returnTimer) clearTimeout(this.returnTimer);
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    const c = this.client;
    this.client = null;
    if (c) {
      try {
        await c.logout();
      } catch {
        c.close();
      }
    }
  }

  async connect() {
    if (this.stopped) return;
    this.setStatus("connecting");
    let client;
    try {
      const a = this.account;
      client = new ImapFlow({
        host: a.imap_host,
        port: a.imap_port,
        secure: !!a.imap_secure,
        auth: await this.svc.getImapAuth(a),
        logger: false, // o log do ImapFlow pode conter dados das mensagens: desligado
        clientInfo: { name: "MultiHub Chat" },
        maxIdleTime: 4 * 60e3, // renova o IDLE antes que servidores/roteadores derrubem a conexão
        autoIdleDelay: 2000, // entra em IDLE logo após sincronizar (padrão do ImapFlow: 15 s)
        connectionTimeout: 30e3,
      });
      client.on("error", (err) => this.svc.log(`conta ${a.id}: ${err.code || err.message}`));
      client.on("close", () => this.onClose(client));
      client.on("exists", (ev) => {
        if (DEBUG) this.svc.log(`conta ${a.id}: EXISTS ${ev.path} ${ev.prevCount}->${ev.count}`);
        this.onServerChange(ev.path);
      });
      if (DEBUG) {
        client.on("mailboxOpen", (m) => this.svc.log(`conta ${a.id}: pasta aberta ${m.path}`));
      }
      client.on("expunge", (ev) => this.onServerChange(ev.path));
      client.on("flags", (ev) => this.onFlags(ev));

      await client.connect();
      if (this.stopped) return client.close();
      this.client = client;
      this.retry = 0;
      await this.refreshFolders();
      this.requestSync("all");
    } catch (err) {
      if (client) client.close();
      this.fail(err);
    }
  }

  fail(err) {
    if (this.stopped) return;
    const auth = err && (err.authenticationFailed || err.code === "invalid_grant");
    this.setStatus(auth ? "auth" : "offline", describeError(err, this.account));
    const delay = auth ? AUTH_RETRY : RETRY_DELAYS[Math.min(this.retry++, RETRY_DELAYS.length - 1)];
    this.later(() => this.connect(), delay);
  }

  onClose(client) {
    if (this.client !== client) return; // conexão antiga
    this.client = null;
    if (this.stopped) return;
    this.setStatus("offline", "Conexão perdida. Reconectando…");
    this.later(() => this.connect(), RETRY_DELAYS[Math.min(this.retry++, RETRY_DELAYS.length - 1)]);
  }

  /** Reconecta já (botão "Sincronizar"/"Reconectar"). */
  reconnect() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    const c = this.client;
    this.client = null;
    if (c) c.close();
    this.retry = 0;
    this.start();
  }

  folders() {
    return this.svc.store.listFolders(this.account.id);
  }

  folderByPath(path) {
    return this.folders().find((f) => f.path === path && f.role);
  }

  /** Executa comandos com a pasta selecionada e travada (as travas do ImapFlow serializam com a sincronização). */
  async withMailbox(path, fn) {
    const client = this.client;
    if (!client || !client.usable) {
      const err = new Error(`A conta ${this.account.email} está sem conexão no momento. Tente de novo em instantes.`);
      err.code = "OFFLINE";
      throw err;
    }
    const lock = await client.getMailboxLock(path);
    try {
      return await fn(client);
    } finally {
      lock.release();
      this.scheduleInboxReturn();
    }
  }

  /**
   * O IMAP só avisa de mensagens novas (IDLE) na pasta selecionada. Depois de usar outra pasta
   * (abrir um e-mail do Arquivo, gravar rascunho, mover...), volta para a Caixa de entrada.
   */
  scheduleInboxReturn() {
    if (this.returnTimer) clearTimeout(this.returnTimer);
    this.returnTimer = setTimeout(() => {
      this.returnTimer = null;
      if (this.stopped || this.running) return; // a sincronização já volta sozinha no fim
      this.backToInbox().catch((err) => this.svc.log(`conta ${this.account.id}: voltar à entrada: ${err.code || err.message}`));
    }, 1500);
  }

  /** Seleciona a Caixa de entrada e confere se chegou algo enquanto a conexão estava em outra pasta. */
  async backToInbox() {
    const client = this.client;
    const inbox = this.folders().find((f) => f.role === "inbox");
    if (!inbox || !client || !client.usable) return;
    if (client.mailbox?.path !== inbox.path) await client.mailboxOpen(inbox.path);
    const mb = client.mailbox;
    if (mb && mb.path === inbox.path && (mb.uidNext !== inbox.uidnext || mb.exists !== inbox.total)) this.requestSync(inbox.id);
  }

  /** Pasta de um papel; cria Arquivo, Rascunhos ou Enviados se a conta não tiver. */
  async folderForRole(role) {
    const CREATE = { archive: "Arquivo", drafts: "Rascunhos", sent: "Enviados" };
    let f = this.folders().find((x) => x.role === role);
    if (f || !CREATE[role]) return f || null;
    if (!this.client || !this.client.usable) return null;
    await this.client.mailboxCreate(CREATE[role]);
    await this.refreshFolders();
    return this.folders().find((x) => x.role === role) || null;
  }

  async refreshFolders() {
    const list = await this.client.list();
    this.svc.store.replaceFolders(this.account.id, assignRoles(list));
    this.svc.emit("folders-changed", { accountId: this.account.id });
  }

  onServerChange(path) {
    const f = this.folderByPath(path);
    if (f) this.requestSync(f.id);
  }

  onFlags(ev) {
    const f = this.folderByPath(ev.path);
    if (!f) return;
    if (!ev.uid) return this.requestSync(f.id);
    this.svc.store.updateFlags([flagRow(f.id, { uid: ev.uid, flags: ev.flags })]);
    this.svc.emit("messages-changed", { accountId: this.account.id });
    this.requestSync(f.id); // atualiza o contador de não lidas
  }

  requestSync(what) {
    if (this.stopped) return;
    if (what === "all" || this.pending === "all") this.pending = "all";
    else (this.pending ||= new Set()).add(what);
    if (!this.running) this.later(() => this.runQueue(), 300);
  }

  async runQueue() {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      while (this.pending && this.client && this.client.usable) {
        const job = this.pending;
        this.pending = null;
        if (job === "all") await this.refreshFolders();
        const all = this.folders().filter((f) => f.role);
        // Caixa de entrada primeiro: é o que aparece na tela
        const targets = (job === "all" ? all : all.filter((f) => job.has(f.id))).sort(
          (a, b) => (a.role === "inbox" ? -1 : 0) - (b.role === "inbox" ? -1 : 0)
        );
        this.setStatus("syncing");
        for (const f of targets) {
          if (!this.client || this.stopped) break;
          await this.syncFolder(f);
          this.svc.emit("messages-changed", { accountId: this.account.id });
        }
        this.svc.store.touchAccount(this.account.id);
        // Volta para a Caixa de entrada (o ImapFlow entra em IDLE na pasta selecionada) e confere
        // se chegou algo enquanto as outras pastas eram sincronizadas
        await this.backToInbox();
        if (!this.pending) this.setStatus("idle");
      }
      if (!this.pending && this.svc.prefetch) this.svc.prefetch(this);
    } catch (err) {
      this.svc.log(`conta ${this.account.id}: falha na sincronização: ${err.code || err.message}`);
      if (this.client && this.client.usable) {
        this.setStatus("error", describeError(err, this.account));
        this.later(() => this.requestSync("all"), 60e3);
      }
    } finally {
      this.running = false;
      this.svc.emitCounts();
    }
  }

  async syncFolder(folder) {
    const client = this.client;
    const store = this.svc.store;
    const gmailAll = this.isGmail && folder.special_use === "\\All";

    const st = await client.status(folder.path, {
      messages: true,
      unseen: true,
      uidNext: true,
      uidValidity: true,
      highestModseq: true,
    });
    if (!st) return;
    const uidvalidity = st.uidValidity != null ? String(st.uidValidity) : null;
    const modseq = st.highestModseq != null ? String(st.highestModseq) : null;

    // Nada mudou desde a última vez (CONDSTORE): pula sem abrir a pasta
    if (
      folder.uidvalidity === uidvalidity &&
      folder.uidnext === st.uidNext &&
      modseq &&
      folder.highest_modseq === modseq &&
      folder.total === st.messages
    ) {
      return;
    }

    const lock = await client.getMailboxLock(folder.path);
    try {
      const mb = client.mailbox;
      const state = {
        id: folder.id,
        uidvalidity: String(mb.uidValidity),
        uidnext: mb.uidNext,
        highest_modseq: mb.highestModseq != null ? String(mb.highestModseq) : null,
        last_uid: folder.last_uid,
        total: mb.exists,
        unread: st.unseen || 0,
      };

      // UIDVALIDITY mudou: os UIDs antigos não valem mais, recomeça a pasta
      if (folder.uidvalidity && folder.uidvalidity !== state.uidvalidity) {
        store.clearFolder(folder.id);
        state.last_uid = 0;
        folder = { ...folder, highest_modseq: null };
      }

      if (mb.exists === 0) {
        store.clearFolder(folder.id);
        state.last_uid = 0;
      } else {
        const known = state.last_uid;
        // 1) Mensagens novas
        const query = {
          uid: true,
          flags: true,
          envelope: true,
          bodyStructure: true,
          size: true,
          internalDate: true,
          // References (conversas) + cabeçalhos de envio em massa para a organização da caixa de entrada
          headers: HDR_FIELDS,
        };
        if (this.isGmail) Object.assign(query, { threadId: true, labels: true });
        const range = known ? `${known + 1}:*` : `${Math.max(1, mb.exists - INITIAL_WINDOW + 1)}:*`;
        const rows = [];
        let maxUid = known;
        for await (const msg of client.fetch(range, query, { uid: !!known })) {
          if (msg.uid <= known) continue; // "N:*" devolve a última mensagem mesmo sem novas
          maxUid = Math.max(maxUid, msg.uid);
          if (gmailAll && !gmailArchived(msg)) continue;
          rows.push(this.toRow(folder.id, msg));
        }
        store.upsertMessages(rows);
        // Mensagens novas na Caixa de entrada já entram no grupo certo (Importante, Propaganda, Outros)
        if (rows.length && folder.role === "inbox" && this.svc.onNewMessages) this.svc.onNewMessages();

        // 2) Flags e exclusões das mensagens que já estavam no cache
        if (known) {
          const min = store.minUid(folder.id) || known;
          const flagQuery = { uid: true, flags: true, labels: this.isGmail };
          const opts = { uid: true };
          if (folder.highest_modseq && state.highest_modseq) opts.changedSince = BigInt(folder.highest_modseq);
          const local = new Set(store.localUids(folder.id));
          const updates = [];
          const drop = [];
          const fetchFull = [];
          for await (const msg of client.fetch(`${min}:${known}`, flagQuery, opts)) {
            if (msg.uid > known) continue;
            if (gmailAll) {
              const want = gmailArchived(msg);
              if (want && !local.has(msg.uid)) fetchFull.push(msg.uid);
              else if (!want && local.has(msg.uid)) drop.push(msg.uid);
              else if (want) updates.push(flagRow(folder.id, msg));
            } else if (local.has(msg.uid)) {
              updates.push(flagRow(folder.id, msg));
            }
          }
          store.updateFlags(updates);
          store.deleteMessages(folder.id, drop);
          if (fetchFull.length) {
            const extra = [];
            for await (const msg of client.fetch(fetchFull.join(","), query, { uid: true })) extra.push(this.toRow(folder.id, msg));
            store.upsertMessages(extra);
          }

          // Excluídas/movidas em outro cliente
          const onServer = await client.search({ uid: `${min}:${known}` }, { uid: true });
          if (Array.isArray(onServer)) {
            const alive = new Set(onServer);
            store.deleteMessages(
              folder.id,
              store.localUids(folder.id).filter((u) => u <= known && !alive.has(u))
            );
          }
        }
        state.last_uid = maxUid;
      }

      // No "Arquivo" do Gmail o contador do servidor inclui a Caixa de entrada: conta localmente
      if (gmailAll) state.unread = store.localUnread(folder.id);
      store.saveFolderState(state);
    } finally {
      lock.release();
    }
  }

  toRow(folderId, msg) {
    const env = msg.envelope || {};
    const from = (env.from && env.from[0]) || (env.sender && env.sender[0]) || {};
    const refs = parseRefs(msg.headers);
    const messageId = env.messageId || null;
    const root = refs[0] || env.inReplyTo || messageId;
    const fl = flagRow(folderId, msg);
    return {
      $account_id: this.account.id,
      $folder_id: folderId,
      $uid: msg.uid,
      $message_id: messageId,
      $in_reply_to: env.inReplyTo || null,
      $refs: refs.length ? refs.join(" ") : null,
      $thread_key: msg.threadId ? `g:${msg.threadId}` : root ? `m:${root}` : `u:${folderId}:${msg.uid}`,
      $subject: env.subject || "",
      $from_name: from.name || "",
      $from_addr: (from.address || "").toLowerCase(),
      $to_json: addr(env.to),
      $cc_json: addr(env.cc),
      $reply_to_json: addr(env.replyTo),
      // Data de recebimento no servidor: o cabeçalho Date pode vir errado ou no futuro
      $date: ts(msg.internalDate) || ts(env.date) || Date.now(),
      $size: msg.size || null,
      $seen: fl.$seen,
      $flagged: fl.$flagged,
      $answered: fl.$answered,
      $draft: fl.$draft,
      $has_attachments: hasAttachments(msg.bodyStructure) ? 1 : 0,
      $labels: fl.$labels,
      $hdr: msg.headers ? parseHdr(msg.headers) : null,
    };
  }
}

/** Mensagem de erro amigável, sem dados sensíveis. */
function describeError(err, account) {
  if (!err) return "Erro desconhecido.";
  if (err.code === "invalid_grant") return "O acesso ao Google expirou. Clique em Reconectar.";
  if (err.authenticationFailed) {
    // O texto do servidor explica o motivo (não contém a senha)
    const server = String(err.responseText || "").replace(/\s+/g, " ").trim().slice(0, 200);
    if (account && (account.provider === "gmail" || /gmail\.com$/.test(account.imap_host || ""))) {
      if (/application-specific password required/i.test(server)) {
        return "O Google exige senha de app: a senha digitada é a senha normal da conta. Gere uma senha de app em myaccount.google.com/apppasswords.";
      }
      if (/web login required|log in via your web browser/i.test(server)) {
        return "O Google bloqueou o login por segurança. Entre no Gmail pelo navegador, confirme que foi você e tente de novo.";
      }
      if (/invalid credentials/i.test(server)) {
        return "O Google recusou o e-mail ou a senha de app. Confira se a senha de app foi gerada nesta mesma conta, se não foi revogada e se o e-mail está correto.";
      }
    }
    return `Usuário ou senha recusados${server ? ` (servidor: ${server})` : ""}.`;
  }
  const host = account ? `${account.imap_host}:${account.imap_port}` : "servidor";
  switch (err.code) {
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return `Servidor não encontrado (${host}). Verifique o endereço ou a internet.`;
    case "ECONNREFUSED":
      return `O servidor ${host} recusou a conexão. Confira a porta.`;
    case "ETIMEDOUT":
    case "ETIMEOUT":
    case "ESOCKETTIMEDOUT":
    case "CONNECT_TIMEOUT":
    case "GREETING_TIMEOUT":
      return `Tempo esgotado ao conectar em ${host} (${err.code}). Verifique a internet, VPN ou firewall e tente de novo.`;
    case "network":
      return err.message;
    default:
      if (/certificate|self.signed|CERT_/i.test(err.code || err.message || "")) return `Certificado inválido em ${host}.`;
      return err.message ? String(err.message).slice(0, 200) : "Erro ao sincronizar.";
  }
}

module.exports = { AccountWorker, describeError };
