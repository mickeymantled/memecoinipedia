-- A small per-coin result a stage can leave on its row. Set when the stage
-- finishes `done`, cleared when it fails or is skipped, null for stages that
-- have nothing to say. The candles stage stores its path and unit counts here.
ALTER TABLE coin_stages ADD COLUMN detail jsonb;
