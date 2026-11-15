import { sql, type Kysely } from 'kysely';
import { getBars, type CandleBar } from './candles.js';
import { poolCountsForMetrics } from './poolQuote.js';
import type { Database } from './types.js';

/*
 * Read stored bars into a metric input, and write a metric result back to
 * `coins`. /db must not import from /ingest, so the input and result shapes are
 * repeated here (they match MetricInput and MetricResult in
 * ingest/src/metrics/types.ts field for field). The metric function itself is
 * passed in by the caller.
 */

export interface MetricPoolInput {
  address: string;
  dex: string;
  isPrimary: boolean;
  bars1m: CandleBar[];
  bars1h: CandleBar[];
  bars1d: CandleBar[];
}

export interface MetricInputShape {
  totalSupply: number;
  launchedAt: number;
  asOf: number;
  pools: MetricPoolInput[];
}

export interface MetricResultShape {
  athMarketCapUsd: number | null;
  athAt: number | null;
  athPoolAddress: string | null;
  secondsToAth: number | null;
  athWickMarketCapUsd: number | null;
  athWickAt: number | null;
  athWickPoolAddress: string | null;
  athLiquidityUsd: number | null;
  athHourVolumeUsd: number | null;
  athNearVolumeUsd: number | null;
  athBackedMarketCapUsd: number | null;
  /** Seconds above 100k, 1M, 10M and 100M, in that order. */
  secondsAbove: number[];
  maxDrawdownPct: number | null;
  rugPattern: boolean;
  flags: string[];
}

export type CoinStatus = 'unknown' | 'alive' | 'dead' | 'rugged';

export type LoadedMetricInput =
  | {
      ok: true;
      input: MetricInputShape;
      /** Pool address to pool id, for every pool of the coin. */
      poolIds: Map<string, number>;
      /** Bars loaded, all resolutions, of the pools that count. */
      barCount: number;
      /** Side pools left out of the input by `poolCountsForMetrics`; their bars stay stored. */
      sidePoolsLeftOut: number;
    }
  | { ok: false; reason: 'coin_not_found' | 'missing_launch_time' };

/**
 * Reads the coin's launch time, supply, pools and stored bars (up to and
 * including `asOf`). A side pool whose quote token is not SOL, USDC or USDT is left out of the
 * input (`poolCountsForMetrics`, docs/metrics.md section 1) and its bars are not read; it stays in
 * `poolIds`. Every path that turns stored pools into a metric input goes through here. Returns a failure when the coin does not exist or has no
 * launch time, which the metrics need.
 */
export async function loadMetricInput(
  db: Kysely<Database>,
  coinId: number,
  asOf: number,
): Promise<LoadedMetricInput> {
  const coin = await db
    .selectFrom('coins')
    .select(['launched_at', 'total_supply'])
    .where('id', '=', coinId)
    .executeTakeFirst();
  if (!coin) return { ok: false, reason: 'coin_not_found' };
  if (!coin.launched_at) return { ok: false, reason: 'missing_launch_time' };

  const pools = await db
    .selectFrom('pools')
    .select(['id', 'address', 'dex', 'is_primary', 'quote_token'])
    .where('coin_id', '=', coinId)
    .orderBy('id')
    .execute();
  const poolIds = new Map<string, number>();
  const out: MetricPoolInput[] = [];
  let barCount = 0;
  let sidePoolsLeftOut = 0;
  for (const p of pools) {
    poolIds.set(p.address, p.id);
    if (!poolCountsForMetrics({ isPrimary: p.is_primary, quoteToken: p.quote_token })) {
      sidePoolsLeftOut += 1;
      continue;
    }
    const range = { to: asOf + 1 };
    const [bars1m, bars1h, bars1d] = await Promise.all([
      getBars(db, p.id, 60, range),
      getBars(db, p.id, 3600, range),
      getBars(db, p.id, 86400, range),
    ]);
    barCount += bars1m.length + bars1h.length + bars1d.length;
    out.push({ address: p.address, dex: p.dex, isPrimary: p.is_primary, bars1m, bars1h, bars1d });
  }
  return {
    ok: true,
    input: {
      totalSupply: Number(coin.total_supply),
      launchedAt: coin.launched_at.getTime() / 1000,
      asOf,
      pools: out,
    },
    poolIds,
    barCount,
    sidePoolsLeftOut,
  };
}

