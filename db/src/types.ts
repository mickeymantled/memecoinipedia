import type { ColumnType, Generated } from 'kysely';

/** bigint columns are read as JS numbers (see client.ts). */
type Id = Generated<number>;
type Ts = Date;
/** timestamptz with a database default. */
type TsNow = ColumnType<Date, Date | string | undefined, Date | string>;
/** jsonb: write it as a JSON string, read it parsed. */
type Json<T = unknown> = ColumnType<T, string, string>;
type JsonDefault<T = unknown> = ColumnType<T, string | undefined, string>;
type NumericDefault = ColumnType<string, string | number | undefined, string | number>;
type WithDefault<T> = ColumnType<T, T | undefined, T>;

export interface NarrativesTable {
  slug: string;
  label: string;
  sort_order: number;
}

export interface CoinsTable {
  id: Id;
  chain: string;
  address: string;
  ticker: string | null;
  name: string | null;
  launchpad: string | null;
  launched_at: Ts | null;
  creator_wallet: string | null;
  quote_token: string | null;
  token_program: string | null;
  total_supply: NumericDefault;
  graduated_at: Ts | null;
  discovery_source: string | null;
  rough_ath_market_cap_usd: number | null;
  /** Generated from the address: a fixed pseudo-random order for samples (migration 0012). */
  hash_order: ColumnType<number, never, never>;

  description: string | null;
  image_url: string | null;
  image_storage_key: string | null;
  metadata_uri: string | null;
  socials: JsonDefault<Record<string, unknown>>;
  metadata_raw: Json | null;

  ath_market_cap_usd: number | null;
  ath_at: Ts | null;
  ath_pool_id: number | null;
  seconds_to_ath: number | null;
  ath_wick_market_cap_usd: number | null;
  ath_wick_at: Ts | null;
  ath_wick_pool_id: number | null;
  ath_liquidity_usd: number | null;
  ath_hour_volume_usd: number | null;
  seconds_above_100k: number | null;
  seconds_above_1m: number | null;
  seconds_above_10m: number | null;
  seconds_above_100m: number | null;
  max_drawdown_pct: number | null;
  rug_pattern: boolean | null;
  metric_flags: WithDefault<string[]>;
  metrics_version: number | null;
  metrics_as_of: Ts | null;
  metrics_computed_at: Ts | null;

  current_price_usd: number | null;
  current_market_cap_usd: number | null;
  current_liquidity_usd: number | null;
  current_volume_24h_usd: number | null;
  current_refreshed_at: Ts | null;
  status: WithDefault<'unknown' | 'alive' | 'dead' | 'rugged'>;
  status_changed_at: Ts | null;

  primary_narrative: string | null;
  secondary_narratives: WithDefault<string[]>;
  narrative_confidence: number | null;
  narrative_reason: string | null;
  parent_coin_id: number | null;
  parent_address: string | null;
  sensitive: WithDefault<boolean>;
  summary: string | null;
  classifier_model: string | null;
  classifier_prompt_version: string | null;
  classified_at: Ts | null;

  created_at: TsNow;
  updated_at: TsNow;
}

export interface PoolsTable {
  id: Id;
  chain: string;
  address: string;
  coin_id: number;
  dex: string;
  is_primary: WithDefault<boolean>;
  is_graduation_pool: WithDefault<boolean>;
  quote_token: string | null;
  created_at_chain: Ts | null;
  source_pair_id: string | null;
  peak_liquidity_usd: number | null;
  first_bar_at: Ts | null;
  last_bar_at: Ts | null;
  created_at: TsNow;
  updated_at: TsNow;
}

export interface CandleChunksTable {
  pool_id: number;
  resolution_sec: 60 | 3600 | 86400;
  chunk_start: Ts;
  bar_count: number;
  first_t: number;
  last_t: number;
  t: number[];
  o: number[];
  h: number[];
  l: number[];
  c: number[];
  volume_usd: number[];
  trades: number[];
  traders: number[];
  liquidity_usd: (number | null)[];
}

