// DDL 来自 docs/superpowers/specs/2026-10-26-offline-sync-design.md §7.3，修改需同步 spec。
export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  scope_id TEXT NOT NULL,
  key      TEXT NOT NULL,
  value    TEXT,
  PRIMARY KEY (scope_id, key)
);
-- key: schema_version | last_synced_at | last_sync_error | api_version | server_version

CREATE TABLE IF NOT EXISTS transactions (
  scope_id          TEXT NOT NULL,
  id                TEXT NOT NULL,       -- 服务端 group id，或 'local:<uuid>'
  payload           TEXT NOT NULL,       -- { id, attributes: { groupTitle, transactions[] } }
  occurred_at       TEXT NOT NULL,       -- 首笔 split 的 date（ISO8601）
  server_updated_at TEXT,                -- 组内所有 split 的 updated_at 最大值
  dirty             INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope_id, id)
);
CREATE INDEX IF NOT EXISTS idx_tx_scope_date ON transactions(scope_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS blobs (
  scope_id   TEXT NOT NULL,
  key        TEXT NOT NULL,
  payload    TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (scope_id, key)
);

CREATE TABLE IF NOT EXISTS outbox (
  scope_id        TEXT NOT NULL,
  id              TEXT PRIMARY KEY,      -- uuid
  op              TEXT NOT NULL,         -- create | update
  entity_id       TEXT NOT NULL,         -- group id 或 local:<uuid>
  base_updated_at TEXT,                  -- 编辑开始时的组级 server_updated_at；新建为 NULL
  payload         TEXT NOT NULL,
  status          TEXT NOT NULL,         -- pending | sent | conflict | failed
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(scope_id, status, created_at);

CREATE TABLE IF NOT EXISTS notices (
  scope_id        TEXT NOT NULL,
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,     -- conflict | server_deletion
  entity_id       TEXT NOT NULL,
  local_payload   TEXT,              -- conflict: 本地版本；server_deletion: NULL
  server_payload  TEXT,              -- conflict: 服务端版本；server_deletion: 被删交易
  detected_at     TEXT NOT NULL,
  acknowledged_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_notices_pending ON notices(scope_id, acknowledged_at);
`;
