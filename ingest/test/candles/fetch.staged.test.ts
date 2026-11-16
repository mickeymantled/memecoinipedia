import { afterEach, beforeEach, expect, it } from 'vitest';
import { upsertCoin } from '@memecoinipedia/db';
import { createTestDatabase, type TestDatabase } from '@memecoinipedia/db/testing';
import {
  EXHAUSTIVE_PLAN_LIMITS,
  computeMetricsForCoin,
  fetchCandlesForCoin,
  METRICS_VERSION,
  type CandleDeps,
} from '../../src/candles/index.js';
import { UnitBudget } from '../../src/sources/budget.js';
import { CodexClient } from '../../src/sources/codex/index.js';
import type { FetchLike } from '../../src/sources/http.js';
import { adminUrl, describeDb, snapshotTables } from './helpers.js';
import { minute, simProvider, type SimCoin, type SimMinute, type SimPool } from './sim.js';

const DAY = 86_400;
const T0 = 1_767_225_600;
const LAUNCH = T0 + 3 * 3_600;
const GRAD = LAUNCH + 2 * 3_600;
const NOW = GRAD + 5 * DAY;

let t: TestDatabase;
beforeEach(async () => {
  if (adminUrl) t = await createTestDatabase(adminUrl);
});
afterEach(async () => {
  if (adminUrl) await t.drop();
});

function makeClient(fetch: FetchLike): CodexClient {
  return new CodexClient({
    apiKey: 'test-key-not-real',
    fetch,
    budget: new UnitBudget(),
    http: { maxRetries: 0, sleep: async () => {} },
  });
}

/** `n` minutes from `start`, one per minute, at the price `price(i)`. */
function dense(start: number, n: number, price: (i: number) => number): SimMinute[] {
  return Array.from({ length: n }, (_, i) => minute(start + i * 60, price(i), 3_000));
}

const mcap = (usd: number): number => usd / 1e9;

interface Scenario {
  coin: SimCoin;
  grad: SimPool;
  curve: SimPool;
}

/** A graduated coin whose launch info names the graduation pool. `tag` makes addresses unique. */
function scenario(
  tag: string,
  gradMinutes: SimMinute[],
  curveMinutes: SimMinute[] = [],
  extraPools: SimPool[] = [],
): Scenario {
  const curve: SimPool = {
    address: 'B'.repeat(43) + tag,
    exchange: 'Pump.fun',
    protocol: 'Pump',
    createdAt: LAUNCH,
    liquidity: 0,
    minutes: curveMinutes,
  };
  const grad: SimPool = {
    address: 'C'.repeat(43) + tag,
    exchange: 'PumpSwap',
    protocol: 'PumpAmm',
    createdAt: GRAD,
    liquidity: 30_000,
    minutes: gradMinutes,
  };
  return {
    curve,
    grad,
    coin: {
      mint: 'D'.repeat(43) + tag,
      createdAt: LAUNCH,
      migratedAt: GRAD,
      migratedPoolAddress: grad.address,
      pools: [curve, grad, ...extraPools],
    },
  };
}

/** Rising from $20,000 to $50,000 over 300 minutes, then nothing: a coin that never got near $100k. */
const smallCoin = (tag: string) =>
  scenario(
    tag,
    dense(GRAD, 300, (i) => mcap(20_000 + i * 100)),
  );

/** Opens at $60,000, climbs to $500,000 in 200 minutes, trades sparsely on day 2. */
const midCoin = (tag: string) =>
  scenario(tag, [
    ...dense(GRAD, 200, (i) => mcap(60_000 + i * 2_211)),
    ...Array.from({ length: 6 }, (_, k) => minute(GRAD + 2 * DAY + k * 600, mcap(200_000))),
  ]);

async function addCoin(s: Scenario, rough: number | null = null): Promise<number> {
  const id = await upsertCoin(t.db, {
    chain: 'solana',
    address: s.coin.mint,
    ticker: 'SIM',
    launchpad: 'pump.fun',
  });
  if (rough !== null) {
    await t.db
      .updateTable('coins')
      .set({ rough_ath_market_cap_usd: rough })
      .where('id', '=', id)
      .execute();
  }
  return id;
}

const depsFor = (fetch: FetchLike, db = t.db): CandleDeps => ({
  db,
  codex: makeClient(fetch),
  clock: () => new Date(NOW * 1000),
});

