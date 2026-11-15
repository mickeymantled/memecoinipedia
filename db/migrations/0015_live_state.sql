-- Issue #73: the live worker (ingest/scripts/live.ts).
--
-- live_state: small named JSON values the live process keeps between restarts: the discovery
-- cursor, the time of the last sweep, the per-day counters (coins found, coins triggered), and
-- a hint of which kind of process holds the pipeline lock. One row per key.
CREATE TABLE live_state (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL
);

-- The watched coins (db/src/live.ts, `isWatched`) are the ones that graduated in the last 14
-- days: a range scan on graduated_at. The same index answers "latest graduation" for a first
-- start. Partial: a coin with no graduation time is never watched.
CREATE INDEX coins_graduated_at_idx ON coins (graduated_at) WHERE graduated_at IS NOT NULL;