/** Plan Q3, as starting values (task A6 tunes them). */
export const STATUS_RULES = {
  /** Alive: at least this much volume in the last 24 hours ... */
  minVolume24hUsd: 1_000,
  /** ... and at least this much liquidity. */
  minLiquidityUsd: 5_000,
  /** Dead: not alive at the end of any of the last this-many days. */
  deadAfterDays: 7,
} as const;

const DAY = 86_400;

/**
 * 24-hour volume and latest known liquidity at time `e`, from the stored bars.
 *
 * For each pool the volume is summed per resolution (1-minute, hourly, daily bars
 * in `(e - DAY, e]`) and the largest of the three sums is used. Resolutions are
 * never added together, because they can cover the same period. They are not
 * picked once for the whole pool either: under the staged plan a pool holds hourly
 * bars only for old days and daily bars for the recent ones, so the resolution
 * that has the last 24 hours differs from the one that has the most bars.
 */
function stateAt(
  pools: readonly MetricPoolInput[],
  e: number,
): { volume24h: number; liquidity: number } {
  let volume24h = 0;
  let liquidity = 0;
  for (const pool of pools) {
    let best = 0;
    for (const bars of [pool.bars1m, pool.bars1h, pool.bars1d]) {
      let sum = 0;
      for (const bar of bars) {
        if (bar.t > e - DAY && bar.t <= e) {
          const counts =
            pool.isPrimary ||
            (bar.liquidityUsd !== null && bar.liquidityUsd >= STATUS_RULES.minLiquidityUsd);
          if (counts) sum += bar.volumeUsd;
        }
      }
      best = Math.max(best, sum);
    }
    volume24h += best;
    let latest: CandleBar | null = null;
    for (const bars of [pool.bars1m, pool.bars1h, pool.bars1d]) {
      for (const bar of bars) {
        if (bar.t <= e && bar.liquidityUsd !== null && (latest === null || bar.t >= latest.t)) {
          latest = bar;
        }
      }
    }
    if (latest !== null && latest.liquidityUsd !== null) {
      liquidity = Math.max(liquidity, latest.liquidityUsd);
    }
  }
  return { volume24h, liquidity };
}

/**
 * The status rule from plan Q3.
 *
 * - rugged: the metric library reports the rug pattern.
 * - alive: the alive line was met at the end of any of the last 7 days: at least
 *   $1,000 of volume in the 24 hours before and at least $5,000 of liquidity
 *   (primary pools count fully; another pool counts only on bars that pass the
 *   $5,000 liquidity rule). Volume is taken per pool from one resolution at a
 *   time (1-minute, hourly or daily bars in the window, whichever sums highest),
 *   never added across resolutions, because under the staged plan bars of
 *   different resolutions cover different periods of a pool's life.
 * - dead: below the line at the end of each of the last 7 days, and bars exist
 *   from at least 7 days before `asOf`.
 * - unknown: no bars are stored, or the coin has under 7 days of history and has
 *   never met the line.
 *
 * The bars must have been fetched up to `asOf` for the answer to mean anything:
 * a missing bar reads as "nobody traded".
 */
export function decideStatus(
  input: Pick<MetricInputShape, 'pools' | 'asOf'>,
  result: Pick<MetricResultShape, 'rugPattern'>,
): CoinStatus {
  return statusFromEvidence({
    rugPattern: result.rugPattern,
    lastAliveAt: lastAliveFromBars(input),
    hasWeekOfHistory: hasWeekOfBars(input),
    now: input.asOf,
  });
}

