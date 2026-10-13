CREATE TABLE IF NOT EXISTS monitor (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  state TEXT NOT NULL DEFAULT '{}',
  lock_until INTEGER NOT NULL DEFAULT 0,
  lock_token TEXT
);
INSERT OR IGNORE INTO monitor (id) VALUES (1);

CREATE TABLE IF NOT EXISTS query_history (
 id TEXT PRIMARY KEY, at INTEGER NOT NULL, ended_at INTEGER NOT NULL,
 healthy INTEGER NOT NULL, http_status INTEGER, blocked INTEGER NOT NULL, snapshot TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS query_history_at ON query_history(at DESC);
CREATE TABLE IF NOT EXISTS stock_history (
 id TEXT PRIMARY KEY, at INTEGER NOT NULL, source TEXT NOT NULL, changes TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS stock_history_at ON stock_history(at DESC);
CREATE TABLE IF NOT EXISTS notification_history (
 id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 type TEXT NOT NULL, targets TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS notification_history_at ON notification_history(created_at DESC);
