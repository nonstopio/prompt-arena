-- Run once on an already-deployed database. Tracks long absences: the clock
-- starts when a player leaves the tab and the penalty is worked out on return.
ALTER TABLE players ADD COLUMN away_since INTEGER;
ALTER TABLE players ADD COLUMN away_penalty INTEGER NOT NULL DEFAULT 0;
