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
  // v5 (fase 6): agente de triagem
  `
  ALTER TABLE bodies ADD COLUMN headers TEXT;   -- cabeçalhos relevantes para segurança (JSON)
  ALTER TABLE bodies ADD COLUMN links TEXT;     -- [{href, text}] extraídos do HTML original
  ALTER TABLE accounts ADD COLUMN triage_enabled INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE accounts ADD COLUMN triage_shadow INTEGER NOT NULL DEFAULT 1; -- modo sombra: só rotula

  -- Uma linha por mensagem (pelo Message-ID): mover entre pastas não reprocessa
  CREATE TABLE triage (
    id              INTEGER PRIMARY KEY,
    account_id      INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    msg_key         TEXT NOT NULL,
    status          TEXT NOT NULL,            -- done | error
    det_score       INTEGER NOT NULL DEFAULT 0,
    det_level       TEXT NOT NULL DEFAULT 'ok', -- ok | atencao | suspeito | perigoso
    signals         TEXT NOT NULL DEFAULT '[]', -- [{id, severity, weight, detail}]
    av_status       TEXT,                     -- clean | infected | skipped | unavailable | error
    category        TEXT,                     -- (6b) importante | notificacao | promocao | suspeito | incerto
    priority        INTEGER,
    risk            INTEGER,
    reason          TEXT,
    action          TEXT,
    summary         TEXT,
    llm_json        TEXT,
    model           TEXT,
    prompt_version  TEXT,
    pipeline_version TEXT NOT NULL,
    feedback        TEXT,
    error           TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    UNIQUE (account_id, msg_key)
  );
  CREATE INDEX triage_level ON triage (det_level);
  `,
  // v6 (fase 6b): agente LLM
  `
  ALTER TABLE accounts ADD COLUMN triage_allow_free INTEGER NOT NULL DEFAULT 0; -- liberar modelos gratuitos
  ALTER TABLE triage ADD COLUMN confidence INTEGER;
  ALTER TABLE triage ADD COLUMN deadlines TEXT;
  ALTER TABLE triage ADD COLUMN llm_attempts INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE triage ADD COLUMN llm_retry_at INTEGER;
  CREATE INDEX triage_category ON triage (category);
  `,
  // v7: organização da caixa de entrada em grupos virtuais (Importante, Propaganda, Outros, Suspeitos, Já lidos).
  // Nada disso vai para o servidor: é só o cache local que decide onde cada mensagem aparece.
  `
  -- Cabeçalhos de lista/envio em massa (JSON). NULL = ainda não baixados; '{}' = baixados e ausentes
  ALTER TABLE messages ADD COLUMN hdr TEXT;
  CREATE INDEX messages_from ON messages (from_addr);

  -- Uma linha por mensagem (pela mesma chave da triagem: Message-ID), então mover entre pastas não reclassifica
  CREATE TABLE inbox_class (
    id           INTEGER PRIMARY KEY,
    account_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    msg_key      TEXT NOT NULL,
    category     TEXT,                       -- importante | propaganda | outros (decisão do classificador)
    grp          TEXT,                       -- onde aparece enquanto não lida: a categoria, ou 'suspeito' (análise de risco)
    confidence   INTEGER NOT NULL DEFAULT 0, -- 0 a 100
    source       TEXT NOT NULL DEFAULT 'pendente', -- manual | remetente | reputacao | regra | modelo | padrao
    reason       TEXT NOT NULL DEFAULT '',   -- motivo curto, em português
    manual       TEXT,                       -- categoria escolhida por você (arrastar / Mover para): vence tudo
    version      INTEGER NOT NULL DEFAULT 0, -- "Reclassificar tudo" sobe a versão e o processo refaz tudo
    gen          INTEGER NOT NULL DEFAULT 0, -- geração do modelo/reputação usada na decisão
    fp_class     TEXT,                       -- entradas da classificação (respondida, favorita, cabeçalhos, corpo, conversa)
    fp_train     TEXT,                       -- entradas só do treino (lida, pasta, risco)
    train_label  TEXT,                       -- rótulo com que a mensagem entrou no modelo (para desfazer se mudar)
    train_weight REAL NOT NULL DEFAULT 0,
    train_tokens TEXT,                       -- palavras usadas no treino (para desfazer exatamente)
    updated_at   INTEGER NOT NULL,
    UNIQUE (account_id, msg_key)
  );
  CREATE INDEX inbox_class_grp ON inbox_class (grp);

  -- Classificador Naive Bayes local: contagem de cada palavra por classe (aprendizado incremental)
  CREATE TABLE nb_tokens (
    token TEXT PRIMARY KEY,
    imp   REAL NOT NULL DEFAULT 0,
    prop  REAL NOT NULL DEFAULT 0,
    outr  REAL NOT NULL DEFAULT 0
  ) WITHOUT ROWID;
  `,
  // v8: Prioritários. Feedback "Importante / Não importante" dado na leitura e a pontuação de relevância de cada e-mail
  `
  CREATE TABLE priority_feedback (
    id         INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    msg_key    TEXT NOT NULL,                -- Message-ID (sobrevive a mover de pasta)
    message_id INTEGER,                      -- id da mensagem no app quando o feedback foi dado
    from_addr  TEXT NOT NULL DEFAULT '',
    domain     TEXT NOT NULL DEFAULT '',
    subject    TEXT NOT NULL DEFAULT '',
    topics     TEXT NOT NULL DEFAULT '[]',   -- palavras-chave extraídas (JSON)
    embedding  BLOB,                         -- vetor do conteúdo (Float32, 256 dimensões, local)
    label      INTEGER NOT NULL,             -- 1 importante, -1 não importante
    created_at INTEGER NOT NULL,
    UNIQUE (account_id, msg_key)
  );
  CREATE INDEX priority_feedback_from ON priority_feedback (from_addr);

  CREATE TABLE priority_score (
    account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    msg_key     TEXT NOT NULL,
    score       INTEGER NOT NULL,            -- 0..100
    source      TEXT NOT NULL,               -- padrao | aprendido | llm | feedback
    reason      TEXT,
    llm_verdict INTEGER,                     -- opinião do LLM nos casos ambíguos: 0..100 (null = não consultado)
    llm_reason  TEXT,
    llm_at      INTEGER,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (account_id, msg_key)
  ) WITHOUT ROWID;
  CREATE INDEX priority_score_score ON priority_score (score);
  `,
  // v9: Prioritários com ajuste manual (+10/-10) separado da nota calculada e pontos pela atividade no e-mail
  `
  ALTER TABLE priority_feedback ADD COLUMN adjust INTEGER NOT NULL DEFAULT 0;   -- +10 importante, -10 não importante
  UPDATE priority_feedback SET adjust = label * 10;
  ALTER TABLE priority_score ADD COLUMN base INTEGER;                          -- nota calculada (regras + aprendido + LLM)
  ALTER TABLE priority_score ADD COLUMN manual INTEGER NOT NULL DEFAULT 0;     -- ajuste manual (somado na exibição)
  ALTER TABLE priority_score ADD COLUMN activity INTEGER NOT NULL DEFAULT 0;   -- pontos de atividade, com queda por idade

  CREATE TABLE priority_activity (
    id         INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    msg_key    TEXT NOT NULL,
    message_id INTEGER,
    action     TEXT NOT NULL,                -- open, read, reply, forward, flag, attachment, link, delete_unopened, archive_unread
    points     INTEGER NOT NULL,
    from_addr  TEXT NOT NULL DEFAULT '',
    domain     TEXT NOT NULL DEFAULT '',
    topics     TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    UNIQUE (account_id, msg_key, action)
  );
  `,
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
