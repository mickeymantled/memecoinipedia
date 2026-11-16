-- Schema for Memecoinipedia. Forward-only; never edit once applied.
-- Conventions: bigint identity ids, timestamptz times, double precision for USD
-- amounts and prices, text + CHECK instead of enum types.
-- The pgvector extension and the embedding column come later (task B8).

-- ---------------------------------------------------------------- narratives
CREATE TABLE narratives (
  slug       text PRIMARY KEY,
  label      text NOT NULL UNIQUE,
  sort_order int  NOT NULL
);

-- Labels are the taxonomy strings in AGENTS.md, exactly.
INSERT INTO narratives (slug, label, sort_order) VALUES
  ('ai',           'AI',            1),
  ('tech',         'tech',          2),
  ('animal',       'animal',        3),
  ('celebrity',    'celebrity',     4),
  ('political',    'political',     5),
  ('news_event',   'news event',    6),
  ('culture_meme', 'culture/meme',  7),
  ('gaming',       'gaming',        8),
  ('derivative',   'derivative',    9),
  ('utility',      'utility',      10),
  ('other',        'other',        11);

-- --------------------------------------------------------------- ingest_runs
CREATE TABLE ingest_runs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind        text NOT NULL,
  status      text NOT NULL DEFAULT 'planned'
              CHECK (status IN ('planned', 'running', 'done', 'failed', 'stopped')),
  params      jsonb,
  estimate    jsonb,
  actual      jsonb,
  started_at  timestamptz,
  finished_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE provider_usage (
  run_id     bigint NOT NULL REFERENCES ingest_runs (id) ON DELETE CASCADE,
  provider   text   NOT NULL,
  requests   bigint NOT NULL DEFAULT 0,
  units      double precision NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, provider)
);

-- --------------------------------------------------------------------- coins
CREATE TABLE coins (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- identity
  chain     text NOT NULL,
  address   text NOT NULL,
  ticker    text,
  name      text,
  launchpad text,
  launched_at     timestamptz,
  creator_wallet  text,
  quote_token     text,
  token_program   text,
  total_supply    numeric NOT NULL DEFAULT 1000000000,
  graduated_at    timestamptz,
  discovery_source text,
  rough_ath_market_cap_usd double precision,

  -- launch metadata
  description       text,
  image_url         text,
  image_storage_key text,
  metadata_uri      text,
  socials           jsonb NOT NULL DEFAULT '{}',
  metadata_raw      jsonb,

  -- price metrics (docs/metrics.md section 11)
  ath_market_cap_usd      double precision,
  ath_at                  timestamptz,
  ath_pool_id             bigint,
  seconds_to_ath          bigint,
  ath_wick_market_cap_usd double precision,
  ath_wick_at             timestamptz,
  ath_wick_pool_id        bigint,
  seconds_above_100k      bigint,
  seconds_above_1m        bigint,
  seconds_above_10m       bigint,
  seconds_above_100m      bigint,
  max_drawdown_pct        double precision,
  rug_pattern             boolean,
  metric_flags            text[] NOT NULL DEFAULT '{}',
  metrics_version         int,
  metrics_as_of           timestamptz,
  metrics_computed_at     timestamptz,

  -- current state
  current_price_usd       double precision,
  current_market_cap_usd  double precision,
  current_liquidity_usd   double precision,
  current_volume_24h_usd  double precision,
  current_refreshed_at    timestamptz,
  status            text NOT NULL DEFAULT 'unknown'
                    CHECK (status IN ('unknown', 'alive', 'dead', 'rugged')),
  status_changed_at timestamptz,

  -- classification
  primary_narrative    text REFERENCES narratives (slug),
  secondary_narratives text[] NOT NULL DEFAULT '{}'
                       CHECK (cardinality(secondary_narratives) <= 3),
  narrative_confidence real CHECK (narrative_confidence BETWEEN 0 AND 1),
  narrative_reason     text,
  parent_coin_id       bigint REFERENCES coins (id),
  parent_address       text,
  sensitive            boolean NOT NULL DEFAULT false,
  summary              text,
  classifier_model          text,
  classifier_prompt_version text,
  classified_at        timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (chain, address)
);

CREATE INDEX coins_ath_market_cap_usd_idx ON coins (ath_market_cap_usd DESC NULLS LAST);
CREATE INDEX coins_primary_narrative_idx ON coins (primary_narrative);
CREATE INDEX coins_launched_at_idx ON coins (launched_at);

-- --------------------------------------------------------------------- pools
CREATE TABLE pools (
  id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chain    text NOT NULL,
  address  text NOT NULL,
  coin_id  bigint NOT NULL REFERENCES coins (id) ON DELETE CASCADE,
  dex      text NOT NULL,
  is_primary         boolean NOT NULL DEFAULT false,
  is_graduation_pool boolean NOT NULL DEFAULT false,
  quote_token        text,
  created_at_chain   timestamptz,
  source_pair_id     text,
  peak_liquidity_usd double precision,
  first_bar_at       timestamptz,
  last_bar_at        timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain, address)
);

CREATE INDEX pools_coin_id_idx ON pools (coin_id);

