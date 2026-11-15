/**
 * A coin's own curve or graduation pool that another coin holds as an ordinary other pool is taken
 * over by the coin it belongs to (issue 43, correction to item 6). The provider is simulated.
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createRun, discoverCoins, type Database } from '@memecoinipedia/db';
import { createTestDatabase, type TestDatabase } from '@memecoinipedia/db/testing';
import { sql, type Kysely } from 'kysely';
import { UnitBudget } from '../../src/sources/budget.js';
import { CodexClient } from '../../src/sources/codex/index.js';
import type { FetchLike } from '../../src/sources/http.js';
import { executeStage, type ExecuteOptions } from '../../src/worker/execute.js';
import { StageRegistry, type StageCoin } from '../../src/worker/stage.js';
import { createCandlesStage } from '../../src/worker/stages/candles.js';
import { metricsStage } from '../../src/worker/stages/metrics.js';
import { snapshotTables } from '../candles/helpers.js';
import { minute, simProvider, type SimCoin, type SimMinute, type SimPool } from '../candles/sim.js';
import { adminUrl, coinRow, describeDb, testLog } from './helpers.js';

const DAY = 86_400;
const T0 = 1_767_225_600;
const LAUNCH = T0 + 3 * 3_600;
const GRAD = LAUNCH + 2 * 3_600;
const NOW = GRAD + 5 * DAY;
const mcap = (usd: number): number => usd / 1e9;
const dense = (start: number, n: number, price: (i: number) => number): SimMinute[] =>
  Array.from({ length: n }, (_, i) => minute(start + i * 60, price(i), 3_000));
const addr = (ch: string, tag: string): string => ch.repeat(44 - tag.length) + tag;

const X = addr('X', 'x');
const O = addr('Q', 'o');
const POOL = addr('P', 'xo'); // the pool between X and O
const GRAD_O = addr('G', 'o');

const trading = (): SimMinute[] => dense(GRAD, 200, (i) => mcap(60_000 + i * 2_211));
const pool = (address: string, quote?: SimPool['quote']): SimPool => ({
  address,
  exchange: 'PumpSwap',
  protocol: 'PumpAmm',
  createdAt: GRAD,
  liquidity: 30_000,
  minutes: trading(),
  ...(quote ? { quote } : {}),
});

describeDb("taking over a coin's own pool from the coin that holds it as another pool", () => {
  let t: TestDatabase;
  let db: Kysely<Database>;
  let runId: number;
  beforeEach(async () => {
    t = await createTestDatabase(adminUrl!);
    db = t.db;
    runId = await createRun(db, { kind: 'test' });
  });
  afterEach(async () => {
    await t.drop();
  });

  /** One provider for both coins, routed by the address a query carries. */
  function harness(coins: SimCoin[]) {
    const sims = new Map(coins.map((c) => [c.mint, simProvider(c)]));
    const queries: string[] = [];
    const fetch: FetchLike = async (url, init) => {
      const query = (JSON.parse(init.body) as { query: string }).query;
      const owner =
        coins.find((c) => query.includes(c.mint)) ??
        coins.find((c) => c.pools.some((p) => query.includes(p.address)));
      if (!owner) throw new Error('unrouted query');
      queries.push(query);
      return sims.get(owner.mint)!.fetch(url, init);
    };
    const codex = new CodexClient({
      apiKey: 'test-key-not-real',
      fetch,
      budget: new UnitBudget(),
      http: { maxRetries: 0, sleep: async () => {} },
    });
    const candles = createCandlesStage({ codex });
    const ctx = { db, now: () => new Date(NOW * 1000), log: testLog, runId };
    const opts = (): ExecuteOptions => ({
      db,
      registry: new StageRegistry().register(metricsStage),
      now: ctx.now,
      log: testLog,
      runId,
      maxAttempts: 3,
    });
    return {
      queries,
      candles: async (mint: string) => {
        const c = await db
          .selectFrom('coins')
          .selectAll()
          .where('address', '=', mint)
          .executeTakeFirstOrThrow();
        return candles.run(ctx, c as unknown as StageCoin);
      },
      metrics: async (mint: string) => {
        const c = await db
          .selectFrom('coins')
          .select('id')
          .where('address', '=', mint)
          .executeTakeFirstOrThrow();
        return executeStage(opts(), 'metrics', c.id);
      },
    };
  }

  async function seed(rough: Record<string, number>): Promise<void> {
    await discoverCoins(
      db,
      Object.entries(rough).map(([mint, roughAth]) =>
        coinRow(mint, {
          launchedAt: new Date(LAUNCH * 1000),
          graduatedAt: new Date(GRAD * 1000),
          roughAthMarketCapUsd: roughAth,
        }),
      ),
      { now: new Date(NOW * 1000) },
    );
  }
  const idOf = async (mint: string) =>
    (
      await db
        .selectFrom('coins')
        .select('id')
        .where('address', '=', mint)
        .executeTakeFirstOrThrow()
    ).id;
  const poolOwner = async () =>
    db
      .selectFrom('pools')
      .select(['coin_id', 'is_primary', 'is_graduation_pool', 'id'])
      .where('address', '=', POOL)
      .executeTakeFirstOrThrow();
  const metricsStatus = async (mint: string) =>
    (
      await db
        .selectFrom('coin_stages')
        .select('status')
        .where('coin_id', '=', await idOf(mint))
        .where('stage', '=', 'metrics')
        .executeTakeFirstOrThrow()
    ).status;
  const everything = async () => ({
    ...(await snapshotTables(db)),
    coin_stages: (await sql`select * from coin_stages order by coin_id, stage`.execute(db)).rows,
  });

  // O listed X/O as one of its own other pools (SOL quote: the way the code stored it before).
  const oCoin = (): SimCoin => ({
    mint: O,
    createdAt: LAUNCH,
    migratedAt: GRAD,
    migratedPoolAddress: GRAD_O,
    pools: [pool(GRAD_O), pool(POOL)],
  });
  // X launched against O: launch info names X/O as its graduation pool.
  const xCoin = (): SimCoin => ({
    mint: X,
    createdAt: LAUNCH,
    migratedAt: GRAD,
    migratedPoolAddress: POOL,
    pools: [pool(POOL, { address: O, symbol: 'O' })],
  });

  it('moves the pool to the coin it belongs to, with its bars; the previous owner recomputes without it', async () => {
    await seed({ [O]: 5_000_000, [X]: 600_000 });
    const h = harness([oCoin(), xCoin()]);
    expect((await h.candles(O)).status).toBe('done');
    expect((await h.metrics(O)).kind).toBe('done');
    expect((await poolOwner()).coin_id).toBe(await idOf(O));
    const oBars = (
      await sql<{
        n: string;
      }>`select count(*)::text as n from candle_chunks where pool_id = ${(await poolOwner()).id}`.execute(
        db,
      )
    ).rows[0]!.n;
    expect(Number(oBars)).toBeGreaterThan(0);
    const before = h.queries.length;

    const r = await h.candles(X);
    expect(r).toMatchObject({ status: 'done', detail: { poolsTakenOver: 1 } });
    expect(JSON.stringify(r)).not.toContain(POOL);
    const p = await poolOwner();
    expect(p).toMatchObject({ coin_id: await idOf(X), is_primary: true, is_graduation_pool: true });
    // Bars and coverage are keyed by the pool id: they stayed with the pool.
    const chunksAfter = (
      await sql<{
        n: string;
      }>`select count(*)::text as n from candle_chunks where pool_id = ${p.id}`.execute(db)
    ).rows[0]!.n;
    expect(Number(chunksAfter)).toBeGreaterThanOrEqual(Number(oBars));
    // No bars request repeats one made for O.
    const oQueries = new Set(h.queries.slice(0, before));
    expect(h.queries.slice(before).filter((q) => oQueries.has(q))).toEqual([]);

    // O's metrics are pending (their input changed); X gets metrics from the pool.
    expect(await metricsStatus(O)).toBe('pending');
    expect((await h.metrics(X)).kind).toBe('done');
    const x = await db
      .selectFrom('coins')
      .select('ath_market_cap_usd')
      .where('address', '=', X)
      .executeTakeFirstOrThrow();
    expect(Number(x.ath_market_cap_usd)).toBeGreaterThan(400_000);

    // O recomputes without the pool on the next pass.
    expect((await h.metrics(O)).kind).toBe('done');
    expect(await metricsStatus(O)).toBe('done');
    const o = await db
      .selectFrom('coins')
      .select(['ath_market_cap_usd', 'ath_pool_id'])
      .where('address', '=', O)
      .executeTakeFirstOrThrow();
    expect(o.ath_pool_id).not.toBe(p.id);

    // A second run changes nothing and asks for nothing.
    const rows = await everything();
    const requests = h.queries.length;
    expect((await h.candles(X)).status).toBe('done');
    expect((await h.candles(O)).status).toBe('done');
    expect(h.queries.length).toBe(requests);
    expect(await everything()).toEqual(rows);
  }, 90_000);

  it('X first, then O: O does not take the pool (its quote is not SOL, USDC or USDT), nothing clashes', async () => {
    await seed({ [O]: 5_000_000, [X]: 600_000 });
    const o = oCoin();
    // From O's side, X/O is quoted in X.
    o.pools = [pool(GRAD_O), pool(POOL, { address: X, symbol: 'X' })];
    const h = harness([o, xCoin()]);
    expect((await h.candles(X)).status).toBe('done');
    expect((await poolOwner()).coin_id).toBe(await idOf(X));
    const r = await h.candles(O);
    expect(r).toMatchObject({ status: 'done', detail: { poolsTakenOver: 0, otherQuotePools: 1 } });
    expect((await poolOwner()).coin_id).toBe(await idOf(X));

    const rows = await everything();
    const requests = h.queries.length;
    await h.candles(X);
    await h.candles(O);
    expect(h.queries.length).toBe(requests);
    expect(await everything()).toEqual(rows);
  }, 90_000);

  it('fails loudly, and changes nothing, when both coins hold the pool as their own graduation pool', async () => {
    await seed({ [O]: 600_000, [X]: 600_000 });
    const o = oCoin();
    o.migratedPoolAddress = POOL; // O's graduation pool is the shared pool too
    o.pools = [pool(POOL)];
    const h = harness([o, xCoin()]);
    expect((await h.candles(O)).status).toBe('done');
    expect((await poolOwner()).is_graduation_pool).toBe(true);

    const rows = await everything();
    const requests = h.queries.length;
    const r = await h.candles(X);
    expect(r).toMatchObject({ status: 'failed', retry: false });
    const reason = (r as { reason: string }).reason;
    expect(reason).toMatch(/^pool_claimed_by_two_coins: /);
    expect(reason).toContain(String(await idOf(X)));
    expect(reason).toContain(String(await idOf(O)));
    expect((await poolOwner()).coin_id).toBe(await idOf(O));
    expect(await everything()).toEqual(rows);
    // The failure came after launch info only: no bars request.
    expect(h.queries.slice(requests).every((q) => !q.includes('getBars('))).toBe(true);
    // And again: the same failure, still nothing changed.
    expect(await h.candles(X)).toMatchObject({ status: 'failed', retry: false });
    expect(await everything()).toEqual(rows);
  }, 90_000);
});
