-- What a backfill over a few hundred thousand coins needs from the database.
--
-- hash_order: a fixed pseudo-random number per address (the first 52 bits of the MD5 of the
-- address), stored so that "a fair sample, the same one on every run" is an index walk and not a
-- sort of every coin. MD5 is used because its output never changes between Postgres versions;
-- the internal hash functions make no such promise. 52 bits keeps the number exact as a
-- JavaScript number. The column is generated, so nothing writes it.
ALTER TABLE coins
  ADD COLUMN hash_order bigint
  GENERATED ALWAYS AS ((('x' || substr(md5(address), 1, 13))::bit(52)::bigint)) STORED;

-- The two selection orders, each ending in id so that every key is unique and a page can resume
-- after the last key it saw (coins with no rough peak come last in the peak order).
CREATE INDEX coins_hash_order_idx ON coins (chain, hash_order, id);
CREATE INDEX coins_rough_ath_idx ON coins (chain, rough_ath_market_cap_usd DESC NULLS LAST, id);

-- Coins finished per minute (the status view) reads a stage's recently finished rows.
CREATE INDEX coin_stages_stage_finished_idx ON coin_stages (stage, finished_at)
  WHERE finished_at IS NOT NULL;

-- Running totals of a run's provider usage, sampled every so often while it runs. provider_usage
-- keeps one total per run and provider; this keeps its history, so the status view can say what
-- was used in the last hour.
CREATE TABLE provider_usage_samples (
  run_id     bigint NOT NULL REFERENCES ingest_runs (id) ON DELETE CASCADE,
  provider   text   NOT NULL,
  sampled_at timestamptz NOT NULL,
  requests   bigint NOT NULL,
  units      double precision NOT NULL,
  PRIMARY KEY (run_id, provider, sampled_at)
);
