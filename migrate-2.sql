-- Run once on an already-deployed database. Adds server-side draft storage so a
-- prompt can be auto-submitted even if the player never clicks the button.
ALTER TABLE players ADD COLUMN draft TEXT;
