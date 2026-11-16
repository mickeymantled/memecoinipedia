-- mayhem-graduates.sql (issue #102): the Mayhem Mode flag of the coins that graduated, for the
-- graduates already in the database, whose own candidate file (discovery.sql) does not carry it.
-- One row per pump.fun coin that has a creation event with the flag set (true or false) and a
-- graduation event (the first CompleteEvent). No parameters. NOT RUN: its cost is not known, and
-- running it is a decision for the lead (README section 8).
--
-- Columns: mint, is_mayhem_mode (true or false; a coin whose creation event has no flag is not in
-- the file). Load with `tsx scripts/mayhem-load.ts --file FILE` (a dry run that prints counts
-- unless --confirm is given). A true in the database is never turned back.
SELECT
  c.mint,
  c.is_mayhem_mode
FROM (
  SELECT mint, min_by(is_mayhem_mode, evt_block_time) AS is_mayhem_mode
  FROM pumpdotfun_solana.pump_evt_createevent
  WHERE is_mayhem_mode IS NOT NULL
  GROUP BY 1
) c
INNER JOIN (
  SELECT DISTINCT mint
  FROM pumpdotfun_solana.pump_evt_completeevent
) g ON g.mint = c.mint
ORDER BY c.mint