export interface CandleCoverageTable {
  pool_id: number;
  resolution_sec: 60 | 3600 | 86400;
  from_t: number;
  to_t: number;
  reason: string;
  fetched_at: TsNow;
}

export interface CoinStagesTable {
  coin_id: number;
  stage:
    'discovered' | 'metadata' | 'metadata_file' | 'candles' | 'metrics' | 'classified' | 'embedded';
  status: WithDefault<'pending' | 'running' | 'done' | 'failed' | 'skipped'>;
  attempts: WithDefault<number>;
  version: WithDefault<number>;
  last_error: string | null;
  run_id: number | null;
  started_at: Ts | null;
  finished_at: Ts | null;
  updated_at: TsNow;
  /** Small per-coin result of a `done` stage (the candles stage stores its path and unit counts). */
  detail: Json | null;
}

export interface IngestRunsTable {
  id: Id;
  kind: string;
  status: WithDefault<'planned' | 'running' | 'done' | 'failed' | 'stopped'>;
  params: Json | null;
  estimate: Json | null;
  actual: Json | null;
  started_at: Ts | null;
  finished_at: Ts | null;
  created_at: TsNow;
}

export interface ProviderUsageTable {
  run_id: number;
  provider: string;
  requests: WithDefault<number>;
  units: WithDefault<number>;
  updated_at: TsNow;
}

export interface EvalLabelsTable {
  chain: WithDefault<string>;
  mint: string;
  ticker: string | null;
  primary_narrative: string;
  secondary_narratives: WithDefault<string[]>;
  parent_mint: string | null;
  confidence: number | null;
  notes: string | null;
  split: 'tune' | 'holdout' | null;
  source_file: string | null;
  loaded_at: TsNow;
}

export interface NarrativeResearchTable {
  chain: WithDefault<string>;
  mint: string;
  batch_issue: number;
  ticker: string | null;
  primary_narrative: string | null;
  secondary_narratives: WithDefault<string[]>;
  origin: string | null;
  origin_date: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  trigger_event: string | null;
  parent_mint: string | null;
  key_accounts: JsonDefault<unknown[]>;
  sources: JsonDefault<unknown[]>;
  confidence: number | null;
  notes: string | null;
  loaded_at: TsNow;
}

/** Running totals of a run's provider usage, one row per sample, for "over the last hour". */
export interface ProviderUsageSamplesTable {
  run_id: number;
  provider: string;
  sampled_at: Ts;
  requests: number;
  units: number;
}

/** Small named JSON values of the live process (migration 0015). */
export interface LiveStateTable {
  key: string;
  value: Json;
  updated_at: Ts;
}

export interface DataIssuesTable {
  id: Id;
  coin_id: number;
  kind: string;
  detail: Json | null;
  created_at: TsNow;
  resolved_at: Ts | null;
  resolution: string | null;
}

export interface Database {
  narratives: NarrativesTable;
  coins: CoinsTable;
  pools: PoolsTable;
  candle_chunks: CandleChunksTable;
  candle_coverage: CandleCoverageTable;
  coin_stages: CoinStagesTable;
  ingest_runs: IngestRunsTable;
  provider_usage: ProviderUsageTable;
  provider_usage_samples: ProviderUsageSamplesTable;
  eval_labels: EvalLabelsTable;
  narrative_research: NarrativeResearchTable;
  data_issues: DataIssuesTable;
  live_state: LiveStateTable;
}

/**
 * Runtime mirror of `Database`: every table and column name. The mapped type
 * makes the compiler reject a missing or extra key, and the test in
 * test/types.test.ts compares it with the live schema.
 */
