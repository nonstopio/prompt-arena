-- Run once on an already-deployed database. Records how often each player
-- left the tab while a round was live.
ALTER TABLE players ADD COLUMN blur_count INTEGER NOT NULL DEFAULT 0;
