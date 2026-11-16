import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { sql } from 'kysely';
import { selectCoinsByRule } from '../src/backfill.js';
import { putBars, type CandleBar } from '../src/candles.js';
import { upsertCoin } from '../src/coins.js';
import { replaceCoinIssues } from '../src/dataIssues.js';
import {
  getCoinPools,
  moveGraduationPool,
  PoolClaimedByTwoCoinsError,
  upsertPool,
  type PoolInput,
} from '../src/pools.js';
import { createTestDatabase, type TestDatabase } from '../src/testing.js';
import { adminUrl, describeDb } from './helpers.js';

const NOW = new Date('2026-11-15T12:00:00Z');
const GRAD = Date.parse('2025-03-01T00:00:00Z') / 1000;

const bar = (t: number): CandleBar => ({
  t,
  o: 1,
  h: 2,
  l: 0.5,
  c: 1.5,
  volumeUsd: 10,
  trades: 3,
  traders: 2,
  liquidityUsd: 9_000,
});

describeDb('moving the graduation role (issue 81)', () => {
  let t: TestDatabase;
  let n = 0;
  let a = 0;
  let b = 0;
  beforeAll(async () => {
    t = await createTestDatabase(adminUrl!);
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    n++;
    a = await upsertCoin(t.db, { chain: 'solana', address: `A${n}` });
    b = await upsertCoin(t.db, { chain: 'solana', address: `B${n}` });
    for (const id of [a, b]) {
      for (const stage of ['candles', 'metrics']) {
        await sql`insert into coin_stages (coin_id, stage, status, attempts)
          values (${id}, ${stage}, 'done', 1)
          on conflict (coin_id, stage) do update set status = 'done', attempts = 1`.execute(t.db);
      }
    }
  });

  const pool = (coinId: number, address: string, over: Partial<PoolInput> = {}): PoolInput => ({
    chain: 'solana',
    address,
    coinId,
    dex: 'Raydium',
    isPrimary: false,
    isGraduationPool: false,
    quoteToken: 'SOL',
    createdAtChain: GRAD,
    sourcePairId: `${address}:1`,
    ...over,
  });
  const grad = (coinId: number, address: string) =>
    pool(coinId, address, { isPrimary: true, isGraduationPool: true });
  const metricsStatus = async (coinId: number) =>
    (
      await t.db
        .selectFrom('coin_stages')
        .select(['status', 'attempts'])
        .where('coin_id', '=', coinId)
        .where('stage', '=', 'metrics')
        .executeTakeFirstOrThrow()
    ).status;
  const roles = async (coinId: number) =>
    (await getCoinPools(t.db, coinId)).map((p) => [p.address, p.isPrimary, p.isGraduationPool]);

  it('moves the role to a pool the coin holds: one graduation pool before and after, nothing deleted, metrics pending', async () => {
    await upsertPool(t.db, grad(a, `OLD${n}`));
    await upsertPool(t.db, pool(a, `NEW${n}`));
    const r = await moveGraduationPool(t.db, pool(a, `NEW${n}`), NOW);
    expect(r).toEqual({
      moved: true,
      previousAddress: `OLD${n}`,
      inserted: false,
      previousOwnerCoinId: null,
    });
    expect(await roles(a)).toEqual([
      [`OLD${n}`, false, false],
      [`NEW${n}`, true, true],
    ]);
    expect(await metricsStatus(a)).toBe('pending');
    // The candles stage is left as it was.
    const candles = await t.db
      .selectFrom('coin_stages')
      .select('status')
      .where('coin_id', '=', a)
      .where('stage', '=', 'candles')
      .executeTakeFirstOrThrow();
    expect(candles.status).toBe('done');
  });

  it("is a no-op when the pool already is the coin's one graduation pool", async () => {
    await upsertPool(t.db, grad(a, `ONLY${n}`));
    const before = await sql`select * from pools where coin_id = ${a}`.execute(t.db);
    const r = await moveGraduationPool(t.db, grad(a, `ONLY${n}`), NOW);
    expect(r.moved).toBe(false);
    expect((await sql`select * from pools where coin_id = ${a}`.execute(t.db)).rows).toEqual(
      before.rows,
    );
    expect(await metricsStatus(a)).toBe('done');
  });

  it('stores a pool the coin does not hold, and leaves the old graduation pool stored', async () => {
    await upsertPool(t.db, grad(a, `OLD${n}`));
    const r = await moveGraduationPool(t.db, pool(a, `FRESH${n}`, { dex: 'Raydium' }), NOW);
    expect(r).toMatchObject({ moved: true, inserted: true, previousOwnerCoinId: null });
    expect(await roles(a)).toEqual([
      [`OLD${n}`, false, false],
      [`FRESH${n}`, true, true],
    ]);
  });

  it('takes the pool over from a coin that holds it as an ordinary other pool, bars and all', async () => {
    await upsertPool(t.db, grad(a, `OLD${n}`));
    await upsertPool(t.db, grad(b, `BGRAD${n}`));
    const sharedId = await upsertPool(t.db, pool(b, `SHARED${n}`));
    await putBars(t.db, sharedId, 86400, [bar(GRAD), bar(GRAD + 86400)]);
    const chunks = async () =>
      Number(
        (
          await sql<{ n: string }>`select count(*)::text as n from candle_chunks
            where pool_id = ${sharedId}`.execute(t.db)
        ).rows[0]!.n,
      );
    const held = await chunks();
    expect(held).toBeGreaterThan(0);

    const r = await moveGraduationPool(t.db, pool(a, `SHARED${n}`), NOW);
    expect(r).toMatchObject({ moved: true, previousOwnerCoinId: b });
    expect(await roles(a)).toEqual([
      [`OLD${n}`, false, false],
      [`SHARED${n}`, true, true],
    ]);
    expect(await chunks()).toBe(held); // the bars moved with the pool
    expect(await metricsStatus(b)).toBe('pending');
    expect(await metricsStatus(a)).toBe('pending');
  });

  it("fails naming both coins when the pool is the other coin's own, and writes nothing", async () => {
    await upsertPool(t.db, grad(a, `OLD${n}`));
    await upsertPool(t.db, grad(b, `CLAIMED${n}`));
    const before = await sql`select * from pools order by id`.execute(t.db);
    const err = await moveGraduationPool(t.db, pool(a, `CLAIMED${n}`), NOW).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PoolClaimedByTwoCoinsError);
    expect((err as Error).message).toContain(String(a));
    expect((err as Error).message).toContain(String(b));
    expect((await sql`select * from pools order by id`.execute(t.db)).rows).toEqual(before.rows);
    expect(await metricsStatus(a)).toBe('done');
    expect(await metricsStatus(b)).toBe('done');
  });

  it('repairs a coin that holds two graduation pools: one is left', async () => {
    await upsertPool(t.db, grad(a, `ONE${n}`));
    await upsertPool(t.db, grad(a, `TWO${n}`));
    await moveGraduationPool(t.db, pool(a, `TWO${n}`), NOW);
    expect((await roles(a)).filter((r) => r[2])).toEqual([[`TWO${n}`, true, true]]);
  });
});