/** Unix seconds of the earliest stored bar of any pool, or null with none. */
function firstBarTime(input: Pick<MetricInputShape, 'pools'>): number | null {
  let firstBar: number | null = null;
  for (const pool of input.pools) {
    for (const bars of [pool.bars1m, pool.bars1h, pool.bars1d]) {
      for (const bar of bars) if (firstBar === null || bar.t < firstBar) firstBar = bar.t;
    }
  }
  return firstBar;
}

/** At least 7 days between the first stored bar and `asOf`. */
export function hasWeekOfBars(input: Pick<MetricInputShape, 'pools' | 'asOf'>): boolean {
  const first = firstBarTime(input);
  return first !== null && input.asOf - first >= STATUS_RULES.deadAfterDays * DAY;
}

/**
 * `last_alive_at` from the stored bars: the latest of the last 7 day-ends (`asOf`, `asOf` minus a
 * day, up to minus six days) at which the alive line was met, in unix seconds, or null when it was
 * met at none (or there are no bars). The same line and the same day boundaries the status has
 * always used (docs/metrics.md, section 14).
 */
export function lastAliveFromBars(input: Pick<MetricInputShape, 'pools' | 'asOf'>): number | null {
  if (firstBarTime(input) === null) return null;
  for (let k = 0; k < STATUS_RULES.deadAfterDays; k++) {
    const e = input.asOf - k * DAY;
    const s = stateAt(input.pools, e);
    if (
      s.volume24h >= STATUS_RULES.minVolume24hUsd &&
      s.liquidity >= STATUS_RULES.minLiquidityUsd
    ) {
      return e;
    }
  }
  return null;
}

export interface StatusEvidence {
  /** The stored rug pattern. */
  rugPattern: boolean | null;
  /** `coins.last_alive_at` in unix seconds, or null. */
  lastAliveAt: number | null;
  /** The coin has at least 7 days of history. */
  hasWeekOfHistory: boolean;
  /** The time the status is asked at, unix seconds. */
  now: number;
}

/**
 * The one function that decides a coin's status (docs/metrics.md, section 14); the metrics
 * computation and the daily refresh both call it.
 *
 * rugged if the rug pattern is stored; alive if `lastAliveAt` is less than 7 days before `now`;
 * dead if not and the coin has 7 days of history; otherwise unknown.
 */
export function statusFromEvidence(e: StatusEvidence): CoinStatus {
  if (e.rugPattern) return 'rugged';
  if (e.lastAliveAt !== null && e.now - e.lastAliveAt < STATUS_RULES.deadAfterDays * DAY) {
    return 'alive';
  }
  return e.hasWeekOfHistory ? 'dead' : 'unknown';
}

export interface WriteMetricsContext {
  poolIds: ReadonlyMap<string, number>;
  metricsVersion: number;
  /** End of the observation period, unix seconds. */
  asOf: number;
  /** Stored as `metrics_computed_at` and `updated_at`. */
  computedAt: Date;
  status: CoinStatus;
  /** Stored as `last_alive_at` when given (the caller has already taken the later of two values). */
  lastAliveAt?: Date | null;
}

const date = (s: number | null): Date | null => (s === null ? null : new Date(s * 1000));

/**
 * Writes every metric column of `coins` plus the status. The same result with
 * the same context writes the same values (`status_changed_at` moves only when
 * the status changes).
 */
