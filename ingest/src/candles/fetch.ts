import {
  addCoverage,
  countCoverageRequests,
  getBars,
  getCoinPools,
  getCoverage,
  loadMetricInput,
  putBars,
  PoolOwnedByOtherCoinError,
  takeOverPool,
  refreshPoolBarStats,
  upsertPool,
  type StoredPool,
} from '@memecoinipedia/db';
import { computeCoinMetrics } from '../metrics/index.js';
import {
  pairIdFor,
  type CallMeter,
  type LaunchInfo,
  type PoolInfo,
} from '../sources/codex/index.js';
import { classifyProviderError, type CandleFailure } from './errors.js';
import { findCoveragePeaks } from './peaks.js';
import {
  DEFAULT_PLAN_LIMITS,
  estimateCoinUnits,
  planBaseRequests,
  planPeakRefinement,
  resolutionCode,
  summarizeDaily,
  type BasePlan,
  type Interval,
  type PlanPool,
  type PlanState,
  type PoolDaily,
  type PlannedRequest,
  type PoolRole,
  type ResolutionSec,
} from './plan.js';
import { selectPools } from './poolSelection.js';
import { SCREENED_OUT_FLAG } from './metrics.js';
import type {
  BarCounts,
  CandleCoin,
  CandleDeps,
  CandleFetchSummary,
  FetchCandlesOptions,
  FetchCandlesResult,
} from './types.js';

const DEFAULT_MAX_SECONDARY_POOLS = 8;
/** A coin that graduated this recently may simply not be indexed yet, so a later retry can work. */
const YOUNG_COIN_SEC = 6 * 3_600;
const RESOLUTIONS: ResolutionSec[] = [60, 3600, 86400];
/** Safety stop for the base-plan loop: screen, pool list, other pools, minutes, curve, hourly. */
const MAX_BASE_ROUNDS = 12;

const emptyCounts = (): BarCounts => ({ '1m': 0, '1h': 0, '1d': 0 });
const countKey = (res: ResolutionSec): keyof BarCounts =>
  res === 60 ? '1m' : res === 3600 ? '1h' : '1d';

class Stop extends Error {
  constructor(readonly failure: CandleFailure) {
    super(failure.message);
  }
}

