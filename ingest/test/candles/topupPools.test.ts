/**
 * `refreshPools: 'top-up'` (issue #87) at the level of the fetcher, against the simulated provider:
 * a top-up reads the pool list again but never moves or sets the graduation role; a refresh
 * (`refreshPools: true`) settles what the top-up recorded; the coins left with the issue are found
 * by the rule `late-graduation-pool`; a top-up of a coin holding no pool is a first fetch.
 * Every run is handed the same fixed clock; nothing reaches a provider.
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  getCoinPools,
  replaceCoinIssues,
  selectCoinsByRule,
  upsertCoin,
  upsertPool,
} from '@memecoinipedia/db';
import { createTestDatabase, type TestDatabase } from '@memecoinipedia/db/testing';
import { sql } from 'kysely';
import {
  fetchCandlesForCoin,
  type CandleCoin,
  type CandleFetchSummary,
} from '../../src/candles/index.js';
import { UnitBudget } from '../../src/sources/budget.js';
import { CodexClient } from '../../src/sources/codex/index.js';
import { CANDLES_ISSUE_KINDS } from '../../src/worker/stages/candles.js';
import { adminUrl, describeDb } from './helpers.js';
import { minute, simProvider, type SimCoin, type SimMinute, type SimPool } from './sim.js';

const HOUR = 3_600;
const T0 = 1_767_225_600;
const LAUNCH = T0 + 3 * HOUR;
const GRAD = LAUNCH + 2 * HOUR;
const NOW = GRAD + 40 * 86_400;
const CLOCK = () => new Date(NOW * 1000);

let t: TestDatabase;
beforeEach(async () => {
  if (adminUrl) t = await createTestDatabase(adminUrl);
});
afterEach(async () => {
  if (adminUrl) await t.drop();
});

const dense = (start: number, n: number): SimMinute[] =>
  Array.from({ length: n }, (_, i) => minute(start + i * 60, 50_000 / 1e9 + i * 1e-9, 3_000));

const addr = (c: string, tag: string) => c.repeat(43) + tag;

/**
 * A coin whose list holds the curve, a pool created at the migration (`real`) and one created
 * three hours after it (`late`, beyond the distance of one hour).
 */
function world(tag: string) {
  const curve: SimPool = {
    address: addr('B', tag),
    exchange: 'Pump.fun',
    protocol: 'Pump',
    createdAt: LAUNCH,
    liquidity: 0,
    minutes: [],
  };
  const late: SimPool = {
    address: addr('L', tag),
    exchange: 'Raydium',
    protocol: 'Raydium',
    createdAt: GRAD + 3 * HOUR,
    liquidity: 30_000,
    minutes: dense(GRAD + 3 * HOUR, 200),
  };
  const real: SimPool = {
    address: addr('R', tag),
    exchange: 'PumpSwap',
    protocol: 'PumpAmm',
    createdAt: GRAD,
    liquidity: 30_000,
    minutes: dense(GRAD, 200),
  };
  const coin: SimCoin = {
    mint: addr('D', tag),
    createdAt: LAUNCH,
    migratedAt: GRAD,
    migratedPoolAddress: late.address,
    pools: [curve, late, real],
  };
  return { curve, late, real, coin };
}
type World = ReturnType<typeof world>;

function client(coin: SimCoin) {
  const sim = simProvider(coin);
  const codex = new CodexClient({
    apiKey: 'test-key-not-real',
    fetch: sim.fetch,
    budget: new UnitBudget(),
    http: { maxRetries: 0, sleep: async () => {} },
  });
  return { sim, deps: { db: t.db, codex, clock: CLOCK } };
}

async function addCoin(w: World, db = t.db): Promise<number> {
  const id = await upsertCoin(db, {
    chain: 'solana',
    address: w.coin.mint,
    ticker: 'SIM',
    launchpad: 'pump.fun',
  });
  await db
    .updateTable('coins')
    .set({ launched_at: new Date(LAUNCH * 1000), graduated_at: new Date(GRAD * 1000) })
    .where('id', '=', id)
    .execute();
  return id;
}

const SOL = 'SOL';
const pool = (
  id: number,
  p: SimPool,
  role: 'curve' | 'graduation' | 'other',
): Parameters<typeof upsertPool>[1] => ({
  chain: 'solana',
  address: p.address,
  coinId: id,
  dex: p.exchange,
  isPrimary: role !== 'other',
  isGraduationPool: role === 'graduation',
  quoteToken: SOL,
  createdAtChain: p.createdAt,
  sourcePairId: null,
});

