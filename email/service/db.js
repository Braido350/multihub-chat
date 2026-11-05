// Cache local (SQLite embutido no Node do Electron: sem módulo nativo para compilar).
// Os servidores IMAP continuam sendo a fonte da verdade; aqui fica só o necessário
// para a caixa unificada, os filtros e a busca serem rápidos.
const { DatabaseSync } = require("node:sqlite");
const path = require("path");
const fs = require("fs");

const MIGRATIONS = [
  // v1
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE accounts (
    id           INTEGER PRIMARY KEY,
    email        TEXT NOT NULL,
    name         TEXT NOT NULL,
    provider     TEXT NOT NULL,             -- gmail | locaweb | imap
    auth         TEXT NOT NULL,             -- password | oauth-google
    username     TEXT NOT NULL,
    imap_host    TEXT NOT NULL,
    imap_port    INTEGER NOT NULL,
    imap_secure  INTEGER NOT NULL,
    smtp_host    TEXT NOT NULL,
    smtp_port    INTEGER NOT NULL,
    smtp_secure  INTEGER NOT NULL,          -- 1 = TLS direto (465), 0 = STARTTLS (587)
    secret       TEXT NOT NULL,             -- JSON criptografado pelo safeStorage (base64)
    color        TEXT NOT NULL,
    signature    TEXT NOT NULL DEFAULT '',
    position     INTEGER NOT NULL DEFAULT 0,
    last_sync_at INTEGER,
    created_at   INTEGER NOT NULL
  );

  CREATE TABLE folders (
    id             INTEGER PRIMARY KEY,
    account_id     INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    path           TEXT NOT NULL,
    name           TEXT NOT NULL,
    delimiter      TEXT,
    special_use    TEXT,                    -- \\Inbox, \\Sent, \\All... como o servidor informa
    role           TEXT,                    -- inbox | sent | drafts | archive | junk | trash
    uidvalidity    TEXT,
    uidnext        INTEGER,
    highest_modseq TEXT,
    last_uid       INTEGER NOT NULL DEFAULT 0,
    total          INTEGER NOT NULL DEFAULT 0,
    unread         INTEGER NOT NULL DEFAULT 0,
    synced_at      INTEGER,
    UNIQUE (account_id, path)
  );

  CREATE TABLE messages (
    id              INTEGER PRIMARY KEY,
    account_id      INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    folder_id       INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    uid             INTEGER NOT NULL,
    message_id      TEXT,
    in_reply_to     TEXT,
    refs            TEXT,
    thread_key      TEXT,
    subject         TEXT NOT NULL DEFAULT '',
    from_name       TEXT NOT NULL DEFAULT '',
    from_addr       TEXT NOT NULL DEFAULT '',
    to_json         TEXT NOT NULL DEFAULT '[]',
    cc_json         TEXT NOT NULL DEFAULT '[]',
    reply_to_json   TEXT NOT NULL DEFAULT '[]',
    date            INTEGER NOT NULL,
    size            INTEGER,
    seen            INTEGER NOT NULL DEFAULT 0,
    flagged         INTEGER NOT NULL DEFAULT 0,
    answered        INTEGER NOT NULL DEFAULT 0,
    draft           INTEGER NOT NULL DEFAULT 0,
    has_attachments INTEGER NOT NULL DEFAULT 0,
    snippet         TEXT,
    labels          TEXT,
    UNIQUE (folder_id, uid)
  );
  CREATE INDEX messages_folder_date ON messages (folder_id, date DESC, id DESC);
  CREATE INDEX messages_date ON messages (date DESC, id DESC);
  CREATE INDEX messages_thread ON messages (account_id, thread_key);
  `,
  // v2 (fase 2): corpo já sanitizado e lista de anexos, baixados sob demanda
  `
  CREATE TABLE bodies (
    message_id    INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    html          TEXT,                    -- HTML sanitizado (imagens remotas desativadas)
    text          TEXT,
    remote_images INTEGER NOT NULL DEFAULT 0,
    attachments   TEXT NOT NULL DEFAULT '[]', -- [{part, filename, contentType, size, cid, inline}]
    truncated     INTEGER NOT NULL DEFAULT 0,
    fetched_at    INTEGER NOT NULL
  );
  `,
  // v3: carregar imagens remotas automaticamente (escolha por conta, desligado por padrão)
  `ALTER TABLE accounts ADD COLUMN auto_images INTEGER NOT NULL DEFAULT 0;`,
  // v4 (fase 3): nome que aparece para quem recebe ("De: Paulo Gabriel <...>")
  `ALTER TABLE accounts ADD COLUMN sender_name TEXT NOT NULL DEFAULT '';`,
];

function open(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "mail.db"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;");

  const version = db.prepare("PRAGMA user_version").get().user_version;
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return db;
}

function tx(db, fn) {
  db.exec("BEGIN");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

module.exports = { open, tx };
