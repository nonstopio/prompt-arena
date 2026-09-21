-- Run once on an already-deployed database. Tracks how many times each entry
-- has been revised, so the two-edit limit can be enforced on the server.
ALTER TABLE submissions ADD COLUMN edits INTEGER NOT NULL DEFAULT 0;
