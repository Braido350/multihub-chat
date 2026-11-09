// Todas as consultas ao cache local ficam aqui.
const { tx } = require("./db");

const ROLES = ["inbox", "sent", "drafts", "archive", "junk", "trash"];
// Grupos virtuais da Caixa de entrada, na ordem em que aparecem ("lidos" é sempre o último)
const GROUPS = ["importante", "propaganda", "outros", "suspeito", "lidos"];

// Mesma chave da triagem: pelo Message-ID, então mover entre pastas não perde a classificação
const KEY = "coalesce(m.message_id, 'u:' || m.folder_id || ':' || m.uid)";
const JOIN_CLASS = `LEFT JOIN inbox_class c ON c.account_id = m.account_id AND c.msg_key = ${KEY}`;
const JOIN_TRIAGE = `LEFT JOIN triage t ON t.account_id = m.account_id AND t.msg_key = ${KEY}`;
// Selo de risco (análise de segurança): 3 perigoso, 2 suspeito, 1 atenção
const RISK = `max(CASE t.det_level WHEN 'perigoso' THEN 3 WHEN 'suspeito' THEN 2 WHEN 'atencao' THEN 1 ELSE 0 END, CASE WHEN t.category = 'suspeito' THEN 2 ELSE 0 END)`;
const likeEscape = (s) => String(s).replace(/[\\%_]/g, (c) => "\\" + c);

// Campos de conta que podem ir para a interface (nunca o segredo)
const PUBLIC_ACCOUNT = `id, email, name, provider, auth, username, imap_host, imap_port, imap_secure,
  smtp_host, smtp_port, smtp_secure, color, signature, auto_images, sender_name, triage_enabled, triage_shadow, triage_allow_free,
  position, last_sync_at`;

