-- Run once on an already-deployed database. Keeps the judge's score separate
-- from the score after tab-switch penalties, so both can be shown.
ALTER TABLE submissions ADD COLUMN raw_score INTEGER;
