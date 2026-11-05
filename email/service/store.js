// Todas as consultas ao cache local ficam aqui.
const { tx } = require("./db");

const ROLES = ["inbox", "sent", "drafts", "archive", "junk", "trash"];

// Campos de conta que podem ir para a interface (nunca o segredo)
const PUBLIC_ACCOUNT = `id, email, name, provider, auth, username, imap_host, imap_port, imap_secure,
  smtp_host, smtp_port, smtp_secure, color, signature, auto_images, sender_name, position, last_sync_at`;

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
      updateAccountInfo: p("UPDATE accounts SET name = ?, color = ?, signature = ?, auto_images = ?, sender_name = ? WHERE id = ?"),
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
        has_attachments, labels)
        VALUES ($account_id, $folder_id, $uid, $message_id, $in_reply_to, $refs, $thread_key,
        $subject, $from_name, $from_addr, $to_json, $cc_json, $reply_to_json, $date, $size, $seen, $flagged,
        $answered, $draft, $has_attachments, $labels)
        ON CONFLICT(folder_id, uid) DO UPDATE SET seen = excluded.seen, flagged = excluded.flagged,
          answered = excluded.answered, draft = excluded.draft, labels = excluded.labels`),
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
      saveBody: p(`INSERT INTO bodies (message_id, html, text, remote_images, attachments, truncated, fetched_at)
        VALUES ($message_id, $html, $text, $remote_images, $attachments, $truncated, $fetched_at)
        ON CONFLICT(message_id) DO UPDATE SET html = excluded.html, text = excluded.text,
          remote_images = excluded.remote_images, attachments = excluded.attachments,
          truncated = excluded.truncated, fetched_at = excluded.fetched_at`),
      setSnippet: p("UPDATE messages SET snippet = ? WHERE id = ?"),
      withoutBody: p(`SELECT m.id FROM messages m LEFT JOIN bodies b ON b.message_id = m.id
        WHERE m.folder_id = ? AND b.message_id IS NULL AND (m.size IS NULL OR m.size <= ?)
        ORDER BY m.date DESC LIMIT ?`),
      setSeen: p("UPDATE messages SET seen = ? WHERE id = ?"),
      setFlagged: p("UPDATE messages SET flagged = ? WHERE id = ?"),
      deleteById: p("DELETE FROM messages WHERE id = ?"),
      adjustUnread: p("UPDATE folders SET unread = max(0, unread + ?) WHERE id = ?"),
      allFolders: p("SELECT id, path, name, role, special_use, delimiter FROM folders WHERE account_id = ? ORDER BY path"),
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
  updateAccountInfo(id, { name, color, signature, autoImages, senderName }) {
    this.s.updateAccountInfo.run(name, color, signature, autoImages ? 1 : 0, senderName || "", id);
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
   * Caixa unificada: mensagens de todas as contas (ou de uma), ordenadas por data.
   * Paginação por cursor (date, id) para não ficar lenta com caixas grandes.
   */
  listMessages({ accountId, role = "inbox", unread, attachments, flagged, q, cursor, limit = 100, threads = true }) {
    const where = ["f.role = $role"];
    const params = { $role: ROLES.includes(role) ? role : "inbox", $limit: Math.min(Math.max(limit | 0, 1), 500) };
    if (accountId) {
      where.push("m.account_id = $account");
      params.$account = accountId;
    }
    if (unread) where.push("m.seen = 0");
    if (attachments) where.push("m.has_attachments = 1");
    if (flagged) where.push("m.flagged = 1");
    if (q && String(q).trim()) {
      // Fase 1: busca simples em assunto/remetente/destinatários. Fase 4 troca por FTS5.
      params.$q = "%" + String(q).trim().replace(/[\\%_]/g, (c) => "\\" + c) + "%";
      where.push(
        "(m.subject LIKE $q ESCAPE '\\' OR m.from_name LIKE $q ESCAPE '\\' OR m.from_addr LIKE $q ESCAPE '\\' OR m.to_json LIKE $q ESCAPE '\\')"
      );
    }
    const cursorWhere = [];
    if (cursor && Number.isFinite(cursor.date) && Number.isFinite(cursor.id)) {
      cursorWhere.push("(m.date < $cdate OR (m.date = $cdate AND m.id < $cid))");
      params.$cdate = cursor.date;
      params.$cid = cursor.id;
    }
    const cols = `m.id, m.account_id, m.subject, m.from_name, m.from_addr, m.to_json, m.date, m.seen,
        m.flagged, m.answered, m.has_attachments, m.snippet, m.thread_key`;
    if (!threads) {
      const sql = `SELECT ${cols}, 1 AS thread_count FROM messages m JOIN folders f ON f.id = m.folder_id
        WHERE ${where.concat(cursorWhere).join(" AND ")}
        ORDER BY m.date DESC, m.id DESC LIMIT $limit`;
      return this.db.prepare(sql).all(params);
    }
    // Conversas: uma linha por thread (a mensagem mais recente), com totais da conversa
    const sql = `WITH t AS (
        SELECT ${cols},
          row_number() OVER w AS rn,
          count(*) OVER p AS thread_count,
          max(m.seen = 0) OVER p AS thread_unread,
          max(m.flagged) OVER p AS thread_flagged,
          max(m.has_attachments) OVER p AS thread_attachments
        FROM messages m JOIN folders f ON f.id = m.folder_id
        WHERE ${where.join(" AND ")}
        WINDOW p AS (PARTITION BY m.account_id, m.thread_key),
               w AS (PARTITION BY m.account_id, m.thread_key ORDER BY m.date DESC, m.id DESC)
      )
      SELECT id, account_id, subject, from_name, from_addr, to_json, date,
        CASE WHEN thread_unread THEN 0 ELSE 1 END AS seen,
        thread_flagged AS flagged, answered, thread_attachments AS has_attachments, snippet, thread_key, thread_count
      FROM t m WHERE rn = 1 ${cursorWhere.length ? "AND " + cursorWhere.join(" AND ") : ""}
      ORDER BY m.date DESC, m.id DESC LIMIT $limit`;
    return this.db.prepare(sql).all(params);
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
      $fetched_at: Date.now(),
    });
    if (b.snippet != null) this.s.setSnippet.run(b.snippet, b.messageId);
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
}

module.exports = { Store, ROLES };
