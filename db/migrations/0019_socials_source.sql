-- Issue #89: where a coin's social links came from. `metadata_file`: the coin's own metadata file,
-- the record of what the creator published at launch. `jupiter`: Jupiter's token answer, which may
-- have been edited after launch. Null: no links stored from either (docs/data-sources.md).
ALTER TABLE coins ADD COLUMN socials_source text
  CHECK (socials_source IN ('metadata_file', 'jupiter'));

-- A coin whose file stage is done keeps what the file gave, also when that is nothing.
UPDATE coins SET socials_source = 'metadata_file'
WHERE EXISTS (
  SELECT 1 FROM coin_stages s
  WHERE s.coin_id = coins.id AND s.stage = 'metadata_file' AND s.status = 'done'
);
