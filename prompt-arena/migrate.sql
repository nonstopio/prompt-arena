-- Run this once against an already-deployed database to add per-player timers.
-- Existing rounds and submissions are left untouched.
CREATE TABLE IF NOT EXISTS players (
  round_id    TEXT NOT NULL,
  name_key    TEXT NOT NULL,
  player_name TEXT NOT NULL,
  joined_at   INTEGER NOT NULL,
  PRIMARY KEY (round_id, name_key)
);
