DROP TABLE IF EXISTS submissions;
DROP TABLE IF EXISTS rounds;

CREATE TABLE rounds (
  id            TEXT PRIMARY KEY,
  secret_prompt TEXT NOT NULL,
  image_b64     TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'draft',   -- draft | live | closed | published | aborted
  started_at    INTEGER,
  ends_at       INTEGER,
  created_at    INTEGER NOT NULL,
  winner_id     TEXT,
  verdict       TEXT,                            -- why the winning prompt won
  judged_at     INTEGER
);

CREATE TABLE submissions (
  id           TEXT PRIMARY KEY,
  round_id     TEXT NOT NULL,
  player_name  TEXT NOT NULL,
  name_key     TEXT NOT NULL,                    -- lowercased, for one-entry-per-person
  prompt       TEXT NOT NULL,
  image_b64    TEXT,
  score        INTEGER,                          -- after penalties; what the board sorts on
  raw_score    INTEGER,                          -- what the judge gave, before penalties
  edits        INTEGER NOT NULL DEFAULT 0,      -- revisions used, hard limit of 2
  notes        TEXT,                             -- judge's per-prompt comment
  created_at   INTEGER NOT NULL
);

CREATE UNIQUE INDEX one_entry_per_person ON submissions (round_id, name_key);
CREATE INDEX subs_by_round ON submissions (round_id);
CREATE INDEX rounds_by_created ON rounds (created_at DESC);

CREATE TABLE players (
  round_id    TEXT NOT NULL,
  name_key    TEXT NOT NULL,
  player_name TEXT NOT NULL,
  joined_at   INTEGER NOT NULL,
  draft       TEXT,
  blur_count   INTEGER NOT NULL DEFAULT 0,
  away_since   INTEGER,                         -- set while the player is off the tab
  away_penalty INTEGER NOT NULL DEFAULT 0,      -- accrued from absences over a minute
  PRIMARY KEY (round_id, name_key)
);
