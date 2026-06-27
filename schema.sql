-- UniBreeze D1 schema
-- Apply locally:  npx wrangler d1 execute unibreeze-db --local --file=./schema.sql
-- Apply remote:   npx wrangler d1 execute unibreeze-db --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
