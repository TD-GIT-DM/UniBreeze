-- UniBreeze D1 schema (v1: tracker + worksheet import)
-- Apply remote:   npx wrangler d1 execute unibreeze-db --remote --file=./schema.sql
-- (or applied via the Cloudflare D1 API). All statements are idempotent.

-- Users ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,   -- PBKDF2 derived key (hex)
  salt          TEXT NOT NULL,   -- per-user random salt (hex)
  display_name  TEXT,
  grad_year     INTEGER,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Sessions ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,           -- random 256-bit hex
  user_id    INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Schools / colleges on the student's list ----------------------------------
CREATE TABLE IF NOT EXISTS schools (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL,
  name          TEXT NOT NULL,
  platform      TEXT,                    -- commonapp | uc | coalition | direct | other
  app_round     TEXT,                    -- ED | EA | REA | RD | rolling
  deadline      TEXT,                    -- ISO date (YYYY-MM-DD)
  status        TEXT NOT NULL DEFAULT 'considering', -- considering | applying | submitted | accepted | rejected | deferred | waitlisted
  notes         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_schools_user ON schools(user_id);

-- Tasks / checklist items ---------------------------------------------------
CREATE TABLE IF NOT EXISTS tasks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL,
  school_id    INTEGER,                  -- nullable: general (non-school) task
  title        TEXT NOT NULL,
  details      TEXT,                     -- description / instructions
  category     TEXT,                     -- essay | form | testing | recommendation | financial-aid | activity | deadline | other
  due_date     TEXT,                     -- ISO date
  status       TEXT NOT NULL DEFAULT 'todo', -- todo | in_progress | done
  priority     INTEGER NOT NULL DEFAULT 2,    -- 1 high, 2 normal, 3 low
  tips         TEXT,                     -- AI-generated tips / how-to
  source       TEXT NOT NULL DEFAULT 'manual', -- manual | import:<filename> | canvas
  source_url   TEXT,
  ext_id       TEXT,                     -- external id for sync dedupe (e.g. canvas:<uid>)
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_school ON tasks(school_id);

-- Documents (worksheets etc.) stored in R2 ----------------------------------
CREATE TABLE IF NOT EXISTS documents (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL,
  r2_key       TEXT NOT NULL,
  filename     TEXT NOT NULL,
  content_type TEXT,
  size         INTEGER,
  parsed       INTEGER NOT NULL DEFAULT 0,  -- 0/1 whether tasks were extracted
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user_id);

-- External integrations (e.g. Canvas LMS) ----------------------------------
CREATE TABLE IF NOT EXISTS integrations (
  user_id      INTEGER NOT NULL,
  type         TEXT NOT NULL,            -- 'canvas'
  base_url     TEXT,                     -- e.g. https://school.instructure.com
  ics_url      TEXT,                     -- private calendar feed (read-only)
  token        TEXT,                     -- access token (optional, richer)
  last_synced  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, type),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tasks_extid ON tasks(user_id, ext_id);
