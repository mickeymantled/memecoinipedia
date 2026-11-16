-- Issue #102: the mayhem-mode flag of a coin. Null: not known (the creation event of the coin does
-- not carry the flag, and Codex.io's launch record did not name the launchpad "Pump Mayhem"). True
-- once either source says so, and a true is never turned back. False: the creation event says so.
ALTER TABLE coins ADD COLUMN is_mayhem_mode boolean;
