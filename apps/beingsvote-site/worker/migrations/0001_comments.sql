-- Off-chain public comments. Not a blockchain table.
-- The Worker also creates this table on first use. Apply the migration before relying on that.
-- Each statement is one line so a line-oriented SQL runner does not split the CREATE TABLE.
CREATE TABLE IF NOT EXISTS comments (id TEXT PRIMARY KEY, body TEXT NOT NULL, display_name TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, created_at INTEGER NOT NULL, ip_hash TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS comments_status_created ON comments (status, created_at, id);
CREATE INDEX IF NOT EXISTS comments_ip_created ON comments (ip_hash, created_at);
