import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { upsertCoin, getBars, loadMetricInput } from '@memecoinipedia/db';
import { createTestDatabase, type TestDatabase } from '@memecoinipedia/db/testing';
import {
  EXHAUSTIVE_PLAN_LIMITS,
  METRICS_VERSION,
  computeMetricsForCoin,
  fetchCandlesForCoin,
  type CandleDeps,
} from '../../src/candles/index.js';
import { computeCoinMetrics } from '../../src/metrics/index.js';
import { UnitBudget } from '../../src/sources/budget.js';
import { CodexClient } from '../../src/sources/codex/index.js';
import type { FetchLike } from '../../src/sources/http.js';
import {
  adminUrl,
  describeDb,
  loadCandleFixture,
  replayFetch,
  snapshotTables,
  type CandleFixture,
  type Replay,
} from './helpers.js';

const SYMBOLS = ['USOF', 'VANGOAT', 'WIZARD'] as const;
/** The recordings were made under the exhaustive plan, so they replay under it. */
const EX = { limits: EXHAUSTIVE_PLAN_LIMITS };

let t: TestDatabase;
beforeEach(async () => {
  if (adminUrl) t = await createTestDatabase(adminUrl);
});
afterEach(async () => {
  if (adminUrl) await t.drop();
});

function makeClient(fetch: FetchLike, budget?: UnitBudget): CodexClient {
  return new CodexClient({
    apiKey: 'test-key-not-real',
    fetch,
    budget: budget ?? new UnitBudget(),
    http: { maxRetries: 0, sleep: async () => {} },
  });
}

async function addCoin(f: CandleFixture): Promise<number> {
  return upsertCoin(t.db, {
    chain: 'solana',
    address: f.mint,
    ticker: f.symbol,
    launchpad: 'pump.fun',
  });
}

function depsFor(f: CandleFixture, replay: Replay, budget?: UnitBudget): CandleDeps {
  return {
    db: t.db,
    codex: makeClient(replay.fetch, budget),
    clock: () => new Date(f.asOf * 1000),
  };
}

/** The compute units the recorded responses report, in total. */
function recordedUnits(f: CandleFixture): number {
  let micro = 0;
  for (const [, body] of f.responses) {
    const c = (body as { data: { usageData?: { total?: { computeUnits?: number | string } } } })
      .data.usageData?.total?.computeUnits;
    micro += Number(c ?? 0);
  }
  return micro / 1e6;
}

