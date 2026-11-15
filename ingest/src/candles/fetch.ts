import {
  addCoverage,
  countCoverageRequests,
  getBars,
  getCoinPools,
  getCoverage,
  loadMetricInput,
  putBars,
  recordDataIssue,
  refreshPoolBarStats,
  upsertPool,
  type StoredPool,
} from '@memecoinipedia/db';
import { computeCoinMetrics } from '../metrics/index.js';
import { pairIdFor, type LaunchInfo, type PoolInfo } from '../sources/codex/index.js';
import { classifyProviderError, type CandleFailure } from './errors.js';
import { findCoveragePeaks } from './peaks.js';
import {
  DEFAULT_PLAN_LIMITS,
  estimateCoinUnits,
  planBaseRequests,
  planPeakRefinement,
  resolutionCode,
  summarizeDaily,
  type Interval,
  type PlanPool,
  type PlanState,
  type PoolDaily,
  type PlannedRequest,
  type PoolRole,
  type ResolutionSec,
} from './plan.js';
import { selectPools } from './poolSelection.js';
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
/** Safety stop for the base-plan loop; the plan has two phases. */
const MAX_BASE_ROUNDS = 5;

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
  const spentAtStart = codex.spend();

  const summary: CandleFetchSummary = {
    coinId: coin.id,
    mint: coin.address,
    asOf,
    pools: [],
    skippedOtherPools: 0,
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
  };
  const finish = (): void => {
    const spent = codex.spend();
    summary.units = round6(spent.units - spentAtStart.units);
    summary.lookupRequests = spent.requests - spentAtStart.requests - summary.requests;
  };

  try {
    // 1. The coin row and its pools.
    const row = await db
      .selectFrom('coins')
      .select(['id', 'launched_at', 'graduated_at'])
      .where('id', '=', coin.id)
      .executeTakeFirst();
    if (!row) {
      throw new Stop({
        reason: 'coin_not_found',
        retry: false,
        message: `No coin with id ${coin.id}`,
      });
    }

    let launchedAt = row.launched_at ? row.launched_at.getTime() / 1000 : null;
    let graduatedAt = row.graduated_at ? row.graduated_at.getTime() / 1000 : null;
    let stored = await getCoinPools(db, coin.id);

    if (stored.length === 0 || coin.refreshPools === true || launchedAt === null) {
      const found = await discoverPools();
      launchedAt ??= found.launch.createdAt;
      graduatedAt ??= found.launch.migratedAt;
      await fillCoinTimes(found.launch);
      stored = await getCoinPools(db, coin.id);
    }
    if (launchedAt === null) {
      throw new Stop({
        reason: 'missing_launch_time',
        retry: false,
        message: 'Neither the coin row nor Codex.io has a creation time',
      });
    }

    const roleOf = (p: StoredPool): PoolRole =>
      p.isGraduationPool ? 'graduation' : p.isPrimary ? 'curve' : 'other';
    const planPools: PlanPool[] = stored.map((p) => ({
      address: p.address,
      role: roleOf(p),
      createdAt: p.createdAtChain,
    }));
    const poolIds = new Map(stored.map((p) => [p.address, p.id]));
    summary.pools = stored.map((p) => ({
      address: p.address,
      role: roleOf(p),
      dex: p.dex,
      poolId: p.id,
    }));

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
        );
      }
      return { asOf, launchedAt, graduatedAt, pools: planPools, coverage, daily, limits };
    };

    const execute = async (req: PlannedRequest): Promise<void> => {
      const poolId = poolIds.get(req.poolAddress);
      if (poolId === undefined) throw new Error(`No stored pool for ${req.poolAddress}`);
      const bars = await codex.getPoolBars({
        pairAddress: req.poolAddress,
        resolution: resolutionCode(req.resolution),
        from: req.from,
        to: req.to,
      });
      summary.requests += 1;
      summary.barsFetched[countKey(req.resolution)] += bars.length;
      await putBars(db, poolId, req.resolution, bars);
      // Coverage goes in after the bars: a crash in between only repeats the request.
      await addCoverage(db, poolId, req.resolution, req.cover, req.reason);
    };

    // 2. The base plan: minute windows and daily bars, then hourly bars.
    const first = await buildState();
    summary.estimate = estimateCoinUnits(first);
    for (let round = 0; round < MAX_BASE_ROUNDS; round++) {
      const plan = planBaseRequests(round === 0 ? first : await buildState());
      if (plan.hourly.capHit) summary.hourlyCapHit = true;
      if (plan.requests.length === 0) break;
      for (const req of plan.requests) await execute(req);
    }
    if (summary.hourlyCapHit) {
      await issue('candle_hourly_cap_hit', { maxHourlyRequests: limits.maxHourlyRequests });
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
      const next = planPeakRefinement(await buildState(), findCoveragePeaks(loaded.input), done);
      if (!next.request) {
        await issue('peak_refinement_incomplete', {
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

    for (const p of stored) await refreshPoolBarStats(db, p.id);
    finish();
    return { ok: true, summary };
  } catch (err) {
    const failure = err instanceof Stop ? err.failure : classifyProviderError(err);
    if (!failure) throw err;
    finish();
    return { ok: false, ...failure, summary };
  }

  /** Looks up launch info and the pool list, stores the pools, records issues. */
  async function discoverPools(): Promise<{ launch: LaunchInfo }> {
    const launch =
      coin.launchInfo !== undefined ? coin.launchInfo : await codex.getLaunchInfo(coin.address);
    if (!launch) {
      throw new Stop({
        reason: 'token_not_found',
        retry: false,
        message: 'Codex.io does not know this token',
      });
    }
    const listing = await codex.getPools(coin.address);
    const selection = selectPools({
      pools: listing,
      migratedPoolAddress: launch.migratedPoolAddress,
      migratedAt: launch.migratedAt,
      migrated: launch.migrated,
      minSecondaryPoolLiquidityUsd: limits.minSecondaryPoolLiquidityUsd,
      maxSecondaryPools,
    });
    if (!selection.curve && !selection.graduation && selection.others.length === 0) {
      const young = launch.migratedAt !== null && asOf - launch.migratedAt < YOUNG_COIN_SEC;
      for (const i of selection.issues) await issue(i.kind, i.detail);
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
    ): Promise<number> =>
      upsertPool(db, {
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
    for (const p of selection.others) await put(p.address, p, 'other', 'unknown');

    summary.skippedOtherPools = selection.skippedOthers;
    summary.graduationPoolUnverified = selection.graduation?.unverified ?? false;
    for (const i of selection.issues) await issue(i.kind, i.detail);
    return { launch };
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

  async function issue(kind: string, detail: Record<string, unknown>): Promise<void> {
    await recordDataIssue(db, coin.id, kind, detail);
    if (!summary.issues.includes(kind)) summary.issues.push(kind);
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