/** The candles stage finished for the coin (the rule wants it for a coin with no graduation pool). */
async function candlesDone(id: number): Promise<void> {
  await sql`insert into coin_stages (coin_id, stage, status, attempts, started_at, finished_at, updated_at)
    values (${id}, 'candles', 'done', 1, ${CLOCK()}, ${CLOCK()}, ${CLOCK()})`.execute(t.db);
}

/** What the candles stage does with a run's issues. */
async function record(id: number, s: CandleFetchSummary): Promise<void> {
  const owned = new Set<string>([...s.issueKindsChecked, ...s.issueRecords.map((i) => i.kind)]);
  await replaceCoinIssues(
    t.db,
    id,
    CANDLES_ISSUE_KINDS.filter((k) => owned.has(k)),
    s.issueRecords,
  );
}

const openKinds = async (id: number): Promise<string[]> =>
  (
    await t.db
      .selectFrom('data_issues')
      .select('kind')
      .where('coin_id', '=', id)
      .where('resolved_at', 'is', null)
      .orderBy('kind')
      .execute()
  ).map((r) => r.kind);

const roles = async (id: number) =>
  (await getCoinPools(t.db, id)).map((p) => ({
    address: p.address,
    primary: p.isPrimary,
    graduation: p.isGraduationPool,
  }));

const run = (w: World, id: number, how: CandleCoin['refreshPools']) =>
  fetchCandlesForCoin(client(w.coin).deps, {
    id,
    address: w.coin.mint,
    ...(how === undefined ? {} : { refreshPools: how }),
  });

const MAX_DELAY = { maxDelaySec: 3_600 };

