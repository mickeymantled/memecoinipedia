-- Issue #89: where a coin's social links came from. `metadata_file`: the coin's own metadata file,
-- the record of what the creator published at launch. `jupiter`: Jupiter's token answer, which may
-- have been edited after launch. Null: no links stored from either (docs/data-sources.md).
ALTER TABLE coins ADD COLUMN socials_source text
  CHECK (socials_source IN ('metadata_file', 'jupiter'));

-- `metadata_file` means the file was read. The stage ends done for outcomes that read nothing (not
-- found, invalid, too large, unsupported URI) and stores the raw JSON only when it read the file, so a
-- coin whose file stage is done and whose raw JSON is stored was read, whatever links it held (the same
-- marker migration 0014 used to mark coins done).
UPDATE coins SET socials_source = 'metadata_file'
WHERE metadata_raw IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM coin_stages s
    WHERE s.coin_id = coins.id AND s.stage = 'metadata_file' AND s.status = 'done'
  );
