-- server/schema.sql
--
-- SQLite schema for the local buzzer system (DESIGN.md §7).
--
-- SQLite is used for persistence, recovery, and audit. It is NOT in the buzz
-- hot path: the in-memory `currentRound` decides the winner; these tables are
-- written behind (after broadcasting the result). All `*_at` columns are
-- server-clock milliseconds (the server's monotonic performance.now() origin),
-- stored as REAL.

CREATE TABLE IF NOT EXISTS teams (
  id          TEXT PRIMARY KEY,         -- uuid/short id
  name        TEXT NOT NULL,
  color       TEXT NOT NULL,            -- hex
  banner_url  TEXT,                     -- optional local asset path
  slot        INTEGER NOT NULL          -- 1..4 display order / tablet binding
);

CREATE TABLE IF NOT EXISTS rounds (
  id              TEXT PRIMARY KEY,
  question_number INTEGER NOT NULL,
  opened_at       REAL NOT NULL,        -- server clock (ms)
  status          TEXT NOT NULL,        -- 'open' | 'buzzed' | 'reset'
  winner_team_id  TEXT,                 -- FK teams.id
  winner_press_at REAL,                 -- server clock (ms)
  closed_at       REAL
);

CREATE TABLE IF NOT EXISTS buzzes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id        TEXT NOT NULL,        -- FK rounds.id
  team_id         TEXT NOT NULL,        -- FK teams.id
  press_at        REAL NOT NULL,        -- edge timestamp, server clock (ms)
  received_at     REAL NOT NULL,        -- when server got it (ms)
  rtt_ms          REAL,                 -- last measured RTT for that client
  accepted        INTEGER NOT NULL,     -- 1 winner-eligible, 0 rejected
  reject_reason   TEXT,                 -- 'too_late' | 'false_start' | 'duplicate' | null
  rank            INTEGER               -- final ordering within the round
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL                   -- e.g. settling_window_ms = "50"
);