describeDb('a top-up reading the pool list, at the fetcher', () => {
  it.each([
    ['not stored', false],
    ['stored as an other pool', true],
  ])(
    '(a) stored graduation pool is late, the list holds one created at the migration (%s): records the issue, changes no pool, then a refresh moves the role and closes it',
    async (_name, storedAsOther) => {
      const w = world(storedAsOther ? '1' : '2');
      const id = await addCoin(w);
      await upsertPool(t.db, pool(id, w.curve, 'curve'));
      await upsertPool(t.db, pool(id, w.late, 'graduation'));
      if (storedAsOther) await upsertPool(t.db, pool(id, w.real, 'other'));
      await candlesDone(id);
      // The late choice was recorded when it was made, under the current distance.
      await replaceCoinIssues(
        t.db,
        id,
        ['graduation_pool_late'],
        [{ kind: 'graduation_pool_late', detail: { ...MAX_DELAY, distanceSec: 3 * HOUR } }],
      );
      // Examined under the current rule: the selection leaves it alone.
      expect(await selectCoinsByRule(t.db, 'late-graduation-pool')).toEqual([]);
      const before = await roles(id);

      const top = await run(w, id, 'top-up');
      expect(top.ok).toBe(true);
      expect(top.summary.graduationMoved).toBe(false);
      expect(top.summary.lookupRequests).toBe(1);
      expect(top.summary.issueRecords).toEqual([
        {
          kind: 'graduation_pool_differs',
          detail: {
            storedPool: w.late.address,
            listedPool: w.real.address,
            source: 'created_at_migration',
          },
        },
      ]);
      await record(id, top.summary);
      // The flags of every stored pool are what they were; the listed pool is stored only if it was.
      const after = await roles(id);
      expect(after).toEqual(before);
      expect(after.some((p) => p.address === w.real.address)).toBe(storedAsOther);
      if (storedAsOther) {
        expect(after.find((p) => p.address === w.real.address)).toMatchObject({
          primary: false,
          graduation: false,
        });
      }
      // The list found the pool created at the migration, so the old "late" issue is closed and
      // only the new one is open.
      expect(await openKinds(id)).toEqual(['graduation_pool_differs']);

      // The rule selects the coin again: its stored graduation pool is created more than the
      // distance after the graduation (first branch), and nothing marks it as examined now.
      expect(await selectCoinsByRule(t.db, 'late-graduation-pool')).toEqual([id]);

      // A refresh moves the role (the late pool stays stored as an other pool) and closes the issue.
      const refresh = await run(w, id, true);
      expect(refresh.ok).toBe(true);
      expect(refresh.summary.graduationMoved).toBe(true);
      expect(refresh.summary.issueRecords).toEqual([]);
      await record(id, refresh.summary);
      const moved = await roles(id);
      expect(moved.find((p) => p.graduation)?.address).toBe(w.real.address);
      expect(moved.find((p) => p.address === w.late.address)).toMatchObject({
        primary: false,
        graduation: false,
      });
      expect(await openKinds(id)).toEqual([]);
      expect(await selectCoinsByRule(t.db, 'late-graduation-pool')).toEqual([]);
    },
  );

  it('(b) the coin holds no graduation pool and the list has one: a top-up sets no role, records storedPool null, and closes the open graduation_pool_not_found; a refresh sets the role', async () => {
    const w = world('3');
    const id = await addCoin(w);
    await upsertPool(t.db, pool(id, w.curve, 'curve'));
    await candlesDone(id);
    await replaceCoinIssues(
      t.db,
      id,
      ['graduation_pool_not_found'],
      [{ kind: 'graduation_pool_not_found', detail: { ...MAX_DELAY, poolsListed: 1 } }],
    );
    expect(await selectCoinsByRule(t.db, 'late-graduation-pool')).toEqual([]);
    const before = await roles(id);

    const top = await run(w, id, 'top-up');
    expect(top.ok).toBe(true);
    expect(top.summary.issueRecords).toEqual([
      {
        kind: 'graduation_pool_differs',
        detail: { storedPool: null, listedPool: w.real.address, source: 'closest_to_migration' },
      },
    ]);
    await record(id, top.summary);
    // The curve is as it was and no pool holds the role; the listed graduation pool is not stored.
    // The late pool, a liquid SOL pool the coin did not hold, is stored as an ordinary other pool
    // (what a top-up is for).
    expect(await roles(id)).toEqual([
      ...before,
      { address: w.late.address, primary: false, graduation: false },
    ]);
    expect(top.summary.poolsAdded).toBe(1);
    expect((await roles(id)).some((p) => p.graduation)).toBe(false);
    // The list did find a graduation pool, so the old "not found" issue is closed: the coin is
    // marked by the new issue alone.
    expect(await openKinds(id)).toEqual(['graduation_pool_differs']);
    // The rule selects it by its third branch (candles done, no graduation pool); the closed
    // "not found" issue no longer excludes it.
    expect(await selectCoinsByRule(t.db, 'late-graduation-pool')).toEqual([id]);

    const refresh = await run(w, id, true);
    expect(refresh.ok).toBe(true);
    await record(id, refresh.summary);
    expect((await roles(id)).find((p) => p.graduation)?.address).toBe(w.real.address);
    expect(await openKinds(id)).toEqual([]);
    expect(await selectCoinsByRule(t.db, 'late-graduation-pool')).toEqual([]);
  });

  it('(c) a top-up of a coin with no stored pool is a first fetch: the same requests, pools and summary, the launch-info shortcut included', async () => {
    const plain = world('4');
    const idPlain = await addCoin(plain);
    const a = client(plain.coin);
    const first = await fetchCandlesForCoin(a.deps, { id: idPlain, address: plain.coin.mint });

    // A second database for the top-up, so both coins are the first one in an empty database.
    const t2 = await createTestDatabase(adminUrl!);
    try {
      const up = world('4');
      const idUp = await addCoin(up, t2.db);
      const b = client(up.coin);
      const top = await fetchCandlesForCoin(
        { ...b.deps, db: t2.db },
        { id: idUp, address: up.coin.mint, refreshPools: 'top-up' },
      );
      expect(first.ok).toBe(true);
      expect(top.ok).toBe(true);
      // Launch info names the graduation pool, so no pool list is asked for, in both.
      expect(a.sim.lookups().some((q) => q.includes('listPairsWithMetadataForToken'))).toBe(false);
      expect(b.sim.queries).toEqual(a.sim.queries);
      const pick = (s: CandleFetchSummary) => ({
        path: s.path,
        requests: s.requests,
        lookupRequests: s.lookupRequests,
        units: s.units,
        launchInfoNamedPool: s.launchInfoNamedPool,
        poolsAdded: s.poolsAdded,
        graduationMoved: s.graduationMoved,
        pools: s.pools.map((p) => ({ address: p.address, role: p.role })),
        barsStored: s.barsStored,
        issues: s.issueRecords,
      });
      expect(pick(top.summary)).toEqual(pick(first.summary));
      expect(top.summary.launchInfoNamedPool).toBe(true);
      expect(await getCoinPools(t2.db, idUp)).toEqual(
        (await getCoinPools(t.db, idPlain)).map((p) => ({ ...p, coinId: idUp, id: p.id })),
      );
    } finally {
      await t2.drop();
    }
  });
});
