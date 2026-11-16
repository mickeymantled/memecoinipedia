/**
 * A coin that has a bonding curve and never graduated (issue #102), on simulated trading.
 *
 * The simulated curve has the shape the Codex.io probe found for such coins: one pool, exchange
 * and protocol `Pump`, quoted in SOL, `migrated` false and no migration time, liquidity near zero,
 * a few days of bars.
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { upsertCoin } from '@memecoinipedia/db';
import { createTestDatabase, type TestDatabase } from '@memecoinipedia/db/testing';
import {
  computeMetricsForCoin,
  fetchCandlesForCoin,
  type CandleDeps,
} from '../../src/candles/index.js';
import { UnitBudget } from '../../src/sources/budget.js';
import { CodexClient } from '../../src/sources/codex/index.js';
import type { FetchLike } from '../../src/sources/http.js';
import { adminUrl, describeDb } from './helpers.js';
import { minute, simProvider, type SimCoin, type SimMinute, type SimPool } from './sim.js';

const DAY = 86_400;
const T0 = 1_767_225_600;
const LAUNCH = T0 + 3 * 3_600;
const NOW = LAUNCH + 5 * DAY;

let t: TestDatabase;
beforeEach(async () => {
  if (adminUrl) t = await createTestDatabase(adminUrl);
});
afterEach(async () => {
  if (adminUrl) await t.drop();
});

const makeClient = (fetch: FetchLike): CodexClient =>
  new CodexClient({
    apiKey: 'test-key-not-real',
    fetch,
    budget: new UnitBudget(),
    http: { maxRetries: 0, sleep: async () => {} },
  });

const depsFor = (fetch: FetchLike): CandleDeps => ({
  db: t.db,
  codex: makeClient(fetch),
  clock: () => new Date(NOW * 1000),
});

const mcap = (usd: number): number => usd / 1e9;
const dense = (start: number, n: number, price: (i: number) => number, liq: number): SimMinute[] =>
  Array.from({ length: n }, (_, i) => minute(start + i * 60, price(i), 3_000, liq));

/** The curve of a never-graduated coin: climbs from $20,000 to $180,000, then trades sparsely. */
function curveCoin(tag: string, peak = 180_000, launchpadName?: string, liq = 20_000): SimCoin {
  const curve: SimPool = {
    address: 'B'.repeat(43) + tag,
    exchange: 'Pump',
    protocol: 'Pump',
    createdAt: LAUNCH,
    liquidity: liq,
    minutes: [
      ...dense(LAUNCH, 400, (i) => mcap(20_000 + (i * (peak - 20_000)) / 399), liq),
      ...Array.from({ length: 8 }, (_, k) =>
        minute(LAUNCH + DAY + k * 900, mcap(peak * 0.6), 2_000, liq),
      ),
      ...Array.from({ length: 8 }, (_, k) =>
        minute(LAUNCH + 2 * DAY + k * 900, mcap(peak * 0.4), 2_000, liq),
      ),
    ],
  };
  return {
    mint: 'D'.repeat(43) + tag,
    createdAt: LAUNCH,
    migratedAt: null,
    migratedPoolAddress: null,
    ...(launchpadName ? { launchpadName } : {}),
    pools: [curve],
  };
}

async function addCoin(coin: SimCoin, extra: Record<string, unknown> = {}): Promise<number> {
  const id = await upsertCoin(t.db, {
    chain: 'solana',
    address: coin.mint,
    ticker: 'SIM',
    launchpad: 'pump.fun',
  });
  await t.db
    .updateTable('coins')
    .set({ launched_at: new Date(LAUNCH * 1000), ...extra })
    .where('id', '=', id)
    .execute();
  return id;
}

const flagOf = async (id: number) =>
  (
    await t.db
      .selectFrom('coins')
      .select('is_mayhem_mode')
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
  ).is_mayhem_mode;

describeDb('a coin with a curve and no graduation', () => {
  it('is fetched, measured and listed on its curve, with no graduation data issue', async () => {
    const coin = curveCoin('1');
    const id = await addCoin(coin, { rough_ath_market_cap_usd: 180_000 });
    const sim = simProvider(coin);
    const deps = depsFor(sim.fetch);

    const r = await fetchCandlesForCoin(deps, { id, address: coin.mint });
    expect(r.ok).toBe(true);
    const sum = r.summary;
    // Launch record, pool list, daily screen: the 12 units every such coin costs.
    expect(sum.lookupRequests).toBe(2);
    expect(sim.lookups()[0]).toContain('token(input');
    expect(sim.lookups()[1]).toContain('listPairsWithMetadataForToken');
    expect(sim.barsQueries()[0]).toContain('resolution:"1D"');
    expect(sum.pools.map((p) => p.role)).toEqual(['curve']);
    expect(sum.issues).toEqual([]);
    expect(sum.path).not.toBe('screened_out');

    const pools = await t.db.selectFrom('pools').selectAll().where('coin_id', '=', id).execute();
    expect(pools).toHaveLength(1);
    expect(pools[0]).toMatchObject({ is_primary: true, is_graduation_pool: false });
    expect(await t.db.selectFrom('data_issues').selectAll().execute()).toEqual([]);

    const m = await computeMetricsForCoin(deps, { id });
    expect(m.ok).toBe(true);
    const row = await t.db
      .selectFrom('coins')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row.graduated_at).toBeNull();
    expect(Number(row.ath_market_cap_usd)).toBeGreaterThan(100_000);
    expect(Number(row.ath_market_cap_usd)).toBeLessThanOrEqual(180_001);
    expect(row.ath_pool_id).toBe(pools[0]!.id);
    expect(row.seconds_to_ath).not.toBeNull();
  });

  // OPEN QUESTION for the lead (see the pull request): the metric rules (docs/metrics.md section 4)
  // make a 1-minute window strict only when the window's liquidity is null or at least $5,000, for
  // primary pools too. A curve whose bars report liquidity of 0 to about 500 dollars, as the probe
  // found, therefore yields no strict window and no ATH (flag `no_qualifying_window`): the coin
  // would not be listed. The test above uses a curve whose bars report $20,000.
  it.todo(
    'is listed when the curve reports near-zero liquidity (needs a decision on the funded rule)',
  );
});