describeDb('fetchCandlesForCoin on recorded fixtures', () => {
  describe.each(SYMBOLS)('%s', (symbol) => {
    it('fetches, reports what it spent, and makes no request and no change the second time', async () => {
      const f = loadCandleFixture(symbol);
      const id = await addCoin(f);
      const replay = replayFetch([f]);
      const deps = depsFor(f, replay);

      const first = await fetchCandlesForCoin(deps, { id, address: f.mint }, EX);
      expect(first.ok).toBe(true);
      const s = first.summary;
      // Every recorded response was used, nothing else was asked.
      expect(replay.queries).toHaveLength(f.responses.length);
      expect(s.requests).toBe(replay.barsQueries().length);
      expect(s.lookupRequests).toBe(2);
      expect(s.units).toBeCloseTo(recordedUnits(f), 4);
      expect(s.estimate!.initialUnits).toBeGreaterThan(0);
      expect(s.pools.some((p) => p.role === 'graduation')).toBe(true);
      expect(s.barsStored['1m']).toBeGreaterThan(0);
      expect(s.barsStored['1d']).toBeGreaterThan(0);
      expect(s.barsFetched['1m']).toBeGreaterThan(0);

      // The coin row got its launch and graduation time.
      const coin = await t.db
        .selectFrom('coins')
        .select(['launched_at', 'graduated_at'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      expect(coin.launched_at).not.toBeNull();
      expect(coin.graduated_at).not.toBeNull();

      // Primary pools are flagged; the graduation pool is marked as such.
      const pools = await t.db.selectFrom('pools').selectAll().where('coin_id', '=', id).execute();
      expect(pools.filter((p) => p.is_graduation_pool)).toHaveLength(1);
      expect(pools.filter((p) => p.is_primary).length).toBeGreaterThanOrEqual(1);
      expect(pools.every((p) => p.first_bar_at !== null || !p.is_primary)).toBe(true);

      const before = await snapshotTables(t.db);
      const requestsBefore = replay.queries.length;
      const second = await fetchCandlesForCoin(deps, { id, address: f.mint }, EX);
      expect(second.ok).toBe(true);
      expect(replay.queries.length).toBe(requestsBefore); // no request at all, lookups included
      expect(second.summary.requests).toBe(0);
      expect(second.summary.units).toBe(0);
      expect(second.summary.barsFetched).toEqual({ '1m': 0, '1h': 0, '1d': 0 });
      expect(await snapshotTables(t.db)).toEqual(before); // not one row changed
      expect(second.summary.barsStored).toEqual(s.barsStored);
    });

    it('writes metrics with ath at most the wick, the same values on a second run', async () => {
      const f = loadCandleFixture(symbol);
      const id = await addCoin(f);
      const deps = depsFor(f, replayFetch([f]));
      expect((await fetchCandlesForCoin(deps, { id, address: f.mint }, EX)).ok).toBe(true);

      const run1 = await computeMetricsForCoin(deps, { id });
      expect(run1.ok).toBe(true);
      const row1 = await t.db
        .selectFrom('coins')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      const snap1 = await snapshotTables(t.db);

      const run2 = await computeMetricsForCoin(deps, { id });
      expect(run2).toEqual(run1);
      expect(await snapshotTables(t.db)).toEqual(snap1);

      expect(row1.metrics_version).toBe(METRICS_VERSION);
      expect(row1.metrics_as_of).toEqual(new Date(f.asOf * 1000));
      expect(row1.metrics_computed_at).toEqual(new Date(f.asOf * 1000));
      expect(row1.ath_wick_market_cap_usd).not.toBeNull();
      expect(row1.ath_market_cap_usd).not.toBeNull();
      expect(row1.ath_market_cap_usd!).toBeLessThanOrEqual(row1.ath_wick_market_cap_usd!);
      expect(row1.seconds_above_1m!).toBeLessThanOrEqual(row1.seconds_above_100k!);
      expect(row1.seconds_above_100m!).toBeLessThanOrEqual(row1.seconds_above_10m!);
      expect(row1.rug_pattern).not.toBeNull();
      expect(['alive', 'dead', 'rugged', 'unknown']).toContain(row1.status);
      expect(row1.status).toBe(run1.ok ? run1.status : '');
      expect(row1.ath_pool_id).not.toBeNull();
      expect(row1.ath_wick_pool_id).not.toBeNull();

      // The stored columns are exactly the library's result for the stored bars.
      const loaded = await loadMetricInput(t.db, id, f.asOf);
      if (!loaded.ok) throw new Error('no input');
      const direct = computeCoinMetrics(loaded.input);
      expect(row1.ath_market_cap_usd).toBe(direct.athMarketCapUsd);
      expect(row1.ath_at).toEqual(new Date(direct.athAt! * 1000));
      expect(row1.ath_wick_market_cap_usd).toBe(direct.athWickMarketCapUsd);
      expect(row1.ath_liquidity_usd).toBe(direct.athLiquidityUsd);
      expect(row1.ath_hour_volume_usd).toBe(direct.athHourVolumeUsd);
      expect(direct.athHourVolumeUsd).not.toBeNull();
      expect(row1.ath_hour_volume_usd).not.toBeNull();
      expect(row1.seconds_above_100k).toBe(direct.secondsAbove[0]);
      expect(row1.max_drawdown_pct).toBe(direct.maxDrawdownPct);
      expect(row1.metric_flags).toEqual(direct.flags);
    });
  });

  it('WIZARD: the peak a year after launch is found by refinement, and the flag clears', async () => {
    const f = loadCandleFixture('WIZARD');
    const id = await addCoin(f);
    const replay = replayFetch([f]);
    const deps = depsFor(f, replay);
    const r = await fetchCandlesForCoin(deps, { id, address: f.mint }, EX);
    expect(r.summary.refinementRounds).toBe(1);
    expect(r.summary.refinementRequestsTotal).toBe(1);
    expect(r.summary.flags).not.toContain('peak_outside_minute_coverage');
    const refinement = await t.db
      .selectFrom('candle_coverage')
      .selectAll()
      .where('reason', '=', 'peak_refinement')
      .execute();
    expect(refinement).toHaveLength(1);
    expect(refinement[0]!.resolution_sec).toBe(60);
    expect(r.summary.issues).not.toContain('peak_refinement_incomplete');

    const m = await computeMetricsForCoin(deps, { id });
    if (!m.ok) throw new Error('metrics failed');
    // The ATH sits in the refined window, a year after the coin's first days.
    expect(m.result.athAt).toBeGreaterThan(refinement[0]!.from_t);
    expect(m.result.athAt!).toBeLessThanOrEqual(refinement[0]!.to_t);
    expect(Math.round(m.result.athMarketCapUsd!)).toBe(2_655_370);
  });

  it('VANGOAT: a long, sparse life hits the hourly cap, which is reported once', async () => {
    const f = loadCandleFixture('VANGOAT');
    const id = await addCoin(f);
    const deps = depsFor(f, replayFetch([f]));
    const r = await fetchCandlesForCoin(deps, { id, address: f.mint }, EX);
    expect(r.summary.hourlyCapHit).toBe(true);
    expect(r.summary.issues).toContain('candle_hourly_cap_hit');
    expect(r.summary.issueRecords).toEqual([
      {
        kind: 'candle_hourly_cap_hit',
        detail: expect.objectContaining({ maxHourlyRequests: expect.any(Number) }),
      },
    ]);
    // The fetcher reports the issue; it writes none (the candles stage does).
    const again = await fetchCandlesForCoin(deps, { id, address: f.mint }, EX);
    expect(again.summary.issueRecords).toEqual(r.summary.issueRecords);
    expect(await t.db.selectFrom('data_issues').selectAll().execute()).toEqual([]);
    // Six pools are listed; only the two with real liquidity are fetched.
    expect(r.summary.pools).toHaveLength(2);
    expect(r.summary.skippedOtherPools).toBe(4);
  });

  it('VANGOAT: fetches no more than the hourly cap allows', async () => {
    const f = loadCandleFixture('VANGOAT');
    const id = await addCoin(f);
    const deps = depsFor(f, replayFetch([f]));
    const r = await fetchCandlesForCoin(
      deps,
      { id, address: f.mint },
      { limits: { ...EXHAUSTIVE_PLAN_LIMITS, maxHourlyRequests: 8 } },
    );
    const hourly = await t.db
      .selectFrom('candle_coverage')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('resolution_sec', '=', 3600)
      .executeTakeFirstOrThrow();
    expect(hourly.n).toBeLessThanOrEqual(8);
    expect(r.ok).toBe(true);
  });

  describe('failures and resuming', () => {
    it('returns a retryable failure for a provider outage, and a rerun completes with the same rows as an uninterrupted run', async () => {
      const f = loadCandleFixture('USOF');
      const id = await addCoin(f);
      const flaky = replayFetch([f], { fail: (_q, n) => (n === 6 ? 503 : null) });
      const broken = await fetchCandlesForCoin(depsFor(f, flaky), { id, address: f.mint }, EX);
      expect(broken.ok).toBe(false);
      if (broken.ok) return;
      expect(broken.reason).toBe('provider_unavailable');
      expect(broken.retry).toBe(true);
      expect(broken.message).not.toContain('test-key');
      expect(broken.summary.requests).toBeGreaterThan(0);

      const healthy = replayFetch([f]);
      const resumed = await fetchCandlesForCoin(depsFor(f, healthy), { id, address: f.mint }, EX);
      expect(resumed.ok).toBe(true);
      // The rerun asked only for what was missing, not for the first requests again.
      expect(healthy.queries.length).toBeLessThan(f.responses.length);
      const interrupted = await comparable();

      // The same coin in a fresh database, run straight through.
      await t.drop();
      t = await createTestDatabase(adminUrl!);
      const id2 = await addCoin(f);
      await fetchCandlesForCoin(depsFor(f, replayFetch([f])), { id: id2, address: f.mint }, EX);
      expect(await comparable()).toEqual(interrupted);
    });

    it('stops at the unit budget, says no retry, and resumes under a bigger one', async () => {
      const f = loadCandleFixture('USOF');
      const id = await addCoin(f);
      const small = new UnitBudget({ ceilingUnits: 20 });
      const stopped = await fetchCandlesForCoin(
        depsFor(f, replayFetch([f]), small),
        {
          id,
          address: f.mint,
        },
        EX,
      );
      expect(stopped.ok).toBe(false);
      if (stopped.ok) return;
      expect(stopped.reason).toBe('budget_exhausted');
      expect(stopped.retry).toBe(false);
      expect(small.summary('codex').units).toBeLessThanOrEqual(20);

      const done = await fetchCandlesForCoin(
        depsFor(f, replayFetch([f]), new UnitBudget({ ceilingUnits: 100 })),
        {
          id,
          address: f.mint,
        },
        EX,
      );
      expect(done.ok).toBe(true);
    });

    it('answers a bad key as a failure that should not be retried', async () => {
      const f = loadCandleFixture('USOF');
      const id = await addCoin(f);
      const bad = replayFetch([f], { fail: () => 401 });
      const r = await fetchCandlesForCoin(depsFor(f, bad), { id, address: f.mint }, EX);
      expect(r).toMatchObject({ ok: false, reason: 'provider_auth', retry: false });
    });

    it('answers an unknown coin id without calling the provider', async () => {
      const f = loadCandleFixture('USOF');
      const replay = replayFetch([f]);
      const r = await fetchCandlesForCoin(depsFor(f, replay), { id: 999_999, address: f.mint }, EX);
      expect(r).toMatchObject({ ok: false, reason: 'coin_not_found', retry: false });
      expect(replay.queries).toEqual([]);
    });

    it('rethrows an error that is not a provider failure', async () => {
      const f = loadCandleFixture('USOF');
      const id = await addCoin(f);
      const deps = depsFor(f, replayFetch([f]));
      await t.db.destroy();
      await expect(fetchCandlesForCoin(deps, { id, address: f.mint }, EX)).rejects.toThrow();
      // Reopen so afterEach can drop the database.
      const { createDb } = await import('@memecoinipedia/db');
      t = { ...t, db: createDb(t.url) };
    });
  });
});

/** Stored bars and coverage, without ids that differ between databases or time stamps. */
async function comparable() {
  const chunks = await sql<Record<string, unknown>>`
    select p.address, c.resolution_sec, c.chunk_start, c.t, c.o, c.h, c.l, c.c, c.volume_usd,
           c.trades, c.traders, c.liquidity_usd
    from candle_chunks c join pools p on p.id = c.pool_id
    order by p.address, c.resolution_sec, c.chunk_start`.execute(t.db);
  const cover = await sql<Record<string, unknown>>`
    select p.address, c.resolution_sec, c.from_t, c.to_t, c.reason
    from candle_coverage c join pools p on p.id = c.pool_id
    order by p.address, c.resolution_sec, c.from_t, c.to_t`.execute(t.db);
  return JSON.parse(JSON.stringify({ chunks: chunks.rows, cover: cover.rows })) as unknown;
}

// ---------------------------------------------------------------------------
// Synthetic provider answers for shapes the recordings do not cover.

const MINT = 'Df6yfrKC8kZE3KNkrHERKzAetSxbrWeniQfyJY4Jpump';
const CURVE_POOL = 'DGDZ7bpMogjUDeHN28ZYzF3jP6p9UzEgFhK7rxGSAS1x';
const NOW = 1_800_000_000;
const usage = { total: { computeUnits: 4_000_000 } };

function synthetic(opts: {
  migrated: boolean;
  migratedAt: number | null;
  pairs: unknown[];
  createdAt?: number;
}): { fetch: FetchLike; queries: string[] } {
  const queries: string[] = [];
  const fetchImpl: FetchLike = async (_url, init) => {
    const query = (JSON.parse(init.body) as { query: string }).query;
    queries.push(query);
    let data: unknown;
    if (query.includes('token(input')) {
      data = {
        token: {
          address: MINT,
          symbol: 'SYN',
          name: 'Synthetic',
          createdAt: opts.createdAt ?? NOW - 5 * 86_400,
          creatorAddress: null,
          launchpad: {
            launchpadName: 'Pump.fun',
            migrated: opts.migrated,
            migratedAt: opts.migratedAt,
            migratedPoolAddress: null,
            completed: opts.migrated,
            completedAt: opts.migratedAt,
            poolAddress: null,
          },
        },
        usageData: usage,
      };
    } else if (query.includes('listPairsWithMetadataForToken')) {
      data = { listPairsWithMetadataForToken: { results: opts.pairs }, usageData: usage };
    } else {
      data = { getBars: { t: [], o: [], h: [], l: [], c: [] }, usageData: usage };
    }
    const text = JSON.stringify({ data });
    return { status: 200, ok: true, headers: { get: () => null }, text: async () => text };
  };
  return { fetch: fetchImpl, queries };
}

const curvePair = {
  liquidity: 0,
  volume: 0,
  quoteToken: 'token1',
  backingToken: { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL' },
  exchange: { name: 'Pump.fun' },
  pair: {
    address: CURVE_POOL,
    createdAt: NOW - 5 * 86_400,
    protocol: 'Pump',
    exchangeHash: null,
    token0: MINT,
    token1: null,
  },
};

describeDb('fetchCandlesForCoin with synthetic answers', () => {
  const clock = (): Date => new Date(NOW * 1000);

  it('reports graduation_pool_not_found once for a graduated coin with no graduation pool, and carries on', async () => {
    const id = await upsertCoin(t.db, { chain: 'solana', address: MINT });
    const s = synthetic({ migrated: true, migratedAt: NOW - 4 * 86_400, pairs: [curvePair] });
    const deps: CandleDeps = { db: t.db, codex: makeClient(s.fetch), clock };

    const r = await fetchCandlesForCoin(deps, { id, address: MINT });
    expect(r.ok).toBe(true);
    expect(r.summary.issues).toEqual(['graduation_pool_not_found']);
    expect(r.summary.pools.map((p) => p.role)).toEqual(['curve']);
    expect(r.summary.requests).toBeGreaterThan(0); // the curve's minute and daily bars

    expect(r.summary.issueRecords.map((i) => i.kind)).toEqual(['graduation_pool_not_found']);
    expect(r.summary.issueKindsChecked).toContain('graduation_pool_not_found');
    // Reported, not written: the candles stage records issues.
    expect(await t.db.selectFrom('data_issues').selectAll().execute()).toEqual([]);
    // A second run finds the pools stored and does not look them up again.
    const again = await fetchCandlesForCoin(deps, { id, address: MINT });
    expect(again.summary.issueRecords).toEqual([]);
    expect(again.summary.issueKindsChecked).not.toContain('graduation_pool_not_found');
    const pools = await t.db.selectFrom('pools').selectAll().execute();
    expect(pools).toHaveLength(1);
    expect(pools[0]).toMatchObject({
      address: CURVE_POOL,
      is_primary: true,
      is_graduation_pool: false,
    });
  });

  it('does not record the issue for a coin that never graduated', async () => {
    const id = await upsertCoin(t.db, { chain: 'solana', address: MINT });
    const s = synthetic({ migrated: false, migratedAt: null, pairs: [curvePair] });
    const r = await fetchCandlesForCoin(
      { db: t.db, codex: makeClient(s.fetch), clock },
      { id, address: MINT },
    );
    expect(r.ok).toBe(true);
    expect(r.summary.issues).toEqual([]);
  });

  it('fails with no_pools, without retry for an old coin and with retry for a new one', async () => {
    const id = await upsertCoin(t.db, { chain: 'solana', address: MINT });
    const old = synthetic({ migrated: true, migratedAt: NOW - 30 * 86_400, pairs: [] });
    const a = await fetchCandlesForCoin(
      { db: t.db, codex: makeClient(old.fetch), clock },
      { id, address: MINT },
    );
    expect(a).toMatchObject({ ok: false, reason: 'no_pools', retry: false });

    const fresh = synthetic({
      migrated: true,
      migratedAt: NOW - 600,
      pairs: [],
      createdAt: NOW - 3_600,
    });
    const b = await fetchCandlesForCoin(
      { db: t.db, codex: makeClient(fresh.fetch), clock },
      { id, address: MINT },
    );
    expect(b).toMatchObject({ ok: false, reason: 'no_pools', retry: true });
  });

  it('fails with token_not_found when Codex.io does not know the token', async () => {
    const id = await upsertCoin(t.db, { chain: 'solana', address: MINT });
    const unknown: FetchLike = async () => {
      const text = JSON.stringify({ data: { token: null, usageData: usage } });
      return { status: 200, ok: true, headers: { get: () => null }, text: async () => text };
    };
    const r = await fetchCandlesForCoin(
      { db: t.db, codex: makeClient(unknown), clock },
      { id, address: MINT },
    );
    expect(r).toMatchObject({ ok: false, reason: 'token_not_found', retry: false });
  });

  it('uses launch info handed in by the caller instead of asking for it', async () => {
    const id = await upsertCoin(t.db, { chain: 'solana', address: MINT });
    const s = synthetic({ migrated: false, migratedAt: null, pairs: [curvePair] });
    const client = makeClient(s.fetch);
    await fetchCandlesForCoin(
      { db: t.db, codex: client, clock },
      {
        id,
        address: MINT,
        launchInfo: {
          mint: MINT,
          symbol: 'SYN',
          name: 'Synthetic',
          createdAt: NOW - 5 * 86_400,
          creator: null,
          launchpadName: 'Pump.fun',
          migrated: false,
          migratedAt: null,
          migratedPoolAddress: null,
          completed: false,
          completedAt: null,
          launchpadPoolAddress: null,
        },
      },
    );
    expect(s.queries.some((q) => q.includes('token(input'))).toBe(false);
    expect(s.queries.some((q) => q.includes('listPairsWithMetadataForToken'))).toBe(true);
  });
});

describeDb('computeMetricsForCoin without data', () => {
  it('fails cleanly for an unknown coin and a coin without launch time; a coin without bars gets the no_candles flag', async () => {
    const deps = { db: t.db, clock: () => new Date(NOW * 1000) };
    expect(await computeMetricsForCoin(deps, { id: 123_456 })).toMatchObject({
      ok: false,
      reason: 'coin_not_found',
    });
    const id = await upsertCoin(t.db, { chain: 'solana', address: MINT });
    expect(await computeMetricsForCoin(deps, { id })).toMatchObject({
      ok: false,
      reason: 'missing_launch_time',
    });
    await t.db
      .updateTable('coins')
      .set({ launched_at: new Date((NOW - 86_400) * 1000) })
      .where('id', '=', id)
      .execute();
    // No bar at all is not a failure: the coin gets a null ATH and the `no_candles` flag.
    const none = await computeMetricsForCoin(deps, { id });
    expect(none).toMatchObject({ ok: true, noCandles: true, barCount: 0, status: 'unknown' });
    const row = await t.db
      .selectFrom('coins')
      .select(['metrics_version', 'status', 'ath_market_cap_usd', 'ath_at', 'metric_flags'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      metrics_version: METRICS_VERSION,
      status: 'unknown',
      ath_market_cap_usd: null,
      ath_at: null,
      metric_flags: ['no_candles'],
    });
    expect(await getBars(t.db, 1, 60)).toEqual([]);
  });
});
