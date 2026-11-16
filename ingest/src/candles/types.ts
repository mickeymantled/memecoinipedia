import type { Kysely } from 'kysely';
import type { Database } from '@memecoinipedia/db';
import type { CodexClient, LaunchInfo } from '../sources/codex/index.js';
import type { CandleFailure } from './errors.js';
import type { PlanLimits, PoolRole, UnitEstimate } from './plan.js';

/** What the candle entry points need. */
export interface CandleDeps {
  db: Kysely<Database>;
  /** Carries the rate limiter and the unit budget (a ceiling stops a run with `budget_exhausted`). */
  codex: CodexClient;
  /** The observation time. Fetching and metrics read it once per call. */
  clock: () => Date;
}

/** A coin row, as much of it as these functions use. */
export interface CandleCoin {
  /** `coins.id`. */
  id: number;
  /** The mint address, `coins.address`. */
  address: string;
  /** Default `solana`. */
  chain?: string;
  /**
   * Codex.io launch fields when the caller already has them (discovery returns
   * them), which saves one request. Without them, they are looked up unless the
   * coin's pools are already stored.
   */
  launchInfo?: LaunchInfo | null;
  /** Look the pools up again even when some are stored. Default false. */
  refreshPools?: boolean;
}

export interface FetchCandlesOptions {
  limits?: Partial<PlanLimits>;
  /** At most this many pools besides the curve and the graduation pool. Default 8. */
  maxSecondaryPools?: number;
}

export interface BarCounts {
  '1m': number;
  '1h': number;
  '1d': number;
}

export interface PoolSummary {
  address: string;
  role: PoolRole;
  dex: string;
  poolId: number;
}

export interface CandleFetchSummary {
  coinId: number;
  mint: string;
  /** Observation time, unix seconds. */
  asOf: number;
  /**
   * Where the coin ended up: `screened_out` (nothing past the screen was fetched),
   * `light`, `full`, `screen` (stopped before the screen finished), or
   * `exhaustive` (the exhaustive plan, which has no screen).
   */
  path: 'screen' | 'screened_out' | 'light' | 'full' | 'exhaustive';
  /** The coin was screened out: its highest daily high is under the screen line. */
  screenedOut: boolean;
  /** W: the highest daily high as a market cap in USD, or null before the screen bars exist. */
  w: number | null;
  /** The Dune peak was more than 1.5 times W, so the coin took the full path. */
  escalated: boolean;
  pools: PoolSummary[];
  /** Listed pools left out (too little liquidity, or over the cap). */
  skippedOtherPools: number;
  /** The graduation pool was chosen by creation time from a cut-off list. */
  graduationPoolUnverified: boolean;
  /** Bars the provider returned in this run, per resolution. */
  barsFetched: BarCounts;
  /** Bars stored for the coin after this run, all pools. */
  barsStored: BarCounts;
  /** Bars requests made in this run. */
  requests: number;
  /** Launch-info and pool-list requests made in this run. */
  lookupRequests: number;
  /**
   * Compute units this coin's calls cost in this run, lookups included, summed from
   * what each response reported. Counted per coin, so coins can run at once on one client.
   */
  units: number;
  /** Estimate made before the first request. */
  estimate: UnitEstimate | null;
  /** Peak-refinement requests made in this run. */
  refinementRounds: number;
  /** Peak-refinement requests this coin has used in all runs. */
  refinementRequestsTotal: number;
  /** Hourly windows were left out because of the per-coin cap. */
  hourlyCapHit: boolean;
  /** Metric flags of the stored bars after the last round. */
  flags: string[];
  /** Data-issue kinds recorded or already open for this coin from this stage. */
  issues: string[];
}

export type FetchCandlesResult =
  | { ok: true; summary: CandleFetchSummary }
  | ({ ok: false; summary: CandleFetchSummary } & CandleFailure);