describeDb('the late-graduation-pool rule (issue 81)', () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase(adminUrl!);
  });
  afterAll(async () => {
    await t.drop();
  });

  it('picks exactly the coins whose graduation pool is late, or missing on a fetched coin', async () => {
    const coin = async (
      name: string,
      opts: {
        graduated?: number | null;
        pool?: { createdAt: number | null; grad: boolean } | null;
        candles?: 'done' | 'pending' | null;
        chain?: string;
      },
    ): Promise<number> => {
      const id = await upsertCoin(t.db, { chain: opts.chain ?? 'solana', address: name });
      if (opts.graduated !== null && opts.graduated !== undefined) {
        await sql`update coins set graduated_at = to_timestamp(${opts.graduated}) where id = ${id}`.execute(
          t.db,
        );
      }
      if (opts.pool) {
        await upsertPool(t.db, {
          chain: opts.chain ?? 'solana',
          address: `pool-${name}`,
          coinId: id,
          dex: 'Raydium',
          isPrimary: opts.pool.grad,
          isGraduationPool: opts.pool.grad,
          createdAtChain: opts.pool.createdAt,
        });
      }
      if (opts.candles) {
        await sql`insert into coin_stages (coin_id, stage, status) values (${id}, 'candles', ${opts.candles})`.execute(
          t.db,
        );
      }
      return id;
    };
    const late = await coin('late', {
      graduated: GRAD,
      pool: { createdAt: GRAD + 3_601, grad: true },
      candles: 'done',
    });
    await coin('onTime', {
      graduated: GRAD,
      pool: { createdAt: GRAD + 600, grad: true },
      candles: 'done',
    });
    await coin('edge', {
      graduated: GRAD,
      pool: { createdAt: GRAD + 3_600, grad: true },
      candles: 'done',
    });
    const undated = await coin('undated', {
      graduated: GRAD,
      pool: { createdAt: null, grad: true },
      candles: 'done',
    });
    // Never listed, but its first bar is on time: not late.
    await sql`update pools set first_bar_at = to_timestamp(${GRAD + 600}) where coin_id = ${undated}`.execute(
      t.db,
    );
    // Created more than an hour before the graduation time: the distance runs both ways.
    const early = await coin('early', {
      graduated: GRAD,
      pool: { createdAt: GRAD - 90_000, grad: true },
      candles: 'done',
    });
    await coin('noGradTime', {
      graduated: null,
      pool: { createdAt: GRAD, grad: true },
      candles: 'done',
    });
    const missing = await coin('missing', {
      graduated: GRAD,
      pool: { createdAt: GRAD, grad: false },
      candles: 'done',
    });
    const bare = await coin('bare', { graduated: GRAD, candles: 'done' });
    // A never-graduated curve (issue #102) has no graduation pool to be missing: never picked, with
    // or without a stored curve.
    await coin('neverGraduatedBare', { graduated: null, candles: 'done' });
    await coin('neverGraduatedCurve', { graduated: null, candles: 'done' });
    await coin('notFetched', { graduated: GRAD, candles: 'pending' });
    await coin('neverStaged', { graduated: GRAD });
    await coin('otherChain', {
      chain: 'ethereum',
      graduated: GRAD,
      pool: { createdAt: GRAD + 9_999, grad: true },
      candles: 'done',
    });
    // A late pool counts whatever state the coin's candles stage is in.
    const lateFailed = await coin('lateFailed', {
      graduated: GRAD,
      pool: { createdAt: GRAD + 86_400, grad: true },
      candles: 'pending',
    });

    const picked = await selectCoinsByRule(t.db, 'late-graduation-pool', {
      maxDelaySeconds: 3_600,
    });
    expect(picked).toEqual([late, early, missing, bare, lateFailed].sort((x, y) => x - y));
    // The distance is a parameter.
    expect(
      await selectCoinsByRule(t.db, 'late-graduation-pool', { maxDelaySeconds: 600 }),
    ).toContain(late);
    expect(await selectCoinsByRule(t.db, 'late-graduation-pool')).toEqual(picked);
  });

  it('sees a named pool that was never listed (late first bar, or no bar), and leaves out coins examined under the current rule (issue 86)', async () => {
    const coin = async (name: string, over: { first?: number | null; created?: number | null }) => {
      const id = await upsertCoin(t.db, { chain: 'solana', address: `h-${name}` });
      await sql`update coins set graduated_at = to_timestamp(${GRAD}) where id = ${id}`.execute(
        t.db,
      );
      await upsertPool(t.db, {
        chain: 'solana',
        address: `pool-h-${name}`,
        coinId: id,
        dex: 'Raydium',
        isPrimary: true,
        isGraduationPool: true,
        createdAtChain: over.created === undefined ? null : over.created,
      });
      if (over.first !== undefined && over.first !== null) {
        await sql`update pools set first_bar_at = to_timestamp(${over.first}) where coin_id = ${id}`.execute(
          t.db,
        );
      }
      await sql`insert into coin_stages (coin_id, stage, status) values (${id}, 'candles', 'done')`.execute(
        t.db,
      );
      return id;
    };
    const issue = (coinId: number, kind: string, detail: unknown) =>
      replaceCoinIssues(t.db, coinId, [kind], [{ kind, detail }]);
    const ids = {
      lateBar: await coin('lateBar', { first: GRAD + 2 * 86_400 }),
      noBar: await coin('noBar', {}),
      goodBar: await coin('goodBar', { first: GRAD + 3_600 }),
      listed: await coin('listed', { created: GRAD + 5, first: GRAD + 2 * 86_400 }),
      lateExamined: await coin('lateExamined', { created: GRAD + 99_999 }),
      lateOldRule: await coin('lateOldRule', { created: GRAD + 99_999 }),
      lateOtherRule: await coin('lateOtherRule', { created: GRAD + 99_999 }),
      lateResolved: await coin('lateResolved', { created: GRAD + 99_999 }),
      notFound: await coin('notFound', { created: GRAD + 99_999 }),
    };
    await issue(ids.lateExamined, 'graduation_pool_late', {
      distanceSec: 99_999,
      maxDelaySec: 3_600,
    });
    await issue(ids.lateOldRule, 'graduation_pool_late', { distanceSec: 99_999, maxDelaySec: 600 });
    await issue(ids.lateOtherRule, 'graduation_pool_late', { distanceSec: 99_999 });
    await issue(ids.lateResolved, 'graduation_pool_late', { maxDelaySec: 3_600 });
    await sql`update data_issues set resolved_at = now() where coin_id = ${ids.lateResolved}`.execute(
      t.db,
    );
    // A not-found issue read under the current rule marks a coin with no graduation pool too.
    const bare = await upsertCoin(t.db, { chain: 'solana', address: 'h-bare' });
    // Issue #102: a coin with no graduation pool is only missing one when it graduated, so this
    // graduate says when (the test did not set a graduation time before).
    await sql`update coins set graduated_at = to_timestamp(${GRAD}) where id = ${bare}`.execute(
      t.db,
    );
    await sql`insert into coin_stages (coin_id, stage, status) values (${bare}, 'candles', 'done')`.execute(
      t.db,
    );
    const bareExamined = await upsertCoin(t.db, { chain: 'solana', address: 'h-bareExamined' });
    await sql`insert into coin_stages (coin_id, stage, status) values (${bareExamined}, 'candles', 'done')`.execute(
      t.db,
    );
    await issue(bareExamined, 'graduation_pool_not_found', { maxDelaySec: 3_600, poolsListed: 4 });

    const picked = await selectCoinsByRule(t.db, 'late-graduation-pool', {
      maxDelaySeconds: 3_600,
    });
    const mine = new Set(Object.values(ids).concat(bare, bareExamined));
    const expected = [
      ids.lateBar,
      ids.noBar,
      ids.lateOldRule, // examined under another distance
      ids.lateOtherRule, // an issue with no mark: recorded before the mark existed
      ids.lateResolved, // the issue is resolved
      ids.notFound,
      bare,
    ].sort((x, y) => x - y);
    expect(picked.filter((id) => mine.has(id))).toEqual(expected);
  });
});
