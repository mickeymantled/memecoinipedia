-- Issue #64: the metadata file becomes its own stage, `metadata_file`.
--
-- 1. coin_stages.stage may now be 'metadata_file'.
-- 2. A coin that already holds the raw metadata JSON had its file fetched by the old, single
--    `metadata` stage. Mark `metadata_file` done for each of them, so the backfill never fetches
--    those files again. The row is done at version 1, with one attempt.
-- 3. The new `metadata` stage (version 2) writes everything the old one wrote except the file's
--    own contents, so those same coins already hold all of its output: move their `metadata`
--    row from version 1 to version 2 (only rows that are done or skipped at version 1).
-- Coins without raw JSON are not touched: their `metadata` runs again at version 2 and their
-- `metadata_file` is a new stage to run.
-- Forward-only: nothing here is undone by a later migration.

ALTER TABLE coin_stages DROP CONSTRAINT coin_stages_stage_check;
ALTER TABLE coin_stages ADD CONSTRAINT coin_stages_stage_check
  CHECK (stage IN ('discovered', 'metadata', 'metadata_file', 'candles', 'metrics', 'classified', 'embedded'));

INSERT INTO coin_stages (coin_id, stage, status, attempts, version, started_at, finished_at, updated_at)
SELECT c.id, 'metadata_file', 'done', 1, 1, now(), now(), now()
FROM coins c
WHERE c.metadata_raw IS NOT NULL
ON CONFLICT (coin_id, stage) DO NOTHING;

UPDATE coin_stages s
SET version = 2, updated_at = now()
FROM coins c
WHERE c.id = s.coin_id
  AND c.metadata_raw IS NOT NULL
  AND s.stage = 'metadata'
  AND s.status IN ('done', 'skipped')
  AND s.version = 1;