describeDb('the staged fetch on simulated trading', () => {
  it('screens out a small coin with one bars request and one launch lookup, and stores it as screened out', async () => {
    const s = smallCoin('1');
    const id = await addCoin(s);
    const sim = simProvider(s.coin);
    const deps = depsFor(sim.fetch);

    const r = await fetchCandlesForCoin(deps, { id, address: s.coin.mint });
    expect(r.ok).toBe(true);
    const sum = r.summary;
    expect(sum.path).toBe('screened_out');
    expect(sum.screenedOut).toBe(true);
    expect(sum.requests).toBe(1);
    expect(sum.lookupRequests).toBe(1);
    expect(sum.units).toBe(8);
    expect(sum.w).toBeLessThan(90_000);
    // No pool list, no minute bars, no hourly bars.
    expect(sim.lookups()).toHaveLength(1);
    expect(sim.lookups()[0]).toContain('token(input');
    expect(sim.barsQueries()).toHaveLength(1);
    expect(sim.barsQueries()[0]).toContain('resolution:"1D"');
    expect(sum.barsStored).toEqual({ '1m': 0, '1h': 0, '1d': 1 });
    expect(sum.pools.map((p) => p.role)).toEqual(['graduation']);

    // A second run asks for nothing and changes nothing.
    const before = await snapshotTables(t.db);
    const again = await fetchCandlesForCoin(deps, { id, address: s.coin.mint });
    expect(again.summary.path).toBe('screened_out');
    expect(sim.queries).toHaveLength(2);
    expect(again.summary.units).toBe(0);
    expect(await snapshotTables(t.db)).toEqual(before);

    // The metrics come from the stored daily bar alone.
    const m = await computeMetricsForCoin(deps, { id });
    expect(m.ok && m.screenedOut).toBe(true);
    const row = await t.db
      .selectFrom('coins')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row.metric_flags).toEqual(['screened_out']);
    expect(row.ath_market_cap_usd).toBeNull();
    expect(row.ath_at).toBeNull();
    expect(row.ath_pool_id).toBeNull();
    expect(row.seconds_to_ath).toBeNull();
    expect(row.seconds_above_100k).toBeNull();
    expect(row.seconds_above_1m).toBeNull();
    expect(row.max_drawdown_pct).toBeNull();
    // No 1-minute bars: no wick either (daily bars never feed it), and no ATH outputs.
    expect(row.ath_wick_market_cap_usd).toBeNull();
    expect(row.ath_wick_at).toBeNull();
    expect(row.ath_wick_pool_id).toBeNull();
    expect(row.ath_liquidity_usd).toBeNull();
    expect(row.ath_hour_volume_usd).toBeNull();
    expect(row.ath_near_volume_usd).toBeNull();
    expect(row.ath_backed_market_cap_usd).toBeNull();
    expect(row.metrics_version).toBe(METRICS_VERSION);
    expect(row.metrics_as_of).toEqual(new Date(NOW * 1000));
    expect(row.metrics_computed_at).toEqual(new Date(NOW * 1000));
    // The coin traded on its first day and the line (volume, liquidity) was met within the last 7 days.
    expect(row.status).toBe('alive');
    const snap = await snapshotTables(t.db);
    await computeMetricsForCoin(deps, { id });
    expect(await snapshotTables(t.db)).toEqual(snap);
  });

  it('takes the light path for a mid-size coin: primary pool only, no pool list, same ATH as the exhaustive plan', async () => {
    const s = midCoin('2');
    const id = await addCoin(s);
    const sim = simProvider(s.coin);
    const deps = depsFor(sim.fetch);

    const r = await fetchCandlesForCoin(deps, { id, address: s.coin.mint });
    expect(r.ok).toBe(true);
    expect(r.summary.path).toBe('light');
    expect(r.summary.w).toBeCloseTo(60_000 + 199 * 2_211, 0);
    // The screen, 1,500 minutes, and one hourly window over days 0 to 5 (days 0 and 2 are above $80,000).
    expect(r.summary.requests).toBe(3);
    expect(r.summary.lookupRequests).toBe(1);
    expect(r.summary.units).toBe(16);
    expect(sim.lookups()).toHaveLength(1);
    const resolutions = sim.barsQueries().map((q) => /resolution:"(\w+)"/.exec(q)![1]);
    expect(resolutions).toEqual(['1D', '1', '60']);
    expect(r.summary.pools.map((p) => p.role)).toEqual(['graduation']);

    const before = await snapshotTables(t.db);
    const again = await fetchCandlesForCoin(deps, { id, address: s.coin.mint });
    expect(again.ok).toBe(true);
    expect(sim.queries).toHaveLength(4);
    expect(await snapshotTables(t.db)).toEqual(before);

    const m = await computeMetricsForCoin(deps, { id });
    expect(m.ok && !m.screenedOut).toBe(true);
    const staged = await t.db
      .selectFrom('coins')
      .select([
        'ath_market_cap_usd',
        'ath_at',
        'seconds_above_100k',
        'ath_wick_market_cap_usd',
        'ath_liquidity_usd',
        'ath_hour_volume_usd',
      ])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(staged.ath_market_cap_usd).toBeGreaterThan(400_000);

    // The same trading under the exhaustive plan, in its own database.
    const other = await createTestDatabase(adminUrl!);
    try {
      const sim2 = simProvider(s.coin);
      const deps2 = depsFor(sim2.fetch, other.db);
      const id2 = await upsertCoin(other.db, {
        chain: 'solana',
        address: s.coin.mint,
        ticker: 'SIM',
        launchpad: 'pump.fun',
      });
      const ex = await fetchCandlesForCoin(
        deps2,
        { id: id2, address: s.coin.mint },
        { limits: EXHAUSTIVE_PLAN_LIMITS },
      );
      expect(ex.summary.path).toBe('exhaustive');
      expect(ex.summary.units).toBeGreaterThan(r.summary.units);
      await computeMetricsForCoin(deps2, { id: id2 });
      const exRow = await other.db
        .selectFrom('coins')
        .select([
          'ath_market_cap_usd',
          'ath_at',
          'seconds_above_100k',
          'ath_wick_market_cap_usd',
          'ath_liquidity_usd',
          'ath_hour_volume_usd',
        ])
        .where('id', '=', id2)
        .executeTakeFirstOrThrow();
      expect(staged).toEqual(exRow);
    } finally {
      await other.drop();
    }
  });

  it('sends a coin to the full path when the Dune peak is far above its graduation pool, and finds the peak in the other pool', async () => {
    const other: SimPool = {
      address: 'E'.repeat(43) + '3',
      exchange: 'Raydium',
      protocol: 'Raydium',
      createdAt: GRAD + 3 * DAY,
      liquidity: 30_000,
      // Three days after the graduation pool's minutes: no 1-minute bars cover it.
      minutes: dense(GRAD + 3 * DAY, 100, (i) => mcap(300_000 + i * 1_000)),
    };
    const s = scenario(
      '3',
      dense(GRAD, 300, (i) => mcap(20_000 + i * 100)),
      [],
      [other],
    );
    const id = await addCoin(s, 420_000);
    const sim = simProvider(s.coin);
    const deps = depsFor(sim.fetch);

    const r = await fetchCandlesForCoin(deps, { id, address: s.coin.mint });
    expect(r.ok).toBe(true);
    expect(r.summary.path).toBe('full');
    expect(r.summary.escalated).toBe(true);
    expect(r.summary.w).toBeGreaterThan(390_000);
    expect(r.summary.pools.map((p) => p.role).sort()).toEqual(['curve', 'graduation', 'other']);
    expect(sim.lookups().some((q) => q.includes('listPairsWithMetadataForToken'))).toBe(true);
    // The peak is on the other pool, which has no minute bars until refinement finds them.
    expect(r.summary.refinementRounds).toBeGreaterThanOrEqual(1);
    expect(r.summary.flags).not.toContain('peak_outside_minute_coverage');
    await computeMetricsForCoin(deps, { id });
    const row = await t.db
      .selectFrom('coins')
      .select(['ath_market_cap_usd', 'metric_flags'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row.ath_market_cap_usd).toBeGreaterThan(390_000);
    expect(row.metric_flags).not.toContain('screened_out');

    const before = await snapshotTables(t.db);
    await fetchCandlesForCoin(deps, { id, address: s.coin.mint });
    expect(await snapshotTables(t.db)).toEqual(before);
  });

  it('screens the same coin out when the Dune peak is not far above, and after recomputing W when the other pools are quiet', async () => {
    const quiet: SimPool = {
      address: 'E'.repeat(43) + '4',
      exchange: 'Raydium',
      protocol: 'Raydium',
      createdAt: GRAD + 3_600,
      liquidity: 30_000,
      minutes: dense(GRAD + 3_600, 100, (i) => mcap(10_000 + i * 10)),
    };
    // Peak known to Dune is 75,000: exactly 1.5 times 50,000 is not "more than".
    const a = scenario(
      '4',
      dense(GRAD, 300, (i) => mcap(20_000 + i * 100)),
      [],
      [quiet],
    );
    const idA = await addCoin(a, 74_000);
    const simA = simProvider(a.coin);
    const ra = await fetchCandlesForCoin(depsFor(simA.fetch), { id: idA, address: a.coin.mint });
    expect(ra.summary.path).toBe('screened_out');
    expect(ra.summary.escalated).toBe(false);
    expect(ra.summary.units).toBe(8);

    // A Dune print of 800,000 escalates; the pool list and the quiet pool's daily bars show nothing, so it is screened out.
    const b = scenario(
      '5',
      dense(GRAD, 300, (i) => mcap(20_000 + i * 100)),
      [],
      [{ ...quiet, address: 'E'.repeat(43) + '5' }],
    );
    const idB = await addCoin(b, 800_000);
    const simB = simProvider(b.coin);
    const rb = await fetchCandlesForCoin(depsFor(simB.fetch), { id: idB, address: b.coin.mint });
    expect(rb.summary.path).toBe('screened_out');
    expect(rb.summary.escalated).toBe(true);
    // launch info, daily bars, pool list, daily bars of the quiet pool: four requests of 4 units.
    expect(rb.summary.units).toBe(16);
    expect(simB.barsQueries().every((q) => q.includes('resolution:"1D"'))).toBe(true);
    const before = await snapshotTables(t.db);
    await fetchCandlesForCoin(depsFor(simB.fetch), { id: idB, address: b.coin.mint });
    expect(simB.queries).toHaveLength(4);
    expect(await snapshotTables(t.db)).toEqual(before);
  });

  it('fetches the bonding curve, and looks up the pool list for it, only when the graduation pool opens at $90,000 or more', async () => {
    const s = scenario(
      '6',
      dense(GRAD, 100, (i) => mcap(120_000 + i * 800)),
      dense(LAUNCH, 120, (i) => mcap(30_000 + i * 740)),
    );
    const id = await addCoin(s);
    const sim = simProvider(s.coin);
    const deps = depsFor(sim.fetch);
    const r = await fetchCandlesForCoin(deps, { id, address: s.coin.mint });
    expect(r.ok).toBe(true);
    expect(r.summary.path).toBe('light');
    expect(sim.lookups().filter((q) => q.includes('listPairsWithMetadataForToken'))).toHaveLength(
      1,
    );
    const curveQueries = sim
      .barsQueries()
      .filter((q) => q.includes(s.curve.address) && q.includes('resolution:"1"'));
    expect(curveQueries).toHaveLength(1);
    expect(r.summary.pools.map((p) => p.role).sort()).toEqual(['curve', 'graduation']);
    // The curve's 1-minute bars are stored; its daily and hourly bars are not asked for.
    expect(sim.barsQueries().filter((q) => q.includes(s.curve.address))).toHaveLength(1);

    const before = await snapshotTables(t.db);
    await fetchCandlesForCoin(deps, { id, address: s.coin.mint });
    expect(await snapshotTables(t.db)).toEqual(before);
    expect(sim.queries.length).toBe(r.summary.requests + r.summary.lookupRequests);
  });

  it('counts units per coin, so two coins on one client each report their own', async () => {
    const a = smallCoin('7');
    const b = smallCoin('8');
    const sims = [simProvider(a.coin), simProvider(b.coin)];
    const router: FetchLike = (url, init) => {
      const q = (JSON.parse(init.body) as { query: string }).query;
      const hit = [a, b].findIndex(
        (s) => q.includes(s.coin.mint) || q.includes(s.grad.address) || q.includes(s.curve.address),
      );
      return sims[hit]!.fetch(url, init);
    };
    const client = makeClient(router);
    const deps: CandleDeps = { db: t.db, codex: client, clock: () => new Date(NOW * 1000) };
    const idA = await addCoin(a);
    const idB = await addCoin(b);
    const [ra, rb] = await Promise.all([
      fetchCandlesForCoin(deps, { id: idA, address: a.coin.mint }),
      fetchCandlesForCoin(deps, { id: idB, address: b.coin.mint }),
    ]);
    expect(ra.summary.units).toBe(8);
    expect(rb.summary.units).toBe(8);
    expect(client.spend().units).toBeCloseTo(16, 6);
  });
});
