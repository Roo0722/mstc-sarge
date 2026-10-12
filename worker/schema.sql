-- D1 schema for mstc-chat. Run once: npm run db:init (remote) or npm run db:init:local.
-- Only nickname, role and a hashed token are stored for each member. Chat messages are NOT in D1: they live in the
-- room's Durable Object and are deleted after ~48 hours.

CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  nickname     TEXT NOT NULL,
  nickname_key TEXT NOT NULL UNIQUE,   -- look-alike-proof form ("J0hn" = "john")
  role         TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','coach','admin')),
  token_hash   TEXT NOT NULL UNIQUE,   -- SHA-256 of the secret token kept on the phone
  invite_id    TEXT,
  banned       INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS invites (
  id         TEXT PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,     -- 8 characters, shown as MSTC-XXXX-XXXX
  role       TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','coach','admin')),
  max_uses   INTEGER NOT NULL DEFAULT 1,
  uses       INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  revoked    INTEGER NOT NULL DEFAULT 0,
  note       TEXT,
  created_at INTEGER NOT NULL
);

-- blocked = enforced, watch = observed only, safe = never flagged (set by devs only)
CREATE TABLE IF NOT EXISTS words (
  word     TEXT NOT NULL,
  state    TEXT NOT NULL CHECK (state IN ('blocked','watch','safe')),
  lang     TEXT NOT NULL DEFAULT 'all',
  severity INTEGER NOT NULL DEFAULT 2,
  source   TEXT NOT NULL DEFAULT 'admin',
  added_at INTEGER NOT NULL,
  PRIMARY KEY (word, state)
);

-- failed sign-up attempts per (hashed) IP, to stop invite-code guessing
CREATE TABLE IF NOT EXISTS attempts (
  key      TEXT PRIMARY KEY,
  n        INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);