describeDb('a stray pool beside the curve of a never-graduated coin', () => {
  const stray = (tag: string): SimPool => ({
    address: 'C'.repeat(43) + tag,
    exchange: 'PumpSwap',
    protocol: 'PumpAmm',
    createdAt: LAUNCH + 3_600,
    liquidity: 30_000,
    minutes: dense(LAUNCH + 3_600, 120, () => mcap(8_000), 30_000),
  });

  it('is an ordinary other pool; the curve stays primary and is fetched for its whole life', async () => {
    const coin = curveCoin('7');
    coin.pools.push(stray('7'));
    const id = await addCoin(coin, { rough_ath_market_cap_usd: 180_000 });
    const sim = simProvider(coin);
    const deps = depsFor(sim.fetch);
    const r = await fetchCandlesForCoin(deps, { id, address: coin.mint });
    expect(r.ok).toBe(true);
    expect(r.summary.pools.map((p) => p.role).sort()).toEqual(['curve', 'other']);
    expect(r.summary.issues).toEqual([]);
    const pools = await t.db.selectFrom('pools').selectAll().where('coin_id', '=', id).execute();
    expect(pools.filter((p) => p.is_graduation_pool)).toHaveLength(0);
    expect(r.summary.path).not.toBe('screened_out');
    await computeMetricsForCoin(deps, { id });
    const row = await t.db
      .selectFrom('coins')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(Number(row.ath_market_cap_usd)).toBeGreaterThan(100_000);
    const curveId = pools.find((p) => p.is_primary)!.id;
    expect(row.ath_pool_id).toBe(curveId);
  });

  it('a graduate with the same pools keeps its graduation pool, as before', async () => {
    const coin = curveCoin('8');
    coin.pools.push(stray('8'));
    coin.migratedAt = LAUNCH + 3_600;
    const id = await addCoin(coin);
    const r = await fetchCandlesForCoin(depsFor(simProvider(coin).fetch), {
      id,
      address: coin.mint,
    });
    expect(r.summary.pools.map((p) => p.role).sort()).toEqual(['curve', 'graduation']);
    const row = await t.db
      .selectFrom('coins')
      .select('graduated_at')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row.graduated_at).toEqual(new Date((LAUNCH + 3_600) * 1000));
  });
});

describeDb('the mayhem flag from the launch record', () => {
  it('sets true on the launchpad name "Pump Mayhem", whatever its case', async () => {
    const coin = curveCoin('2', 180_000, 'PUMP MAYHEM');
    const id = await addCoin(coin);
    expect(await flagOf(id)).toBeNull();
    await fetchCandlesForCoin(depsFor(simProvider(coin).fetch), { id, address: coin.mint });
    expect(await flagOf(id)).toBe(true);
  });

  it('changes nothing on any other name', async () => {
    const coin = curveCoin('3'); // Pump.fun
    const id = await addCoin(coin);
    await fetchCandlesForCoin(depsFor(simProvider(coin).fetch), { id, address: coin.mint });
    expect(await flagOf(id)).toBeNull();
    const other = curveCoin('4', 180_000, 'Pump.fun');
    const id2 = await addCoin(other, { is_mayhem_mode: false });
    await fetchCandlesForCoin(depsFor(simProvider(other).fetch), { id: id2, address: other.mint });
    expect(await flagOf(id2)).toBe(false);
  });

  it('turns a stored false into true, and never a true back', async () => {
    const coin = curveCoin('5', 180_000, 'Pump Mayhem');
    const id = await addCoin(coin, { is_mayhem_mode: false });
    await fetchCandlesForCoin(depsFor(simProvider(coin).fetch), { id, address: coin.mint });
    expect(await flagOf(id)).toBe(true);
    const plain = curveCoin('6');
    const id2 = await addCoin(plain, { is_mayhem_mode: true });
    await fetchCandlesForCoin(depsFor(simProvider(plain).fetch), { id: id2, address: plain.mint });
    expect(await flagOf(id2)).toBe(true);
  });
});