export async function writeCoinMetrics(
  db: Kysely<Database>,
  coinId: number,
  result: MetricResultShape,
  ctx: WriteMetricsContext,
): Promise<void> {
  const poolId = (address: string | null): number | null =>
    address === null ? null : (ctx.poolIds.get(address) ?? null);
  const above = (i: number): number | null => {
    const v = result.secondsAbove[i];
    return v === undefined ? null : Math.round(v);
  };
  await db
    .updateTable('coins')
    .set({
      ath_market_cap_usd: result.athMarketCapUsd,
      ath_at: date(result.athAt),
      ath_pool_id: poolId(result.athPoolAddress),
      seconds_to_ath: result.secondsToAth === null ? null : Math.round(result.secondsToAth),
      ath_wick_market_cap_usd: result.athWickMarketCapUsd,
      ath_wick_at: date(result.athWickAt),
      ath_wick_pool_id: poolId(result.athWickPoolAddress),
      ath_liquidity_usd: result.athLiquidityUsd,
      ath_hour_volume_usd: result.athHourVolumeUsd,
      ath_near_volume_usd: result.athNearVolumeUsd,
      ath_backed_market_cap_usd: result.athBackedMarketCapUsd,
      seconds_above_100k: above(0),
      seconds_above_1m: above(1),
      seconds_above_10m: above(2),
      seconds_above_100m: above(3),
      max_drawdown_pct: result.maxDrawdownPct,
      rug_pattern: result.rugPattern,
      metric_flags: [...result.flags],
      metrics_version: ctx.metricsVersion,
      metrics_as_of: new Date(ctx.asOf * 1000),
      metrics_computed_at: ctx.computedAt,
      status: ctx.status,
      ...(ctx.lastAliveAt !== undefined ? { last_alive_at: ctx.lastAliveAt } : {}),
      status_changed_at: sql`case when status <> ${ctx.status} then ${ctx.computedAt} else status_changed_at end`,
      updated_at: ctx.computedAt,
    })
    .where('id', '=', coinId)
    .execute();
}

export type StoreMetricsOutcome =
  | {
      ok: true;
      result: MetricResultShape;
      status: CoinStatus;
      barCount: number;
      sidePoolsLeftOut: number;
    }
  | { ok: false; reason: 'coin_not_found' | 'missing_launch_time' | 'no_candles' };

/**
 * Reads the stored bars, runs `compute` (the metric library's
 * `computeCoinMetrics`) and writes the result and status to the coin. Returns a
 * failure, writing nothing, when the coin is unknown or has no launch time. A coin
 * with no bars in any pool that counts is a `no_candles` failure too, unless the caller gives
 * `noBars`: then that result is written (status `unknown`, as `decideStatus` says for
 * no bars) and the outcome is a success with a `barCount` of 0.
 */
export async function computeAndStoreCoinMetrics(
  db: Kysely<Database>,
  coinId: number,
  opts: {
    compute: (input: MetricInputShape) => MetricResultShape;
    /** The result to store for a coin with no bars at all. Without it, such a coin is a `no_candles` failure. */
    noBars?: MetricResultShape;
    asOf: number;
    computedAt: Date;
    metricsVersion: number;
  },
): Promise<StoreMetricsOutcome> {
  const loaded = await loadMetricInput(db, coinId, opts.asOf);
  if (!loaded.ok) return loaded;
  if (loaded.barCount === 0 && !opts.noBars) return { ok: false, reason: 'no_candles' };
  const result = loaded.barCount === 0 ? opts.noBars! : opts.compute(loaded.input);
  // `last_alive_at` never moves backwards: the later of what is stored and what the bars say.
  const stored = await db
    .selectFrom('coins')
    .select('last_alive_at')
    .where('id', '=', coinId)
    .executeTakeFirst();
  const fromBars = lastAliveFromBars(loaded.input);
  const storedSec = stored?.last_alive_at
    ? Math.floor(stored.last_alive_at.getTime() / 1000)
    : null;
  const lastAlive =
    fromBars === null ? storedSec : storedSec === null ? fromBars : Math.max(storedSec, fromBars);
  const status = statusFromEvidence({
    rugPattern: result.rugPattern,
    lastAliveAt: lastAlive,
    hasWeekOfHistory: hasWeekOfBars(loaded.input),
    now: opts.asOf,
  });
  await writeCoinMetrics(db, coinId, result, {
    lastAliveAt: lastAlive === null ? null : new Date(lastAlive * 1000),
    poolIds: loaded.poolIds,
    metricsVersion: opts.metricsVersion,
    asOf: opts.asOf,
    computedAt: opts.computedAt,
    status,
  });
  return {
    ok: true,
    result,
    status,
    barCount: loaded.barCount,
    sidePoolsLeftOut: loaded.sidePoolsLeftOut,
  };
}