-- coins and pools reference each other, so these two FKs come last.
ALTER TABLE coins
  ADD CONSTRAINT coins_ath_pool_id_fkey
    FOREIGN KEY (ath_pool_id) REFERENCES pools (id) ON DELETE SET NULL,
  ADD CONSTRAINT coins_ath_wick_pool_id_fkey
    FOREIGN KEY (ath_wick_pool_id) REFERENCES pools (id) ON DELETE SET NULL;

-- ------------------------------------------------------------- candle_chunks
-- One row per pool, resolution and span of resolution_sec * 1440 seconds
-- (one UTC day of 1-minute bars). Parallel arrays, sorted by t. chunk_start is
-- t rounded down to that span. Written once, read back a whole coin at a time.
CREATE TABLE candle_chunks (
  pool_id        bigint NOT NULL REFERENCES pools (id) ON DELETE CASCADE,
  resolution_sec int    NOT NULL CHECK (resolution_sec IN (60, 3600, 86400)),
  chunk_start    timestamptz NOT NULL,
  bar_count      int    NOT NULL CHECK (bar_count > 0),
  first_t        bigint NOT NULL,
  last_t         bigint NOT NULL,
  t              bigint[] NOT NULL,
  o              double precision[] NOT NULL,
  h              double precision[] NOT NULL,
  l              double precision[] NOT NULL,
  c              double precision[] NOT NULL,
  volume_usd     double precision[] NOT NULL,
  trades         int[] NOT NULL,
  traders        int[] NOT NULL,
  liquidity_usd  double precision[] NOT NULL,   -- elements may be null
  PRIMARY KEY (pool_id, resolution_sec, chunk_start),
  CONSTRAINT candle_chunks_equal_lengths CHECK (
    cardinality(t) = bar_count AND cardinality(o) = bar_count
    AND cardinality(h) = bar_count AND cardinality(l) = bar_count
    AND cardinality(c) = bar_count AND cardinality(volume_usd) = bar_count
    AND cardinality(trades) = bar_count AND cardinality(traders) = bar_count
    AND cardinality(liquidity_usd) = bar_count
  )
);

-- lz4 compression for the arrays where this server supports it (Postgres 14+
-- built with lz4); otherwise the default (pglz) stays. Applies to new rows.
DO $$
DECLARE
  col text;
BEGIN
  FOREACH col IN ARRAY ARRAY['t', 'o', 'h', 'l', 'c', 'volume_usd', 'trades', 'traders', 'liquidity_usd']
  LOOP
    EXECUTE format('ALTER TABLE candle_chunks ALTER COLUMN %I SET COMPRESSION lz4', col);
  END LOOP;
EXCEPTION WHEN feature_not_supported OR invalid_parameter_value THEN
  RAISE NOTICE 'lz4 compression not available; candle_chunks keeps the default';
END $$;

-- --------------------------------------------------------------- coin_stages
CREATE TABLE coin_stages (
  coin_id bigint NOT NULL REFERENCES coins (id) ON DELETE CASCADE,
  stage   text NOT NULL
          CHECK (stage IN ('discovered', 'metadata', 'candles', 'metrics', 'classified', 'embedded')),
  status  text NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'running', 'done', 'failed', 'skipped')),
  attempts int NOT NULL DEFAULT 0,
  version  int NOT NULL DEFAULT 1,
  last_error text,
  run_id  bigint REFERENCES ingest_runs (id),
  started_at  timestamptz,
  finished_at timestamptz,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (coin_id, stage)
);

CREATE INDEX coin_stages_stage_status_idx ON coin_stages (stage, status);

-- ------------------------------------------------- research and eval mirrors
-- Mirrors /research/evals/labels.csv (AGENTS.md).
CREATE TABLE eval_labels (
  chain  text NOT NULL DEFAULT 'solana',
  mint   text NOT NULL,
  ticker text,
  primary_narrative    text NOT NULL REFERENCES narratives (slug),
  secondary_narratives text[] NOT NULL DEFAULT '{}',
  parent_mint text,
  confidence  real,
  notes       text,
  split       text CHECK (split IN ('tune', 'holdout')),
  source_file text,
  loaded_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain, mint)
);

-- Mirrors /research/narratives/batch-<issue>.json (AGENTS.md).
CREATE TABLE narrative_research (
  chain       text NOT NULL DEFAULT 'solana',
  mint        text NOT NULL,
  batch_issue int  NOT NULL,
  ticker      text,
  primary_narrative    text REFERENCES narratives (slug),
  secondary_narratives text[] NOT NULL DEFAULT '{}',
  origin        text,
  origin_date   date,
  trigger_event text,
  parent_mint   text,
  key_accounts  jsonb NOT NULL DEFAULT '[]',
  sources       jsonb NOT NULL DEFAULT '[]',
  confidence    real,
  notes         text,
  loaded_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain, mint, batch_issue)
);

-- --------------------------------------------------------------- data_issues
CREATE TABLE data_issues (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  coin_id    bigint NOT NULL REFERENCES coins (id) ON DELETE CASCADE,
  kind       text NOT NULL,
  detail     jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolution text
);

CREATE INDEX data_issues_open_kind_idx ON data_issues (kind) WHERE resolved_at IS NULL;