class Store {
  constructor(db) {
    this.db = db;
    const p = (sql) => db.prepare(sql);
    this.s = {
      getSetting: p("SELECT value FROM settings WHERE key = ?"),
      setSetting: p("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
      delSetting: p("DELETE FROM settings WHERE key = ?"),

      listAccounts: p(`SELECT ${PUBLIC_ACCOUNT} FROM accounts ORDER BY position, id`),
      getAccount: p("SELECT * FROM accounts WHERE id = ?"),
      findAccount: p("SELECT id FROM accounts WHERE lower(email) = lower(?)"),
      insertAccount: p(`INSERT INTO accounts (email, name, provider, auth, username, imap_host, imap_port, imap_secure,
        smtp_host, smtp_port, smtp_secure, secret, color, signature, auto_images, sender_name, position, created_at)
        VALUES ($email, $name, $provider, $auth, $username, $imap_host, $imap_port, $imap_secure,
        $smtp_host, $smtp_port, $smtp_secure, $secret, $color, $signature, $auto_images, $sender_name,
        (SELECT coalesce(max(position), 0) + 1 FROM accounts), $created_at)`),
      updateAccountInfo: p("UPDATE accounts SET name = ?, color = ?, signature = ?, auto_images = ?, sender_name = ?, triage_enabled = ?, triage_allow_free = ? WHERE id = ?"),
      contacts: p(`SELECT max(name) AS name, address, sum(n) AS n, max(last) AS last FROM (
          SELECT max(from_name) AS name, from_addr AS address, count(*) AS n, max(date) AS last FROM messages
            WHERE from_addr LIKE $q ESCAPE '\\' OR from_name LIKE $q ESCAPE '\\' GROUP BY from_addr
          UNION ALL
          SELECT max(json_extract(j.value, '$.name')), lower(json_extract(j.value, '$.address')), count(*) * 3, max(m.date)
            FROM messages m JOIN folders f ON f.id = m.folder_id AND f.role = 'sent', json_each(m.to_json) j
            WHERE json_extract(j.value, '$.address') LIKE $q ESCAPE '\\' OR json_extract(j.value, '$.name') LIKE $q ESCAPE '\\'
            GROUP BY lower(json_extract(j.value, '$.address'))
        ) WHERE address <> '' GROUP BY address ORDER BY n DESC, last DESC LIMIT 8`),
      updateAccountSecret: p("UPDATE accounts SET secret = ? WHERE id = ?"),
      touchAccount: p("UPDATE accounts SET last_sync_at = ? WHERE id = ?"),
      deleteAccount: p("DELETE FROM accounts WHERE id = ?"),

      listFolders: p("SELECT * FROM folders WHERE account_id = ? ORDER BY path"),
      getFolder: p("SELECT * FROM folders WHERE id = ?"),
      upsertFolder: p(`INSERT INTO folders (account_id, path, name, delimiter, special_use, role)
        VALUES ($account_id, $path, $name, $delimiter, $special_use, $role)
        ON CONFLICT(account_id, path) DO UPDATE SET name = excluded.name, delimiter = excluded.delimiter,
          special_use = excluded.special_use, role = excluded.role`),
      deleteFolder: p("DELETE FROM folders WHERE id = ?"),
      saveFolderState: p(`UPDATE folders SET uidvalidity = $uidvalidity, uidnext = $uidnext,
        highest_modseq = $highest_modseq, last_uid = $last_uid, total = $total, unread = $unread,
        synced_at = $synced_at WHERE id = $id`),
      setFolderUnread: p("UPDATE folders SET unread = ? WHERE id = ?"),

      upsertMessage: p(`INSERT INTO messages (account_id, folder_id, uid, message_id, in_reply_to, refs, thread_key,
        subject, from_name, from_addr, to_json, cc_json, reply_to_json, date, size, seen, flagged, answered, draft,
        has_attachments, labels, hdr)
        VALUES ($account_id, $folder_id, $uid, $message_id, $in_reply_to, $refs, $thread_key,
        $subject, $from_name, $from_addr, $to_json, $cc_json, $reply_to_json, $date, $size, $seen, $flagged,
        $answered, $draft, $has_attachments, $labels, $hdr)
        ON CONFLICT(folder_id, uid) DO UPDATE SET seen = excluded.seen, flagged = excluded.flagged,
          answered = excluded.answered, draft = excluded.draft, labels = excluded.labels,
          hdr = coalesce(excluded.hdr, hdr)`),
      updateFlags: p(`UPDATE messages SET seen = $seen, flagged = $flagged, answered = $answered, draft = $draft,
        labels = coalesce($labels, labels) WHERE folder_id = $folder_id AND uid = $uid`),
      localUids: p("SELECT uid FROM messages WHERE folder_id = ?"),
      minUid: p("SELECT min(uid) AS v FROM messages WHERE folder_id = ?"),
      deleteMessage: p("DELETE FROM messages WHERE folder_id = ? AND uid = ?"),
      deleteFolderMessages: p("DELETE FROM messages WHERE folder_id = ?"),
      localUnread: p("SELECT count(*) AS n FROM messages WHERE folder_id = ? AND seen = 0"),
      getMessage: p(`SELECT m.*, f.role, f.path AS folder_path FROM messages m JOIN folders f ON f.id = m.folder_id
        WHERE m.id = ?`),
      counts: p(`SELECT account_id, role, sum(unread) AS unread FROM folders
        WHERE role IS NOT NULL GROUP BY account_id, role`),

      thread: p(`SELECT m.*, f.role, f.path AS folder_path, f.special_use FROM messages m
        JOIN folders f ON f.id = m.folder_id
        WHERE m.account_id = (SELECT account_id FROM messages WHERE id = $id)
          AND m.thread_key = (SELECT thread_key FROM messages WHERE id = $id)
        ORDER BY m.date ASC, m.id ASC LIMIT 200`),
      getBody: p("SELECT * FROM bodies WHERE message_id = ?"),
      saveBody: p(`INSERT INTO bodies (message_id, html, text, remote_images, attachments, truncated, headers, links, fetched_at)
        VALUES ($message_id, $html, $text, $remote_images, $attachments, $truncated, $headers, $links, $fetched_at)
        ON CONFLICT(message_id) DO UPDATE SET html = excluded.html, text = excluded.text,
          remote_images = excluded.remote_images, attachments = excluded.attachments,
          truncated = excluded.truncated, headers = excluded.headers, links = excluded.links,
          fetched_at = excluded.fetched_at`),
      deleteBody: p("DELETE FROM bodies WHERE message_id = ?"),
      triagePending: p(`SELECT m.id, m.account_id, m.uid, m.from_name, m.from_addr, m.date, f.path AS folder_path,
          coalesce(m.message_id, 'u:' || m.folder_id || ':' || m.uid) AS msg_key
        FROM messages m
        JOIN folders f ON f.id = m.folder_id AND f.role IN ('inbox', 'junk')
        JOIN accounts a ON a.id = m.account_id AND a.triage_enabled = 1
        LEFT JOIN triage t ON t.account_id = m.account_id AND t.msg_key = coalesce(m.message_id, 'u:' || m.folder_id || ':' || m.uid)
        WHERE t.id IS NULL AND m.date >= ? ORDER BY m.date DESC LIMIT ?`),
      saveTriageDet: p(`INSERT INTO triage (account_id, msg_key, status, det_score, det_level, signals, av_status,
          pipeline_version, error, created_at, updated_at)
        VALUES ($account_id, $msg_key, $status, $det_score, $det_level, $signals, $av_status, $pipeline, $error, $now, $now)
        ON CONFLICT(account_id, msg_key) DO UPDATE SET status = excluded.status, det_score = excluded.det_score,
          det_level = excluded.det_level, signals = excluded.signals, av_status = excluded.av_status,
          pipeline_version = excluded.pipeline_version, error = excluded.error, updated_at = excluded.updated_at`),
      deleteTriage: p("DELETE FROM triage WHERE account_id = ? AND msg_key = ?"),
      // Etapa 2 (LLM): já passou pelas regras, ainda sem categoria
      triageLlmPending: p(`SELECT t.id AS triage_id, t.det_level, t.det_score, t.signals, t.llm_attempts,
          m.id, m.account_id, m.subject, m.from_name, m.from_addr, m.date, a.triage_allow_free
        FROM triage t
        JOIN messages m ON m.account_id = t.account_id AND coalesce(m.message_id, 'u:' || m.folder_id || ':' || m.uid) = t.msg_key
        JOIN folders f ON f.id = m.folder_id AND f.role IN ('inbox', 'junk')
        JOIN accounts a ON a.id = t.account_id AND a.triage_enabled = 1
        WHERE t.status = 'done' AND t.category IS NULL AND t.llm_attempts < 3
          AND (t.llm_retry_at IS NULL OR t.llm_retry_at <= $now) AND m.date >= $since
          AND ($requireFree = 0 OR (a.triage_allow_free = 1 AND m.seen = 0))
        GROUP BY t.id ORDER BY m.date DESC LIMIT $limit`),
      saveTriageLlm: p(`UPDATE triage SET category = $category, risk = $risk, priority = $priority, confidence = $confidence,
          action = $action, summary = $summary, reason = $reason, deadlines = $deadlines, llm_json = $llm_json,
          model = $model, prompt_version = $prompt_version, llm_retry_at = NULL, updated_at = $now WHERE id = $id`),
      triageLlmFail: p(`UPDATE triage SET llm_attempts = llm_attempts + $inc, llm_retry_at = $retry_at, error = $error,
          updated_at = $now WHERE id = $id`),
      triageOf: p(`SELECT t.* FROM messages m JOIN triage t ON t.account_id = m.account_id AND t.msg_key = coalesce(m.message_id, 'u:' || m.folder_id || ':' || m.uid)
        WHERE m.id = ?`),
      setSnippet: p("UPDATE messages SET snippet = ? WHERE id = ?"),
      withoutBody: p(`SELECT m.id FROM messages m LEFT JOIN bodies b ON b.message_id = m.id
        WHERE m.folder_id = ? AND b.message_id IS NULL AND (m.size IS NULL OR m.size <= ?)
        ORDER BY m.date DESC LIMIT ?`),
      setSeen: p("UPDATE messages SET seen = ? WHERE id = ?"),
      setFlagged: p("UPDATE messages SET flagged = ? WHERE id = ?"),
      deleteById: p("DELETE FROM messages WHERE id = ?"),
      adjustUnread: p("UPDATE folders SET unread = max(0, unread + ?) WHERE id = ?"),
      allFolders: p("SELECT id, path, name, role, special_use, delimiter FROM folders WHERE account_id = ? ORDER BY path"),

      // ---------- organização da caixa de entrada ----------
      // Uma linha por mensagem (a cópia da Caixa de entrada tem preferência), com o que muda a decisão
      organizeScan: p(`WITH cand AS (
          SELECT m.id, m.account_id, m.date, m.seen, m.flagged, m.answered, m.thread_key, m.from_addr,
            m.hdr IS NOT NULL AS has_hdr, f.role, ${KEY} AS msg_key,
            row_number() OVER (PARTITION BY m.account_id, ${KEY} ORDER BY f.role = 'inbox' DESC, m.id DESC) AS rn
          FROM messages m JOIN folders f ON f.id = m.folder_id AND f.role IN ('inbox', 'archive', 'trash')
        ),
        sent AS (
          SELECT DISTINCT s.account_id, s.thread_key FROM messages s
          JOIN folders sf ON sf.id = s.folder_id AND sf.role = 'sent' WHERE s.thread_key IS NOT NULL
        )
        SELECT x.id, x.account_id, x.msg_key, x.role, x.seen, x.flagged, x.answered, x.has_hdr, x.from_addr,
          b.message_id IS NOT NULL AS has_body, st.thread_key IS NOT NULL AS rt,
          t.det_level, t.det_score, t.category AS llm_category,
          c.id AS cid, c.version, c.gen, c.source, c.fp_class, c.fp_train
        FROM cand x
        LEFT JOIN bodies b ON b.message_id = x.id
        LEFT JOIN sent st ON st.account_id = x.account_id AND st.thread_key = x.thread_key
        LEFT JOIN triage t ON t.account_id = x.account_id AND t.msg_key = x.msg_key
        LEFT JOIN inbox_class c ON c.account_id = x.account_id AND c.msg_key = x.msg_key
        WHERE x.rn = 1
        ORDER BY x.date DESC, x.id DESC`),
      saveClass: p(`INSERT INTO inbox_class (account_id, msg_key, category, grp, confidence, source, reason, manual,
          version, gen, fp_class, fp_train, train_label, train_weight, train_tokens, updated_at)
        VALUES ($account_id, $msg_key, $category, $grp, $confidence, $source, $reason, $manual,
          $version, $gen, $fp_class, $fp_train, $train_label, $train_weight, $train_tokens, $now)
        ON CONFLICT(account_id, msg_key) DO UPDATE SET category = excluded.category, grp = excluded.grp,
          confidence = excluded.confidence, source = excluded.source, reason = excluded.reason, manual = excluded.manual,
          version = excluded.version, gen = excluded.gen, fp_class = excluded.fp_class, fp_train = excluded.fp_train,
          train_label = excluded.train_label, train_weight = excluded.train_weight, train_tokens = excluded.train_tokens,
          updated_at = excluded.updated_at`),
      saveTrain: p(`UPDATE inbox_class SET fp_train = ?, train_label = ?, train_weight = ?, train_tokens = ?, updated_at = ?
        WHERE id = ?`),
      setManual: p(`INSERT INTO inbox_class (account_id, msg_key, manual, version, updated_at) VALUES (?, ?, ?, 0, ?)
        ON CONFLICT(account_id, msg_key) DO UPDATE SET manual = excluded.manual, version = 0, updated_at = excluded.updated_at`),
      senderStats: p(`SELECT m.from_addr AS addr, count(*) AS n, sum(m.seen) AS opened, sum(m.answered) AS replied,
          sum(m.seen = 0 AND f.role IN ('archive', 'trash')) AS ignored,
          sum(c.train_label = 'importante') AS l_imp, sum(c.train_label = 'propaganda') AS l_prop,
          sum(c.train_label = 'outros') AS l_out, sum(c.manual = 'importante') AS m_imp,
          sum(c.manual = 'propaganda') AS m_prop, sum(c.manual = 'outros') AS m_out
        FROM messages m JOIN folders f ON f.id = m.folder_id AND f.role IN ('inbox', 'archive', 'trash')
        ${JOIN_CLASS}
        WHERE m.from_addr <> '' GROUP BY m.from_addr`),
      sentContacts: p(`SELECT lower(json_extract(j.value, '$.address')) AS a
          FROM messages m JOIN folders f ON f.id = m.folder_id AND f.role = 'sent', json_each(m.to_json) j
        UNION
        SELECT lower(json_extract(j.value, '$.address'))
          FROM messages m JOIN folders f ON f.id = m.folder_id AND f.role = 'sent', json_each(m.cc_json) j`),
      classStats: p(`SELECT coalesce(c.source, 'pendente') AS source, coalesce(c.grp, 'outros') AS grp, m.seen, count(*) AS n
        FROM messages m JOIN folders f ON f.id = m.folder_id AND f.role = 'inbox' ${JOIN_CLASS}
        GROUP BY 1, 2, 3`),
      threadInbox: p(`SELECT m.id, m.account_id, m.from_addr, ${KEY} AS msg_key FROM messages m
        JOIN folders f ON f.id = m.folder_id AND f.role = 'inbox' WHERE m.account_id = ? AND m.thread_key = ?`),
      missingHdr: p("SELECT uid FROM messages WHERE folder_id = ? AND hdr IS NULL ORDER BY date DESC LIMIT ?"),
      setHdr: p("UPDATE messages SET hdr = ? WHERE folder_id = ? AND uid = ?"),
    };
  }

  // ---------- configurações ----------
  getSetting(key) {
    const r = this.s.getSetting.get(key);
    return r ? r.value : null;
  }
  setSetting(key, value) {
    value == null ? this.s.delSetting.run(key) : this.s.setSetting.run(key, String(value));
  }

  // ---------- contas ----------
  listAccounts() {
    return this.s.listAccounts.all();
  }
  getAccount(id) {
    return this.s.getAccount.get(id) || null;
  }
  findAccountByEmail(email) {
    const r = this.s.findAccount.get(email);
    return r ? r.id : null;
  }
  insertAccount(a) {
    return Number(this.s.insertAccount.run({ ...a, $created_at: Date.now() }).lastInsertRowid);
  }
  updateAccountInfo(id, { name, color, signature, autoImages, senderName, triageEnabled, allowFree }) {
    this.s.updateAccountInfo.run(name, color, signature, autoImages ? 1 : 0, senderName || "", triageEnabled ? 1 : 0, allowFree ? 1 : 0, id);
  }
  updateAccountSecret(id, secret) {
    this.s.updateAccountSecret.run(secret, id);
  }
  touchAccount(id) {
    this.s.touchAccount.run(Date.now(), id);
  }
  deleteAccount(id) {
    this.s.deleteAccount.run(id);
  }

  // ---------- pastas ----------
  listFolders(accountId) {
    return this.s.listFolders.all(accountId);
  }
  getFolder(id) {
    return this.s.getFolder.get(id) || null;
  }
  /** Substitui a lista de pastas da conta pela que o servidor informou. */
  replaceFolders(accountId, list) {
    return tx(this.db, () => {
      const seen = new Set();
      for (const f of list) {
        seen.add(f.path);
        this.s.upsertFolder.run({
          $account_id: accountId,
          $path: f.path,
          $name: f.name,
          $delimiter: f.delimiter || null,
          $special_use: f.specialUse || null,
          $role: f.role || null,
        });
      }
      for (const f of this.listFolders(accountId)) if (!seen.has(f.path)) this.s.deleteFolder.run(f.id);
      return this.listFolders(accountId);
    });
  }
  saveFolderState(f) {
    this.s.saveFolderState.run({
      $id: f.id,
      $uidvalidity: f.uidvalidity ?? null,
      $uidnext: f.uidnext ?? null,
      $highest_modseq: f.highest_modseq ?? null,
      $last_uid: f.last_uid || 0,
      $total: f.total || 0,
      $unread: f.unread || 0,
      $synced_at: Date.now(),
    });
  }
  localUnread(folderId) {
    return this.s.localUnread.get(folderId).n;
  }

  // ---------- mensagens ----------
  upsertMessages(rows) {
    if (!rows.length) return;
    tx(this.db, () => {
      for (const r of rows) this.s.upsertMessage.run(r);
    });
  }
  updateFlags(rows) {
    if (!rows.length) return;
    tx(this.db, () => {
      for (const r of rows) this.s.updateFlags.run(r);
    });
  }
  localUids(folderId) {
    return this.s.localUids.all(folderId).map((r) => r.uid);
  }
  minUid(folderId) {
    return this.s.minUid.get(folderId).v || 0;
  }
  deleteMessages(folderId, uids) {
    if (!uids.length) return;
    tx(this.db, () => {
      for (const uid of uids) this.s.deleteMessage.run(folderId, uid);
    });
  }
  clearFolder(folderId) {
    this.s.deleteFolderMessages.run(folderId);
  }

  /**
   * Base das listas: mensagens de uma pasta (ou conversas: uma linha por thread, a mais recente, com os
   * totais da conversa), com o grupo da organização e o selo de risco da análise de segurança.
   */
  _listBase({ accountId, role = "inbox", unread, read, attachments, flagged, q, threads = true, priority }) {
    const params = { $role: ROLES.includes(role) ? role : "inbox" };
    const where = ["f.role = $role"];
    if (accountId) {
      where.push("m.account_id = $account");
      params.$account = accountId;
    }
    if (unread) where.push("m.seen = 0");
    if (attachments) where.push("m.has_attachments = 1");
    if (priority != null && Number.isFinite(Number(priority))) {
      // Prioritários: pontuação de relevância acima do limiar
      where.push("ps.score >= $pth");
      params.$pth = Number(priority);
    }
    if (flagged) where.push("m.flagged = 1");
    if (q && String(q).trim()) {
      // Busca simples em assunto/remetente/destinatários (lidas e não lidas, sem depender dos grupos)
      params.$q = "%" + likeEscape(String(q).trim()) + "%";
      where.push(
        "(m.subject LIKE $q ESCAPE '\\' OR m.from_name LIKE $q ESCAPE '\\' OR m.from_addr LIKE $q ESCAPE '\\' OR m.to_json LIKE $q ESCAPE '\\')"
      );
    }
    const cols = `m.id, m.account_id, m.subject, m.from_name, m.from_addr, m.to_json, m.date, m.flagged, m.answered,
        m.has_attachments, m.snippet, m.thread_key, coalesce(c.grp, 'outros') AS grp, c.manual AS manual,
        ps.score AS pscore, ps.reason AS preason, ps.source AS psource`;
    const from = `FROM messages m JOIN folders f ON f.id = m.folder_id ${JOIN_CLASS} ${JOIN_TRIAGE}
        LEFT JOIN priority_score ps ON ps.account_id = m.account_id AND ps.msg_key = ${KEY}
        WHERE ${where.join(" AND ")}`;
    if (!threads) {
      return { params, sql: `SELECT ${cols}, m.seen AS seen, 1 AS thread_count, ${RISK} AS risk_rank ${from}${read ? " AND m.seen = 1" : ""}` };
    }
    // "Lidas" em conversas: a conversa inteira lida (filtrar mensagem a mensagem esconderia as não lidas dela)
    const sql = `SELECT id, account_id, subject, from_name, from_addr, to_json, date, thread_flagged AS flagged, answered,
        thread_attachments AS has_attachments, snippet, thread_key, grp, manual, pscore, preason, psource,
        CASE WHEN thread_unread THEN 0 ELSE 1 END AS seen, thread_count, thread_risk AS risk_rank
      FROM (SELECT ${cols}, row_number() OVER w AS rn, count(*) OVER p AS thread_count,
          max(m.seen = 0) OVER p AS thread_unread, max(m.flagged) OVER p AS thread_flagged,
          max(m.has_attachments) OVER p AS thread_attachments, max(${RISK}) OVER p AS thread_risk
        ${from}
        WINDOW p AS (PARTITION BY m.account_id, m.thread_key),
               w AS (PARTITION BY m.account_id, m.thread_key ORDER BY m.date DESC, m.id DESC))
      WHERE rn = 1${read ? " AND thread_unread = 0" : ""}`;
    return { params, sql };
  }

  /**
   * Lista simples (pastas que não são a Caixa de entrada, e a busca): ordenada por data, com
   * paginação por cursor (date, id) para não ficar lenta com caixas grandes.
   */
  listMessages(o) {
    const { sql, params } = this._listBase(o);
    const p = { ...params, $limit: Math.min(Math.max(o.limit | 0 || 100, 1), 500) };
    let cursorWhere = "";
    if (o.cursor && Number.isFinite(o.cursor.date) && Number.isFinite(o.cursor.id)) {
      cursorWhere = "WHERE (date < $cdate OR (date = $cdate AND id < $cid))";
      p.$cdate = o.cursor.date;
      p.$cid = o.cursor.id;
    }
    return this.db.prepare(`SELECT * FROM (${sql}) ${cursorWhere} ORDER BY date DESC, id DESC LIMIT $limit`).all(p);
  }

  /** Grupo de cada linha conforme o modo: não lidas por categoria + "lidos"; só não lidas; ou só lidas por categoria. */
  _inboxBuckets(o) {
    const { sql, params } = this._listBase({ ...o, role: "inbox", unread: false, read: false, q: "" });
    const bucket =
      o.mode === "read"
        ? "CASE WHEN seen = 1 THEN grp END"
        : o.mode === "unread"
        ? "CASE WHEN seen = 0 THEN grp END"
        : "grp"; // lidas continuam no grupo da categoria
    return { params, with: `WITH b AS (SELECT *, ${bucket} AS bucket FROM (${sql}))` };
  }

  /**
   * Caixa de entrada em grupos virtuais. Para cada grupo: total, as mais recentes (até o limite pedido) e se há mais.
   * @param {{accountId, mode: 'all'|'unread'|'read', flagged, attachments, threads, limits: Object<string, number>}} o
   */
  listInbox(o) {
    const { params, with: w } = this._inboxBuckets(o);
    const counts = {};
    const unread = {};
    for (const r of this.db
      .prepare(`${w} SELECT bucket, count(*) AS n, sum(seen = 0) AS u FROM b WHERE bucket IS NOT NULL GROUP BY bucket`)
      .all(params)) {
      counts[r.bucket] = r.n;
      unread[r.bucket] = r.u || 0;
    }
    const lim = {};
    const cases = GROUPS.map((g) => {
      lim["$l_" + g] = Math.min(Math.max(Number((o.limits || {})[g]) | 0, 0), 500);
      return `WHEN '${g}' THEN $l_${g}`;
    }).join(" ");
    const rows = this.db
      .prepare(
        `${w}, r AS (SELECT *, row_number() OVER (PARTITION BY bucket ORDER BY date DESC, id DESC) AS brn FROM b WHERE bucket IS NOT NULL)
        SELECT * FROM r WHERE brn <= CASE bucket ${cases} ELSE 0 END ORDER BY date DESC, id DESC`
      )
      .all({ ...params, ...lim });
    const groups = {};
    for (const g of GROUPS) groups[g] = { count: counts[g] || 0, unread: unread[g] || 0, items: [], hasMore: false };
    for (const r of rows) groups[r.bucket].items.push(r);
    for (const g of GROUPS) groups[g].hasMore = groups[g].items.length < groups[g].count;
    return { groups };
  }

  /** "Mostrar mais" de um grupo: próxima página, direto do banco. */
  listInboxGroup(o) {
    const { params, with: w } = this._inboxBuckets(o);
    const limit = Math.min(Math.max(o.limit | 0 || 20, 1), 500);
    const p = { ...params, $bucket: String(o.group), $limit: limit + 1 };
    let cursorWhere = "";
    if (o.cursor && Number.isFinite(o.cursor.date) && Number.isFinite(o.cursor.id)) {
      cursorWhere = "AND (date < $cdate OR (date = $cdate AND id < $cid))";
      p.$cdate = o.cursor.date;
      p.$cid = o.cursor.id;
    }
    const rows = this.db.prepare(`${w} SELECT * FROM b WHERE bucket = $bucket ${cursorWhere} ORDER BY date DESC, id DESC LIMIT $limit`).all(p);
    return { items: rows.slice(0, limit), hasMore: rows.length > limit };
  }

  /** Mensagens da conversa (mesma conta), da mais antiga para a mais nova. */
  getThread(id) {
    return this.s.thread.all({ $id: id });
  }
  getBody(messageId) {
    return this.s.getBody.get(messageId) || null;
  }
  saveBody(b) {
    this.s.saveBody.run({
      $message_id: b.messageId,
      $html: b.html ?? null,
      $text: b.text ?? null,
      $remote_images: b.remoteImages || 0,
      $attachments: JSON.stringify(b.attachments || []),
      $truncated: b.truncated ? 1 : 0,
      $headers: b.headers ? JSON.stringify(b.headers) : null,
      $links: b.links ? JSON.stringify(b.links) : null,
      $fetched_at: Date.now(),
    });
    if (b.snippet != null) this.s.setSnippet.run(b.snippet, b.messageId);
  }
  // ---------- triagem (fase 6) ----------
  triagePending(since, limit) {
    return this.s.triagePending.all(since, limit);
  }
  saveTriage(o) {
    this.s.saveTriageDet.run({
      $account_id: o.accountId,
      $msg_key: o.key,
      $status: o.status,
      $det_score: o.detScore || 0,
      $det_level: o.detLevel || "ok",
      $signals: JSON.stringify(o.signals || []),
      $av_status: o.avStatus || null,
      $pipeline: o.pipeline,
      $error: o.error || null,
      $now: Date.now(),
    });
  }
  triageLlmPending({ since, requireFree, limit }) {
    return this.s.triageLlmPending.all({ $now: Date.now(), $since: since, $requireFree: requireFree ? 1 : 0, $limit: limit });
  }
  saveTriageLlm(id, r) {
    this.s.saveTriageLlm.run({
      $id: id,
      $category: r.category,
      $risk: r.risk ?? null,
      $priority: r.priority ?? null,
      $confidence: r.confidence ?? null,
      $action: r.action || null,
      $summary: r.summary || null,
      $reason: JSON.stringify(r.reasons || []),
      $deadlines: JSON.stringify(r.deadlines || []),
      $llm_json: r.llm ? JSON.stringify(r.llm) : null,
      $model: r.model || null,
      $prompt_version: r.promptVersion || null,
      $now: Date.now(),
    });
  }
  triageLlmFail(id, { retryAt, countAttempt, error }) {
    this.s.triageLlmFail.run({ $id: id, $inc: countAttempt ? 1 : 0, $retry_at: retryAt || null, $error: error ? String(error).slice(0, 300) : null, $now: Date.now() });
  }

  deleteTriage(accountId, key) {
    this.s.deleteTriage.run(accountId, key);
  }
  triageOf(messageId) {
    return this.s.triageOf.get(messageId) || null;
  }
  deleteBody(messageId) {
    this.s.deleteBody.run(messageId);
  }

  messagesWithoutBody(folderId, maxSize, limit) {
    return this.s.withoutBody.all(folderId, maxSize, limit).map((r) => r.id);
  }
  allFolders(accountId) {
    return this.s.allFolders.all(accountId);
  }
  /** Lida/não lida localmente, ajustando o contador da pasta até a próxima sincronização. */
  setSeenLocal(rows, seen) {
    tx(this.db, () => {
      for (const m of rows) {
        if (!!m.seen === !!seen) continue;
        this.s.setSeen.run(seen ? 1 : 0, m.id);
        this.s.adjustUnread.run(seen ? -1 : 1, m.folder_id);
      }
    });
  }
  /** Marca como lidas todas as mensagens da pasta no banco do app. */
  markFolderRead(folderId) {
    tx(this.db, () => {
      this.db.prepare("UPDATE messages SET seen = 1 WHERE folder_id = ? AND seen = 0").run(folderId);
      this.db.prepare("UPDATE folders SET unread = 0 WHERE id = ?").run(folderId);
    });
  }
  setFlaggedLocal(rows, flagged) {
    tx(this.db, () => {
      for (const m of rows) this.s.setFlagged.run(flagged ? 1 : 0, m.id);
    });
  }
  removeLocal(rows) {
    tx(this.db, () => {
      for (const m of rows) {
        if (!m.seen) this.s.adjustUnread.run(-1, m.folder_id);
        this.s.deleteById.run(m.id);
      }
    });
  }
  messagesByIds(ids) {
    if (!ids.length) return [];
    const q = ids.map(() => "?").join(",");
    return this.db
      .prepare(`SELECT m.*, f.role, f.path AS folder_path, f.special_use FROM messages m
        JOIN folders f ON f.id = m.folder_id WHERE m.id IN (${q})`)
      .all(...ids);
  }

  /** Sugestões de destinatários: quem te escreveu e para quem você escreveu (peso maior). */
  contacts(q) {
    const like = String(q || "").trim().replace(/[\\%_]/g, (c) => "\\" + c);
    if (!like) return [];
    // Pela coluna "name" pode vir o nome de exibição; preferimos o mais recente não vazio
    return this.s.contacts.all({ $q: "%" + like + "%" }).map((r) => ({ name: r.name || "", address: r.address }));
  }

  getMessage(id) {
    return this.s.getMessage.get(id) || null;
  }

  /** Não lidas por conta e por pasta, a partir dos contadores que o servidor informa. */
  counts() {
    const byAccount = {};
    for (const r of this.s.counts.all()) {
      (byAccount[r.account_id] ||= {})[r.role] = r.unread || 0;
    }
    return byAccount;
  }

  // ---------- organização da caixa de entrada ----------
  organizeScan() {
    return this.s.organizeScan.all();
  }
  /** Tudo o que a classificação usa: cabeçalhos, corpo (se já baixado), risco e o estado atual da linha. */
  organizeLoad(ids) {
    if (!ids.length) return [];
    return this.db
      .prepare(
        `SELECT m.id, m.account_id, ${KEY} AS msg_key, f.role, m.subject, m.from_name, m.from_addr, m.to_json, m.cc_json,
          m.message_id, m.thread_key, m.seen, m.flagged, m.answered, m.snippet, m.hdr, m.date,
          b.message_id IS NOT NULL AS has_body, substr(b.text, 1, 8000) AS b_text, substr(b.html, 1, 60000) AS b_html,
          b.links AS b_links, b.headers AS b_headers, b.remote_images AS b_remote,
          t.det_level, t.det_score, t.signals, t.category AS llm_category,
          c.id AS cid, c.manual, c.train_label, c.train_weight, c.train_tokens, c.category AS old_category, c.grp AS old_grp
        FROM messages m JOIN folders f ON f.id = m.folder_id
        LEFT JOIN bodies b ON b.message_id = m.id
        ${JOIN_TRIAGE} ${JOIN_CLASS}
        WHERE m.id IN (${ids.map(() => "?").join(",")})`
      )
      .all(...ids);
  }
  saveClass(o) {
    this.s.saveClass.run({
      $account_id: o.account_id,
      $msg_key: o.msg_key,
      $category: o.category,
      $grp: o.grp,
      $confidence: o.confidence | 0,
      $source: o.source,
      $reason: o.reason || "",
      $manual: o.manual || null,
      $version: o.version,
      $gen: o.gen,
      $fp_class: o.fp_class,
      $fp_train: o.fp_train,
      $train_label: o.train.label || null,
      $train_weight: o.train.weight || 0,
      $train_tokens: o.train.tokens || null,
      $now: Date.now(),
    });
  }
  saveTrain(cid, fpTrain, t) {
    this.s.saveTrain.run(fpTrain, t.label || null, t.weight || 0, t.tokens || null, Date.now(), cid);
  }
  senderStats() {
    return this.s.senderStats.all();
  }
  /** Endereços para quem você já escreveu (pasta Enviados). */
  sentContacts() {
    return new Set(this.s.sentContacts.all().map((r) => r.a).filter(Boolean));
  }
  /** Contagens da Caixa de entrada por origem da decisão e por grupo. */
  classStats() {
    const out = { total: 0, read: 0, bySource: {}, byGroup: {} };
    for (const r of this.s.classStats.all()) {
      out.total += r.n;
      out.bySource[r.source] = (out.bySource[r.source] || 0) + r.n;
      if (r.seen) out.read += r.n;
      else out.byGroup[r.grp] = (out.byGroup[r.grp] || 0) + r.n;
    }
    return out;
  }
  /** Decisões por mensagem (confiança e motivo), para consultar em Configurações. */
  listClassifications({ q, group, source, limit = 50, offset = 0 }) {
    const where = ["f.role = 'inbox'"];
    const params = { $limit: Math.min(Math.max(limit | 0, 1), 200), $offset: Math.max(offset | 0, 0) };
    if (q && String(q).trim()) {
      params.$q = "%" + likeEscape(String(q).trim()) + "%";
      where.push("(m.subject LIKE $q ESCAPE '\\' OR m.from_name LIKE $q ESCAPE '\\' OR m.from_addr LIKE $q ESCAPE '\\')");
    }
    if (GROUPS.includes(group) && group !== "lidos") {
      params.$grp = group;
      where.push("coalesce(c.grp, 'outros') = $grp");
    }
    if (source) {
      params.$source = String(source);
      where.push("coalesce(c.source, 'pendente') = $source");
    }
    return this.db
      .prepare(
        `SELECT m.id, m.account_id, m.date, m.seen, m.subject, m.from_name, m.from_addr,
          coalesce(c.category, 'outros') AS category, coalesce(c.grp, 'outros') AS grp, coalesce(c.confidence, 0) AS confidence,
          coalesce(c.source, 'pendente') AS source, coalesce(c.reason, '') AS reason, c.manual
        FROM messages m JOIN folders f ON f.id = m.folder_id ${JOIN_CLASS}
        WHERE ${where.join(" AND ")} ORDER BY m.date DESC, m.id DESC LIMIT $limit OFFSET $offset`
      )
      .all(params);
  }
  /** Chaves de classificação das mensagens (em conversas: todas as da conversa na Caixa de entrada). */
  classKeysFor(ids, threads) {
    const out = new Map();
    for (const m of this.messagesByIds((ids || []).map(Number).filter(Number.isFinite))) {
      const list = threads && m.thread_key ? this.s.threadInbox.all(m.account_id, m.thread_key) : [];
      if (!list.length) list.push({ id: m.id, account_id: m.account_id, from_addr: m.from_addr, msg_key: m.message_id || `u:${m.folder_id}:${m.uid}` });
      for (const r of list) out.set(`${r.account_id}|${r.msg_key}`, r);
    }
    return [...out.values()];
  }
  setManual(keys, category) {
    tx(this.db, () => {
      for (const k of keys) this.s.setManual.run(k.account_id, k.msg_key, category || null, Date.now());
    });
  }
  /** Marca para refazer as mensagens de remetentes ("x@y.com") ou domínios ("@y.com"). */
  invalidateSenders(list) {
    const sub = `SELECT c.id FROM messages m JOIN inbox_class c ON c.account_id = m.account_id AND c.msg_key = ${KEY}`;
    const byAddr = this.db.prepare(`UPDATE inbox_class SET version = 0 WHERE id IN (${sub} WHERE m.from_addr = ?)`);
    const byDom = this.db.prepare(
      `UPDATE inbox_class SET version = 0 WHERE id IN (${sub} WHERE m.from_addr LIKE ? ESCAPE '\\' OR m.from_addr LIKE ? ESCAPE '\\')`
    );
    tx(this.db, () => {
      for (const raw of list || []) {
        const e = String(raw || "").trim().toLowerCase();
        if (!e) continue;
        if (e.includes("@") && !e.startsWith("@")) byAddr.run(e);
        else {
          const d = likeEscape(e.replace(/^@/, ""));
          byDom.run("%@" + d, "%." + d);
        }
      }
    });
  }
  /** "Redefinir aprendizado": esquece correções e rótulos de treino (as regras de remetente ficam). */
  resetLearning() {
    this.db.exec("UPDATE inbox_class SET manual = NULL, train_label = NULL, train_weight = 0, train_tokens = NULL, version = 0, gen = 0");
  }
  missingHdr(folderId, limit) {
    return this.s.missingHdr.all(folderId, limit).map((r) => r.uid);
  }
  setHdr(folderId, rows) {
    if (!rows.length) return;
    tx(this.db, () => {
      for (const [uid, hdr] of rows) this.s.setHdr.run(hdr, folderId, uid);
    });
  }

  // ---------- Prioritários (feedback Importante / Não importante) ----------
  _q(sql) {
    this._qc ||= new Map();
    if (!this._qc.has(sql)) this._qc.set(sql, this.db.prepare(sql));
    return this._qc.get(sql);
  }
  /** Mensagens da Caixa de entrada a pontuar (mais recentes primeiro), com o que já se sabe delas. */
  priorityCandidates({ since, limit, ids }) {
    const where = ids ? `m.id IN (${ids.map(Number).filter(Number.isFinite).join(",") || 0})` : "m.date >= $since";
    const sql = `SELECT m.id, m.account_id, ${KEY} AS msg_key, m.subject, m.from_name, m.from_addr, m.date, m.seen, m.flagged,
        m.answered, m.snippet, substr(b.text, 1, 1500) AS text, coalesce(c.grp, 'outros') AS grp, c.category AS category,
        ${RISK} AS risk, ps.score AS old_score, ps.source AS old_source, ps.reason AS old_reason, ps.base AS old_base,
        ps.llm_verdict, ps.llm_reason, ps.llm_at
      FROM messages m JOIN folders f ON f.id = m.folder_id AND f.role = 'inbox'
      LEFT JOIN bodies b ON b.message_id = m.id ${JOIN_CLASS} ${JOIN_TRIAGE}
      LEFT JOIN priority_score ps ON ps.account_id = m.account_id AND ps.msg_key = ${KEY}
      WHERE ${where} GROUP BY m.id ORDER BY m.date DESC LIMIT $limit`;
    return this.db.prepare(sql).all(ids ? { $limit: ids.length || 1 } : { $since: since, $limit: limit });
  }
  /** A mensagem para gravar o feedback (em qualquer pasta), com até 3000 caracteres do texto. */
  priorityMessage(id) {
    return this._q(`SELECT m.id, m.account_id, ${KEY} AS msg_key, m.subject, m.from_name, m.from_addr, m.date, m.snippet, m.seen,
        substr(b.text, 1, 3000) AS text, b.html IS NOT NULL AS has_body
      FROM messages m LEFT JOIN bodies b ON b.message_id = m.id WHERE m.id = ?`).get(Number(id));
  }
  getPriorityFeedback(accountId, key) {
    return this._q("SELECT * FROM priority_feedback WHERE account_id = ? AND msg_key = ?").get(accountId, key) || null;
  }
  setPriorityFeedback(f) {
    this._q(`INSERT INTO priority_feedback (account_id, msg_key, message_id, from_addr, domain, subject, topics, embedding, label, adjust, created_at)
      VALUES ($a, $k, $mid, $from, $dom, $subj, $topics, $emb, $label, $adjust, $now)
      ON CONFLICT (account_id, msg_key) DO UPDATE SET message_id = $mid, from_addr = $from, domain = $dom, subject = $subj,
        topics = $topics, embedding = $emb, label = $label, adjust = $adjust, created_at = $now`).run(f);
  }
  deletePriorityFeedback(accountId, key) {
    this._q("DELETE FROM priority_feedback WHERE account_id = ? AND msg_key = ?").run(accountId, key);
  }
  /** Feedbacks mais recentes (o modelo é montado com eles em memória). */
  listPriorityFeedback(limit = 2000) {
    return this._q("SELECT * FROM priority_feedback ORDER BY created_at DESC LIMIT ?").all(limit);
  }
  clearPriorityFeedback() {
    this.db.exec("DELETE FROM priority_feedback; DELETE FROM priority_activity; UPDATE priority_score SET llm_verdict = NULL, llm_reason = NULL, llm_at = NULL;");
  }
  /** Grava uma ação (uma vez por mensagem e tipo). Retorna false se já existia. */
  addPriorityActivity(a) {
    return this._q(`INSERT OR IGNORE INTO priority_activity (account_id, msg_key, message_id, action, points, from_addr, domain, topics, created_at)
      VALUES ($a, $k, $mid, $action, $points, $from, $dom, $topics, $now)`).run(a).changes > 0;
  }
  removePriorityActivity(accountId, key, action) {
    this._q("DELETE FROM priority_activity WHERE account_id = ? AND msg_key = ? AND action = ?").run(accountId, key, action);
  }
  listPriorityActivity(limit = 20000) {
    return this._q("SELECT * FROM priority_activity ORDER BY created_at DESC LIMIT ?").all(limit);
  }
  getPriorityScore(accountId, key) {
    return this._q("SELECT * FROM priority_score WHERE account_id = ? AND msg_key = ?").get(accountId, key) || null;
  }
  savePriorityScores(rows) {
    if (!rows.length) return;
    const st = this._q(`INSERT INTO priority_score (account_id, msg_key, score, base, manual, activity, source, reason, llm_verdict, llm_reason, llm_at, updated_at)
      VALUES ($a, $k, $score, $base, $manual, $activity, $source, $reason, $lv, $lr, $lat, $now)
      ON CONFLICT (account_id, msg_key) DO UPDATE SET score = $score, base = $base, manual = $manual, activity = $activity,
        source = $source, reason = $reason, llm_verdict = $lv, llm_reason = $lr, llm_at = $lat, updated_at = $now`);
    tx(this.db, () => {
      for (const r of rows) st.run(r);
    });
  }
  priorityCounts(threshold) {
    return this._q(`SELECT count(*) AS scored, sum(score >= $t) AS above, sum(source = 'llm') AS llm,
        (SELECT count(*) FROM priority_feedback WHERE label = 1) AS pos, (SELECT count(*) FROM priority_feedback WHERE label = -1) AS neg
      FROM priority_score`).get({ $t: threshold });
  }
}

module.exports = { Store, ROLES, GROUPS };
