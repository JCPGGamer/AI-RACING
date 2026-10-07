-- EvoRace — ranking público
-- Somente o processo de validação escreve em records/replays.

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nickname TEXT NOT NULL,
  nickname_key TEXT NOT NULL UNIQUE,
  pass_salt TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  track_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  rules_version TEXT NOT NULL,
  pilot_name TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('aguardando', 'validando', 'aprovado', 'nao_concluiu', 'rejeitado', 'erro_temporario')),
  official_time REAL,
  official_progress REAL,
  message TEXT,
  improved INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX idx_sub_user ON submissions(user_id, created_at DESC);
CREATE INDEX idx_sub_status ON submissions(status, created_at);

CREATE TABLE replays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL UNIQUE REFERENCES submissions(id),
  meta TEXT NOT NULL,
  frames TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  track_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  rules_version TEXT NOT NULL,
  time REAL NOT NULL,
  pilot_name TEXT NOT NULL,
  submission_id INTEGER NOT NULL REFERENCES submissions(id),
  replay_id INTEGER REFERENCES replays(id),
  achieved_at INTEGER NOT NULL,
  UNIQUE (user_id, track_id, category_id, rules_version)
);
CREATE INDEX idx_records_board ON records(track_id, category_id, rules_version, time, achieved_at);
