/**
 * The graduation pool is the pool created at the migration (issue 81): a pool-list refresh moves
 * the role, resolves a pair-pool clash between two coins, records `graduation_pool_late` once, and
 * the rule `late-graduation-pool` picks coins from the database alone. Simulated provider.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { discoverCoins, requeueFailed, upsertPool, type Database } from '@memecoinipedia/db';
import { createTestDatabase, type TestDatabase } from '@memecoinipedia/db/testing';
import { sql, type Kysely } from 'kysely';
import { runBackfill, type BackfillOptions } from '../../src/backfill/run.js';
import { UnitBudget } from '../../src/sources/budget.js';
import { CodexClient } from '../../src/sources/codex/index.js';
import type { FetchLike } from '../../src/sources/http.js';
import type { SourceClients } from '../../src/worker/run.js';
import { snapshotTables } from '../candles/helpers.js';
import { minute, simProvider, type SimCoin, type SimMinute, type SimPool } from '../candles/sim.js';
import { asset, coinRow, okResult, token } from '../worker/helpers.js';
import { adminUrl, describeDb, testLog } from './helpers.js';

const DAY = 86_400;
const T0 = 1_767_225_600;
const LAUNCH_A = T0 + 3 * 3_600;
const GRAD_A = LAUNCH_A + 2 * 3_600;
const GRAD_B = GRAD_A + 30 * DAY; // the pair pool is created at B's migration, a month after A's
const LAUNCH_B = GRAD_B - 2 * 3_600;
const NOW = GRAD_B + 3 * DAY;
const mcap = (usd: number): number => usd / 1e9;
const addr = (ch: string, tag: string): string => ch.repeat(44 - tag.length) + tag;

const A = addr('A', 'a');
const B = addr('B', 'b');
const C = addr('C', 'c');
const PAIR = addr('P', 'pair');
const REAL = addr('R', 'rea');
const FAR = addr('F', 'far');

const dense = (start: number, n: number, price: (i: number) => number): SimMinute[] =>
  Array.from({ length: n }, (_, i) => minute(start + i * 60, price(i), 3_000));
const pairBars = (): SimMinute[] => dense(GRAD_B, 200, (i) => mcap(100_000 + i * 500));
const pairFor = (quote: { address: string; symbol: string }): SimPool => ({
  address: PAIR,
  exchange: 'PumpSwap',
  protocol: 'PumpAmm',
  createdAt: GRAD_B,
  liquidity: 30_000,
  minutes: pairBars(),
  quote,
});

const run = promisify(execFile);

describeDb('graduation pool: refresh moves the role (issue 81)', () => {
  let t: TestDatabase;
  let db: Kysely<Database>;
  let dir: string;
  let coinA: SimCoin;
  let coinB: SimCoin;
  let coinC: SimCoin;
  let queries: string[];
  let clients: SourceClients;

  beforeEach(async () => {
    t = await createTestDatabase(adminUrl!);
    db = t.db;
    dir = await mkdtemp(join(tmpdir(), 'gradpool-'));
    // A: Codex.io names the pair pool (created a month after A's migration). The real pool, created
    // 50 seconds after the migration, is not in the list yet when A is first fetched.
    coinA = {
      mint: A,
      createdAt: LAUNCH_A,
      migratedAt: GRAD_A,
      migratedPoolAddress: PAIR,
      pools: [pairFor({ address: B, symbol: 'BBB' })],
    };
    // B: the pair pool is B's own graduation pool, created at B's migration.
    coinB = {
      mint: B,
      createdAt: LAUNCH_B,
      migratedAt: GRAD_B,
      migratedPoolAddress: PAIR,
      pools: [pairFor({ address: A, symbol: 'AAA' })],
    };
    // C: no named pool; the only pool is five hours after the migration.
    coinC = {
      mint: C,
      createdAt: LAUNCH_A,
      migratedAt: GRAD_A,
      migratedPoolAddress: null,
      pools: [
        {
          address: FAR,
          exchange: 'Raydium',
          protocol: 'RaydiumV4',
          createdAt: GRAD_A + 5 * 3_600,
          liquidity: 50_000,
          minutes: dense(GRAD_A + 5 * 3_600, 200, (i) => mcap(120_000 + i * 700)),
        },
      ],
    };
    const coins = [coinA, coinB, coinC];
    const sims = new Map(coins.map((c) => [c.mint, simProvider(c)]));
    queries = [];
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
    clients = {
      codex,
      helius: { getAssets: async (m) => m.map((x) => asset(x)) },
      jupiter: { getTokens: async (m) => m.map((x) => token(x)) },
      fetchMetadata: async () => okResult({ description: 'd' }),
    };
    await discoverCoins(
      db,
      [
        coinRow(A, {
          launchedAt: new Date(LAUNCH_A * 1000),
          graduatedAt: new Date(GRAD_A * 1000),
          roughAthMarketCapUsd: 5_000_000,
        }),
        // B and C wait: the floor of the run keeps them out until the test raises it.
        coinRow(B, {
          launchedAt: new Date(LAUNCH_B * 1000),
          graduatedAt: new Date(GRAD_B * 1000),
          roughAthMarketCapUsd: 1_000,
        }),
        coinRow(C, {
          launchedAt: new Date(LAUNCH_A * 1000),
          graduatedAt: new Date(GRAD_A * 1000),
          roughAthMarketCapUsd: 1_000,
        }),
      ],
      { now: new Date(NOW * 1000) },
    );
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await t.drop();
  });

  const options = (over: Partial<BackfillOptions> = {}): BackfillOptions => ({
    selection: {
      chain: 'solana',
      minRoughPeakUsd: 30_000,
      includeNoPrice: false,
      order: 'hash',
      limit: null,
    },
    stages: ['candles', 'metrics'],
    codexRps: 10_000,
    maxCodexUnits: 1_000_000,
    confirm: true,
    env: { DATABASE_URL: t.url },
    log: testLog,
    out: () => undefined,
    db,
    clients,
    candlesConcurrency: 4,
    feedPage: 10,
    maxQueued: 20,
    now: () => new Date(NOW * 1000),
    ...over,
  });
  const idOf = async (mint: string): Promise<number> =>
    (
      await db
        .selectFrom('coins')
        .select('id')
        .where('address', '=', mint)
        .executeTakeFirstOrThrow()
    ).id;
  const raise = (mint: string) =>
    sql`update coins set rough_ath_market_cap_usd = 5000000 where address = ${mint}`.execute(db);
  const file = async (lines: string[]): Promise<string> => {
    const f = join(dir, 'coins.txt');
    await writeFile(f, lines.join('\n'));
    return f;
  };
  const pools = async (mint: string) =>
    (
      await sql<{
        address: string;
        id: string;
        is_primary: boolean;
        is_graduation_pool: boolean;
      }>`select p.address, p.id::text as id, p.is_primary, p.is_graduation_pool
        from pools p join coins c on c.id = p.coin_id where c.address = ${mint} order by p.id`.execute(
        db,
      )
    ).rows;
  const stage = async (mint: string, name: 'candles' | 'metrics') =>
    db
      .selectFrom('coin_stages')
      .innerJoin('coins', 'coins.id', 'coin_stages.coin_id')
      .select(['coin_stages.status', 'coin_stages.last_error', 'coin_stages.detail'])
      .where('coins.address', '=', mint)
      .where('coin_stages.stage', '=', name)
      .executeTakeFirstOrThrow();
  const ath = async (mint: string): Promise<number> =>
    Number(
      (
        await db
          .selectFrom('coins')
          .select('ath_market_cap_usd')
          .where('address', '=', mint)
          .executeTakeFirstOrThrow()
      ).ath_market_cap_usd,
    );
  const chunkIds = async (): Promise<string[]> =>
    (
      await sql<{ id: string }>`select pool_id::text || ':' || resolution_sec::text || ':' ||
          chunk_start::text || ':' || bar_count::text as id from candle_chunks order by 1`.execute(
        db,
      )
    ).rows.map((r) => r.id);

  it('moves the role to the pool created at the migration, fetches its bars, deletes nothing; the pair-pool clash then ends with both coins done', async () => {
    // First fetch of A: the pair pool is named, stored, and carries the role.
    await runBackfill(options());
    expect((await pools(A)).map((p) => [p.address, p.is_graduation_pool])).toEqual([[PAIR, true]]);
    expect((await stage(A, 'candles')).status).toBe('done');
    expect((await stage(A, 'metrics')).status).toBe('done');
    const before = await ath(A);
    expect(before).toBeGreaterThan(0);

    // B is the coin the pair pool really belongs to: it cannot be fetched while A holds the pool.
    await raise(B);
    await runBackfill(options());
    const failed = await stage(B, 'candles');
    expect(failed.status).toBe('failed');
    expect(failed.last_error).toContain('pool_claimed_by_two_coins');
    expect(await pools(B)).toEqual([]);

    // Later the list of A holds the pool created at the migration.
    coinA.pools.push({
      address: REAL,
      exchange: 'Raydium',
      protocol: 'RaydiumV4',
      createdAt: GRAD_A + 50,
      liquidity: 4_000, // under the $5,000 an other pool needs: it was dropped before this change
      minutes: dense(GRAD_A + 60, 300, (i) => mcap(250_000 + i * 1_000)),
    });
    const pairBefore = (await pools(A))[0]!;
    const chunksBefore = await chunkIds();
    const requestsBefore = queries.length;

    const report = await runBackfill(
      options({
        refreshPools: { coinsFile: await file([A]) },
        now: () => new Date((NOW + 3_600) * 1000),
      }),
    );
    expect(report.status).toBe('done');

    // The role moved, in the one transaction: one graduation pool, the old one kept as an other pool.
    const after = await pools(A);
    expect(after.map((p) => [p.address, p.is_primary, p.is_graduation_pool])).toEqual([
      [PAIR, false, false],
      [REAL, true, true],
    ]);
    expect(after[0]!.id).toBe(pairBefore.id); // the same row
    // Nothing deleted: every chunk held before is still held, and no bar of it was asked for again.
    const chunksAfter = await chunkIds();
    for (const c of chunksBefore) expect(chunksAfter).toContain(c);
    const asked = queries.slice(requestsBefore);
    expect(asked.filter((q) => q.includes('listPairsWithMetadataForToken'))).toHaveLength(1);
    expect(asked.filter((q) => q.includes('token(input'))).toHaveLength(0);
    const bars = asked.filter((q) => q.includes('getBars('));
    expect(bars.length).toBeGreaterThan(0);
    expect(bars.every((q) => q.includes(REAL))).toBe(true);
    const realChunks = chunksAfter.filter((c) => c.startsWith(`${after[1]!.id}:`));
    expect(realChunks.length).toBeGreaterThan(0);
    // No bar twice: every (pool, resolution, time) is stored once.
    const dup = await sql<{ n: string }>`select count(*)::text as n from (
      select pool_id, resolution_sec, x from candle_chunks, unnest(t) as x
      group by pool_id, resolution_sec, x having count(*) > 1) d`.execute(db);
    expect(dup.rows[0]!.n).toBe('0');
    // Metrics went back to pending and were recomputed, with a higher ATH.
    expect((await stage(A, 'metrics')).status).toBe('done');
    expect(await ath(A)).toBeGreaterThan(before);
    expect((await stage(A, 'candles')).detail).toMatchObject({ graduationMoved: true });
    const open = await db
      .selectFrom('data_issues')
      .select('kind')
      .where('resolved_at', 'is', null)
      .where('kind', '=', 'graduation_pool_late')
      .execute();
    expect(open).toEqual([]);

    // The clash resolved: B can be fetched, and both coins end done.
    await requeueFailed(db, ['candles'], { now: new Date((NOW + 7_200) * 1000) });
    await runBackfill(options({ now: () => new Date((NOW + 7_200) * 1000) }));
    for (const mint of [A, B]) {
      expect((await stage(mint, 'candles')).status).toBe('done');
      expect((await stage(mint, 'metrics')).status).toBe('done');
    }
    expect((await pools(B)).map((p) => [p.address, p.is_graduation_pool])).toEqual([[PAIR, true]]);
    // The pair pool left A as an ordinary other pool, bars and all; A keeps its real pool's role.
    expect((await pools(A)).map((p) => [p.address, p.is_graduation_pool])).toEqual([[REAL, true]]);
    expect((await stage(B, 'candles')).detail).toMatchObject({ poolsTakenOver: 1 });
    expect(await ath(A)).toBeGreaterThan(before);
    expect(await ath(B)).toBeGreaterThan(0);

    // A second refresh of A changes nothing.
    const rows = await snapshotTables(db);
    await runBackfill(
      options({
        refreshPools: { coinsFile: await file([A]) },
        now: () => new Date((NOW + 9_000) * 1000),
      }),
    );
    expect(await snapshotTables(db)).toEqual(rows);
  }, 180_000);

  it('records graduation_pool_late once for a coin whose only pool is far from the migration, not once per retry', async () => {
    await raise(C);
    await runBackfill(options());
    const rows = () =>
      db
        .selectFrom('data_issues')
        .innerJoin('coins', 'coins.id', 'data_issues.coin_id')
        .select(['data_issues.id', 'data_issues.created_at', 'data_issues.detail'])
        .where('coins.address', '=', C)
        .where('data_issues.kind', '=', 'graduation_pool_late')
        .where('data_issues.resolved_at', 'is', null)
        .execute();
    const first = await rows();
    expect(first).toHaveLength(1);
    expect(first[0]!.detail).toEqual({
      distanceSec: 5 * 3_600,
      maxDelaySec: 3_600,
      venue: 'Raydium',
      source: 'closest_to_migration',
    });
    expect((await pools(C)).map((p) => [p.address, p.is_graduation_pool])).toEqual([[FAR, true]]);

    // Retried twice (a refresh lists the pools again): still one open issue. After a refresh the
    // stored pool plays the named pool, so `source` reads migrated_pool_address; the second
    // refresh changes nothing at all.
    let last = first;
    for (const k of [1, 2]) {
      await runBackfill(
        options({
          refreshPools: { coinsFile: await file([C]) },
          now: () => new Date((NOW + k * 3_600) * 1000),
        }),
      );
      const now = await rows();
      expect(now).toHaveLength(1);
      expect(now[0]!.detail).toMatchObject({ distanceSec: 5 * 3_600, venue: 'Raydium' });
      if (k === 2) expect(now).toEqual(last);
      last = now;
    }
  }, 120_000);

  /** The rule and its dry run: seeded rows, no provider. */
  it('the rule picks exactly the right coins; the dry run asks no provider and writes nothing', async () => {
    const idA = await idOf(A);
    const idB = await idOf(B);
    const idC = await idOf(C);
    const done = (id: number) =>
      sql`insert into coin_stages (coin_id, stage, status) values (${id}, 'candles', 'done')
        on conflict (coin_id, stage) do update set status = 'done'`.execute(db);
    // A: graduation pool created a month after A graduated (late). B: on time. C: fetched, no pool.
    await upsertPool(db, {
      chain: 'solana',
      address: PAIR,
      coinId: idA,
      dex: 'PumpSwap',
      isPrimary: true,
      isGraduationPool: true,
      createdAtChain: GRAD_B,
    });
    await upsertPool(db, {
      chain: 'solana',
      address: REAL,
      coinId: idB,
      dex: 'Raydium',
      isPrimary: true,
      isGraduationPool: true,
      createdAtChain: GRAD_B + 60,
    });
    for (const id of [idA, idB, idC]) await done(id);

    const before = queries.length;
    const rows = await snapshotTables(db);
    const stages = (await sql`select * from coin_stages order by coin_id, stage`.execute(db)).rows;
    const lines: string[] = [];
    const report = await runBackfill(
      options({
        confirm: false,
        refreshPools: { rule: 'late-graduation-pool' },
        out: (x) => lines.push(x),
      }),
    );
    expect(report.status).toBe('dry_run');
    expect(report.plan.refresh).toEqual({ coins: 2, candlesDone: 2 }); // A and C, not B
    expect(lines.join('\n')).toMatch(/Pool-list refresh: 2 coins; 2 of them have candles done/);
    expect(lines.join('\n')).toMatch(/one pool-list request a coin, about \d+ compute units/);
    expect(queries.length).toBe(before);
    expect(await snapshotTables(db)).toEqual(rows);
    expect((await sql`select * from coin_stages order by coin_id, stage`.execute(db)).rows).toEqual(
      stages,
    );

    // The same rule printed for --coins, and the refusals of the command line.
    const script = fileURLToPath(new URL('../../scripts/backfill.ts', import.meta.url));
    const cwd = fileURLToPath(new URL('../..', import.meta.url));
    const cli = (args: string[], env: Record<string, string> = {}) =>
      run('node', ['--import', 'tsx', script, ...args], {
        cwd,
        env: {
          PATH: process.env['PATH'] ?? '',
          HOME: process.env['HOME'] ?? '',
          USER: process.env['USER'] ?? '',
          ...env,
        },
      });
    const printed = await cli(['select', '--rule', 'late-graduation-pool'], {
      DATABASE_URL: t.url,
    });
    expect(printed.stdout.trim().split('\n').map(Number)).toEqual([idA, idC]);
    expect(printed.stderr).toContain('2 coins picked by late-graduation-pool');
    for (const [args, message] of [
      [['run', '--refresh-pools'], 'needs a coin selection'],
      [
        ['run', '--refresh-pools', '--coins', 'x.txt', '--rule', 'late-graduation-pool'],
        'alternatives',
      ],
      [['run', '--refresh-pools', '--rule', 'no-such-rule'], 'Unknown rule'],
      [['run', '--rule', 'late-graduation-pool'], 'only used with --refresh-pools'],
    ] as const) {
      await expect(cli([...args])).rejects.toMatchObject({
        code: 2,
        stderr: expect.stringContaining(message),
      });
    }
  }, 120_000);
});