/** See the header of ./index.ts. */
export async function fetchCandlesForCoin(
  deps: CandleDeps,
  coin: CandleCoin,
  options: FetchCandlesOptions = {},
): Promise<FetchCandlesResult> {
  const { db, codex } = deps;
  const chain = coin.chain ?? 'solana';
  const asOf = Math.floor(deps.clock().getTime() / 1000);
  const limits = { ...DEFAULT_PLAN_LIMITS, ...stripUndefined(options.limits) };
  const maxSecondaryPools = options.maxSecondaryPools ?? DEFAULT_MAX_SECONDARY_POOLS;
  // What this coin's own calls cost; the client's running total is shared with other coins.
  const meter: CallMeter = { requests: 0, units: 0 };

  const summary: CandleFetchSummary = {
    coinId: coin.id,
    mint: coin.address,
    asOf,
    path: limits.staged ? 'screen' : 'exhaustive',
    screenedOut: false,
    w: null,
    escalated: false,
    pools: [],
    skippedOtherPools: 0,
    otherQuotePools: null,
    poolsTakenOver: 0,
    launchInfoNamedPool: null,
    graduationPoolUnverified: false,
    barsFetched: emptyCounts(),
    barsStored: emptyCounts(),
    requests: 0,
    lookupRequests: 0,
    units: 0,
    estimate: null,
    refinementRounds: 0,
    refinementRequestsTotal: 0,
    hourlyCapHit: false,
    flags: [],
    issues: [],
    issueRecords: [],
    issueKindsChecked: [],
  };
  /** Addresses of pools owned by another coin, left out; counted once each. */
  const clashed = new Set<string>();
  const finish = (): void => {
    summary.units = round6(meter.units);
  };

  let stored: StoredPool[] = [];
  let totalSupply = 1_000_000_000;
  let roughAthUsd: number | null = null;
  let launchedAt: number | null = null;
  let graduatedAt: number | null = null;
  /** The pool list has been looked up for this coin, in this run or one before. */
  let listed = false;

  try {
    // 1. The coin row and its pools.
    const row = await db
      .selectFrom('coins')
      .select(['id', 'launched_at', 'graduated_at', 'total_supply', 'rough_ath_market_cap_usd'])
      .where('id', '=', coin.id)
      .executeTakeFirst();
    if (!row) {
      throw new Stop({
        reason: 'coin_not_found',
        retry: false,
        message: `No coin with id ${coin.id}`,
      });
    }
    totalSupply = Number(row.total_supply);
    roughAthUsd = row.rough_ath_market_cap_usd ?? null;
    launchedAt = row.launched_at ? row.launched_at.getTime() / 1000 : null;
    graduatedAt = row.graduated_at ? row.graduated_at.getTime() / 1000 : null;
    stored = await getCoinPools(db, coin.id);
    // A pool from the list carries its creation time; one named by launch info alone does not.
    listed = stored.some((p) => p.createdAtChain !== null);

    if (stored.length === 0 || coin.refreshPools === true) {
      // Stage 0: launch info, and the pool list only when launch info names no migrated pool.
      const launch = await launchInfo();
      launchedAt ??= launch.createdAt;
      graduatedAt ??= launch.migratedAt;
      await fillCoinTimes(launch);
      if (limits.staged && launch.migratedPoolAddress !== null && coin.refreshPools !== true) {
        summary.launchInfoNamedPool = true;
        await upsertPoolUnlessOwned({
          chain,
          address: launch.migratedPoolAddress,
          coinId: coin.id,
          dex: 'unknown',
          isPrimary: true,
          isGraduationPool: true,
          sourcePairId: pairIdFor(launch.migratedPoolAddress),
        });
      } else {
        summary.launchInfoNamedPool = false;
        await lookupPools(launch, true);
      }
      stored = await getCoinPools(db, coin.id);
    } else if (launchedAt === null) {
      const launch = await launchInfo();
      launchedAt = launch.createdAt;
      graduatedAt ??= launch.migratedAt;
      await fillCoinTimes(launch);
    }
    if (launchedAt === null) {
      throw new Stop({
        reason: 'missing_launch_time',
        retry: false,
        message: 'Neither the coin row nor Codex.io has a creation time',
      });
    }
    setPoolSummary();

    const roleOf = (p: StoredPool): PoolRole =>
      p.isGraduationPool ? 'graduation' : p.isPrimary ? 'curve' : 'other';

    const buildState = async (): Promise<PlanState> => {
      const coverage: Record<string, Partial<Record<ResolutionSec, Interval[]>>> = {};
      const daily: Record<string, PoolDaily> = {};
      for (const p of stored) {
        const byRes: Partial<Record<ResolutionSec, Interval[]>> = {};
        for (const res of RESOLUTIONS) {
          byRes[res] = await getCoverage(db, p.id, res);
        }
        coverage[p.address] = byRes;
        daily[p.address] = summarizeDaily(
          await getBars(db, p.id, 86400),
          limits.minSecondaryPoolLiquidityUsd,
          totalSupply,
        );
      }
      const pools: PlanPool[] = stored.map((p) => ({
        address: p.address,
        role: roleOf(p),
        createdAt: p.createdAtChain,
      }));
      return {
        asOf,
        launchedAt,
        graduatedAt,
        pools,
        coverage,
        daily,
        roughAthUsd,
        poolsListed: listed,
        limits,
      };
    };

    const execute = async (req: PlannedRequest): Promise<void> => {
      const pool = stored.find((p) => p.address === req.poolAddress);
      if (pool === undefined) throw new Error(`No stored pool for ${req.poolAddress}`);
      const bars = await codex.getPoolBars({
        pairAddress: req.poolAddress,
        resolution: resolutionCode(req.resolution),
        from: req.from,
        to: req.to,
        meter,
      });
      summary.requests += 1;
      summary.barsFetched[countKey(req.resolution)] += bars.length;
      await putBars(db, pool.id, req.resolution, bars);
      // Coverage goes in after the bars: a crash in between only repeats the request.
      await addCoverage(db, pool.id, req.resolution, req.cover, req.reason);
    };

    // 2. The base plan: screen, then minute windows, then hourly bars (staged);
    // or minute windows and daily bars, then hourly bars (exhaustive).
    let last: BasePlan | null = null;
    for (let round = 0; round < MAX_BASE_ROUNDS; round++) {
      const state = await buildState();
      if (round === 0) summary.estimate = estimateCoinUnits(state);
      const plan = planBaseRequests(state);
      last = plan;
      if (plan.hourly.capHit) summary.hourlyCapHit = true;
      if (plan.requests.length > 0) {
        for (const req of plan.requests) await execute(req);
        continue;
      }
      if (plan.needsPoolList && !listed) {
        await lookupPools(await launchInfoFromStore(), false);
        stored = await getCoinPools(db, coin.id);
        setPoolSummary();
        continue;
      }
      break;
    }
    if (last && limits.staged) {
      summary.path = last.stage.screenedOut ? 'screened_out' : last.stage.path;
      summary.screenedOut = last.stage.screenedOut;
      summary.w = last.stage.w;
      summary.escalated = last.stage.escalated;
    }
    checked('candle_hourly_cap_hit');
    if (summary.hourlyCapHit) {
      issue('candle_hourly_cap_hit', {
        maxHourlyRequests:
          last?.stage.path === 'full' ? limits.maxHourlyRequestsFull : limits.maxHourlyRequests,
      });
    }

    // A screened-out coin is done: its highest daily high cannot make an ATH of $100,000.
    if (summary.screenedOut) {
      const loaded = await loadMetricInput(db, coin.id, asOf);
      if (loaded.ok) summary.barsStored = countBars(loaded.input.pools);
      summary.flags = [SCREENED_OUT_FLAG];
      for (const p of stored) await refreshPoolBarStats(db, p.id);
      finish();
      return { ok: true, summary };
    }

    // 3. Peak refinement: while the metrics say the peak may sit where we hold no
    // 1-minute bars, fetch those minutes and recompute.
    for (;;) {
      const loaded = await loadMetricInput(db, coin.id, asOf);
      if (!loaded.ok) {
        throw new Stop({ reason: loaded.reason, retry: false, message: loaded.reason });
      }
      const result = computeCoinMetrics(loaded.input);
      summary.flags = result.flags;
      summary.barsStored = countBars(loaded.input.pools);
      if (!result.flags.includes('peak_outside_minute_coverage')) break;

      const done = await countCoverageRequests(db, coin.id, 'peak_refinement');
      summary.refinementRequestsTotal = done;
      // A period that never traded at the refine line cannot make the coin listed: not worth a request.
      const targets = findCoveragePeaks(loaded.input).filter(
        (x) => x.highUsd === undefined || x.highUsd >= limits.refineFromUsd,
      );
      if (targets.length === 0) break;
      const next = planPeakRefinement(await buildState(), targets, done);
      if (!next.request) {
        issue('peak_refinement_incomplete', {
          why: next.capHit ? 'request_cap' : 'no_more_periods',
          refinementRequests: done,
          cap: limits.maxRefinementRequests,
          flags: result.flags,
        });
        break;
      }
      await execute(next.request);
      summary.refinementRounds += 1;
      summary.refinementRequestsTotal = done + 1;
    }

    checked('peak_refinement_incomplete');
    for (const p of stored) await refreshPoolBarStats(db, p.id);
    finish();
    return { ok: true, summary };
  } catch (err) {
    const failure = err instanceof Stop ? err.failure : classifyProviderError(err);
    if (!failure) throw err;
    finish();
    return { ok: false, ...failure, summary };
  }

  function setPoolSummary(): void {
    summary.pools = stored.map((p) => ({
      address: p.address,
      role: p.isGraduationPool ? 'graduation' : p.isPrimary ? 'curve' : 'other',
      dex: p.dex,
      poolId: p.id,
    }));
  }

  /** One launch-info lookup, unless the caller handed the launch info in. */
  async function launchInfo(): Promise<LaunchInfo> {
    let launch: LaunchInfo | null;
    if (coin.launchInfo !== undefined) {
      launch = coin.launchInfo;
    } else {
      summary.lookupRequests += 1;
      launch = await codex.getLaunchInfo(coin.address, meter);
    }
    if (!launch) {
      throw new Stop({
        reason: 'token_not_found',
        retry: false,
        message: 'Codex.io does not know this token',
      });
    }
    return launch;
  }

  /**
   * What the pool selection needs of launch info, rebuilt from the stored coin
   * and graduation pool when the launch info itself is not at hand.
   */
  async function launchInfoFromStore(): Promise<LaunchInfo> {
    const grad = stored.find((p) => p.isGraduationPool);
    return {
      mint: coin.address,
      symbol: null,
      name: null,
      createdAt: launchedAt,
      creator: null,
      launchpadName: null,
      migrated: graduatedAt !== null ? true : null,
      migratedAt: graduatedAt,
      migratedPoolAddress: grad?.address ?? null,
      completed: null,
      completedAt: null,
      launchpadPoolAddress: null,
    };
  }

  /**
   * Looks up the pool list, selects the curve, the graduation pool and the
   * liquid other pools, stores them, records issues. At stage 0 a list with
   * nothing usable stops the coin; later it just leaves the pools as they are.
   */
  async function lookupPools(launch: LaunchInfo, stage0: boolean): Promise<void> {
    summary.lookupRequests += 1;
    const listing = await codex.getPools(coin.address, meter);
    listed = true;
    const selection = selectPools({
      pools: listing,
      migratedPoolAddress: launch.migratedPoolAddress,
      migratedAt: launch.migratedAt,
      migrated: launch.migrated,
      minSecondaryPoolLiquidityUsd: limits.minSecondaryPoolLiquidityUsd,
      maxSecondaryPools,
    });
    if (!selection.curve && !selection.graduation && selection.others.length === 0) {
      if (!stage0) return;
      const young = launch.migratedAt !== null && asOf - launch.migratedAt < YOUNG_COIN_SEC;
      checked('graduation_pool_not_found');
      for (const i of selection.issues) issue(i.kind, i.detail);
      throw new Stop({
        reason: 'no_pools',
        retry: young,
        message: `Codex.io lists ${listing.pools.length} pools and none is usable`,
      });
    }

    const put = (
      address: string,
      pool: PoolInfo | null,
      role: PoolRole,
      fallbackDex: string,
    ): Promise<void> =>
      upsertPoolUnlessOwned({
        chain,
        address,
        coinId: coin.id,
        dex: pool?.exchange ?? pool?.protocol ?? fallbackDex,
        isPrimary: role !== 'other',
        isGraduationPool: role === 'graduation',
        quoteToken: pool?.quoteToken ?? null,
        createdAtChain: pool?.createdAt ?? null,
        sourcePairId: pairIdFor(address),
      });
    if (selection.curve) await put(selection.curve.address, selection.curve, 'curve', 'unknown');
    if (selection.graduation) {
      await put(selection.graduation.address, selection.graduation.pool, 'graduation', 'unknown');
    }
    // Other pools are stored now so a later run needs no second list; only the full path fetches them.
    for (const p of selection.others) await put(p.address, p, 'other', 'unknown');

    summary.skippedOtherPools = selection.skippedOthers;
    summary.otherQuotePools = selection.otherQuotePools + clashed.size;
    summary.graduationPoolUnverified = selection.graduation?.unverified ?? false;
    checked('graduation_pool_not_found');
    for (const i of selection.issues) issue(i.kind, i.detail);
  }

  /** Sets launch and graduation time on the coin when they are empty. Never overwrites. */
  async function fillCoinTimes(launch: LaunchInfo): Promise<void> {
    const current = await db
      .selectFrom('coins')
      .select(['launched_at', 'graduated_at'])
      .where('id', '=', coin.id)
      .executeTakeFirstOrThrow();
    const set: { launched_at?: Date; graduated_at?: Date } = {};
    if (!current.launched_at && launch.createdAt !== null) {
      set.launched_at = new Date(launch.createdAt * 1000);
    }
    if (!current.graduated_at && launch.migratedAt !== null) {
      set.graduated_at = new Date(launch.migratedAt * 1000);
    }
    if (Object.keys(set).length > 0) {
      await db.updateTable('coins').set(set).where('id', '=', coin.id).execute();
    }
  }

  /**
   * Notes an issue found in this run; the caller writes it (`replaceCoinIssues`). One per kind:
   * a second one of the same kind replaces the first.
   */
  function issue(kind: string, detail: Record<string, unknown>): void {
    summary.issueRecords = summary.issueRecords.filter((i) => i.kind !== kind);
    summary.issueRecords.push({ kind, detail });
    if (!summary.issues.includes(kind)) summary.issues.push(kind);
  }

  /** This run looked for issues of `kind`, so an open one it did not find again is stale. */
  function checked(kind: string): void {
    if (!summary.issueKindsChecked.includes(kind)) summary.issueKindsChecked.push(kind);
  }

  /**
   * Stores a pool, or leaves it out when another coin already owns its address (a pool between two
   * tracked coins). The pool is counted in `otherQuotePools`; the stage carries on.
   */
  async function upsertPoolUnlessOwned(pool: Parameters<typeof upsertPool>[1]): Promise<void> {
    try {
      await upsertPool(db, pool);
    } catch (err) {
      if (!(err instanceof PoolOwnedByOtherCoinError)) throw err;
      if (!pool.isPrimary) {
        clashed.add(pool.address);
        return;
      }
      // The coin's own curve or graduation pool: take it over from a coin that holds it as an
      // ordinary other pool. Two coins claiming it as their own should never happen: fail loudly.
      const r = await takeOverPool(db, pool, deps.clock());
      if (r.status === 'taken') summary.poolsTakenOver += 1;
      if (r.status === 'claimed_by_two') {
        throw new Stop({
          reason: 'pool_claimed_by_two_coins',
          retry: false,
          message: `A pool is the curve or graduation pool of both coin ${coin.id} and coin ${r.ownerCoinId}`,
        });
      }
    }
  }
}

function countBars(
  pools: readonly { bars1m: unknown[]; bars1h: unknown[]; bars1d: unknown[] }[],
): BarCounts {
  const out = emptyCounts();
  for (const p of pools) {
    out['1m'] += p.bars1m.length;
    out['1h'] += p.bars1h.length;
    out['1d'] += p.bars1d.length;
  }
  return out;
}

function stripUndefined<T extends object>(o: T | undefined): Partial<T> {
  return Object.fromEntries(
    Object.entries(o ?? {}).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