export const databaseShape: { [T in keyof Database]: Record<keyof Database[T], true> } = {
  narratives: { slug: true, label: true, sort_order: true },
  coins: {
    id: true,
    chain: true,
    address: true,
    ticker: true,
    name: true,
    launchpad: true,
    launched_at: true,
    creator_wallet: true,
    quote_token: true,
    token_program: true,
    total_supply: true,
    graduated_at: true,
    discovery_source: true,
    rough_ath_market_cap_usd: true,
    hash_order: true,
    description: true,
    image_url: true,
    image_storage_key: true,
    metadata_uri: true,
    socials: true,
    metadata_raw: true,
    ath_market_cap_usd: true,
    ath_at: true,
    ath_pool_id: true,
    seconds_to_ath: true,
    ath_wick_market_cap_usd: true,
    ath_wick_at: true,
    ath_wick_pool_id: true,
    ath_liquidity_usd: true,
    ath_hour_volume_usd: true,
    seconds_above_100k: true,
    seconds_above_1m: true,
    seconds_above_10m: true,
    seconds_above_100m: true,
    max_drawdown_pct: true,
    rug_pattern: true,
    metric_flags: true,
    metrics_version: true,
    metrics_as_of: true,
    metrics_computed_at: true,
    current_price_usd: true,
    current_market_cap_usd: true,
    current_liquidity_usd: true,
    current_volume_24h_usd: true,
    current_refreshed_at: true,
    status: true,
    status_changed_at: true,
    primary_narrative: true,
    secondary_narratives: true,
    narrative_confidence: true,
    narrative_reason: true,
    parent_coin_id: true,
    parent_address: true,
    sensitive: true,
    summary: true,
    classifier_model: true,
    classifier_prompt_version: true,
    classified_at: true,
    created_at: true,
    updated_at: true,
  },
  pools: {
    id: true,
    chain: true,
    address: true,
    coin_id: true,
    dex: true,
    is_primary: true,
    is_graduation_pool: true,
    quote_token: true,
    created_at_chain: true,
    source_pair_id: true,
    peak_liquidity_usd: true,
    first_bar_at: true,
    last_bar_at: true,
    created_at: true,
    updated_at: true,
  },
  candle_chunks: {
    pool_id: true,
    resolution_sec: true,
    chunk_start: true,
    bar_count: true,
    first_t: true,
    last_t: true,
    t: true,
    o: true,
    h: true,
    l: true,
    c: true,
    volume_usd: true,
    trades: true,
    traders: true,
    liquidity_usd: true,
  },
  candle_coverage: {
    pool_id: true,
    resolution_sec: true,
    from_t: true,
    to_t: true,
    reason: true,
    fetched_at: true,
  },
  coin_stages: {
    coin_id: true,
    stage: true,
    status: true,
    attempts: true,
    version: true,
    last_error: true,
    run_id: true,
    started_at: true,
    finished_at: true,
    updated_at: true,
    detail: true,
  },
  ingest_runs: {
    id: true,
    kind: true,
    status: true,
    params: true,
    estimate: true,
    actual: true,
    started_at: true,
    finished_at: true,
    created_at: true,
  },
  provider_usage: { run_id: true, provider: true, requests: true, units: true, updated_at: true },
  provider_usage_samples: {
    run_id: true,
    provider: true,
    sampled_at: true,
    requests: true,
    units: true,
  },
  eval_labels: {
    chain: true,
    mint: true,
    ticker: true,
    primary_narrative: true,
    secondary_narratives: true,
    parent_mint: true,
    confidence: true,
    notes: true,
    split: true,
    source_file: true,
    loaded_at: true,
  },
  narrative_research: {
    chain: true,
    mint: true,
    batch_issue: true,
    ticker: true,
    primary_narrative: true,
    secondary_narratives: true,
    origin: true,
    origin_date: true,
    trigger_event: true,
    parent_mint: true,
    key_accounts: true,
    sources: true,
    confidence: true,
    notes: true,
    loaded_at: true,
  },
  data_issues: {
    id: true,
    coin_id: true,
    kind: true,
    detail: true,
    created_at: true,
    resolved_at: true,
    resolution: true,
  },
  live_state: { key: true, value: true, updated_at: true },
};
