/**
 * `backfill run --refresh-pools --coins FILE` (issue 72): complete the pool list of coins that
 * are already fetched, through the candles stage, on a simulated provider.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { discoverCoins, upsertPool, type Database } from '@memecoinipedia/db';
import { createTestDatabase, type TestDatabase } from '@memecoinipedia/db/testing';
import { sql, type Kysely } from 'kysely';
import { parseCoinRefs } from '../../src/backfill/refresh.js';
import { runBackfill, type BackfillOptions } from '../../src/backfill/run.js';
import { UnitBudget } from '../../src/sources/budget.js';
import { CodexClient } from '../../src/sources/codex/index.js';
import type { SourceClients } from '../../src/worker/run.js';
import { snapshotTables } from '../candles/helpers.js';
import { minute, simProvider, type SimCoin, type SimMinute, type SimPool } from '../candles/sim.js';
import { asset, coinRow, okResult, token } from '../worker/helpers.js';
import { adminUrl, describeDb, testLog } from './helpers.js';

const DAY = 86_400;
const T0 = 1_767_225_600;
const LAUNCH = T0 + 3 * 3_600;
const GRAD = LAUNCH + 2 * 3_600;
const NOW = GRAD + 5 * DAY;
const mcap = (usd: number): number => usd / 1e9;
const addr = (ch: string, tag: string): string => ch.repeat(44 - tag.length) + tag;

const A = addr('A', 'a');
const Y = addr('Y', 'y');
const GRAD_A = addr('G', 'a');
const P1 = addr('P', 'one');
const Q = addr('Q', 'two');
const R = addr('R', 'three');
const S = addr('S', 'four');

const dense = (start: number, n: number, price: (i: number) => number): SimMinute[] =>
  Array.from({ length: n }, (_, i) => minute(start + i * 60, price(i), 3_000));
const pool = (address: string, over: Partial<SimPool> = {}): SimPool => ({
  address,
  exchange: 'Raydium',
  protocol: 'Raydium',
  createdAt: GRAD + 600,
  liquidity: 50_000,
  minutes: dense(GRAD + 600, 120, (i) => mcap(150_000 + i * 1_000)),
  ...over,
});
const WEIRD = { address: addr('W', 'weird'), symbol: 'WEIRD' };

const run = promisify(execFile);

describeDb('backfill run --refresh-pools', () => {
  let t: TestDatabase;
  let db: Kysely<Database>;
  let dir: string;
  let coinA: SimCoin;
  let provider: ReturnType<typeof simProvider>;
  let clients: SourceClients;
  let aId = 0;

  beforeEach(async () => {
    t = await createTestDatabase(adminUrl!);
    db = t.db;
    dir = await mkdtemp(join(tmpdir(), 'refresh-'));
    // A's list when it was first fetched: the graduation pool and one side pool.
    coinA = {
      mint: A,
      createdAt: LAUNCH,
      migratedAt: GRAD,
      migratedPoolAddress: GRAD_A,
      pools: [
        pool(GRAD_A, {
          createdAt: GRAD,
          minutes: dense(GRAD, 200, (i) => mcap(60_000 + i * 2_211)),
        }),
        pool(P1),
      ],
    };
    await discoverCoins(
      db,
      [A, Y].map((mint) =>
        coinRow(mint, {
          launchedAt: new Date(LAUNCH * 1000),
          graduatedAt: new Date(GRAD * 1000),
          // Y is not selected by the run's floor; only A is fetched.
          roughAthMarketCapUsd: mint === A ? 5_000_000 : 1_000,
        }),
      ),
      { now: new Date(NOW * 1000) },
    );
    aId = (
      await db.selectFrom('coins').select('id').where('address', '=', A).executeTakeFirstOrThrow()
    ).id;
    provider = simProvider(coinA);
    const codex = new CodexClient({
      apiKey: 'test-key-not-real',
      fetch: provider.fetch,
      budget: new UnitBudget(),
      http: { maxRetries: 0, sleep: async () => {} },
    });
    clients = {
      codex,
      helius: { getAssets: async (m) => m.map((x) => asset(x)) },
      jupiter: { getTokens: async (m) => m.map((x) => token(x)) },
      fetchMetadata: async () => okResult({ description: 'd' }),
    };
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
  const coinsFile = async (lines: string[]): Promise<string> => {
    const file = join(dir, 'coins.txt');
    await writeFile(file, lines.join('\n'));
    return file;
  };
  const poolAddresses = async () =>
    (
      await db
        .selectFrom('pools')
        .select('address')
        .where('coin_id', '=', aId)
        .orderBy('address')
        .execute()
    ).map((p) => p.address);
  const metricsRow = () =>
    db
      .selectFrom('coins')
      .select(['metrics_computed_at', 'ath_market_cap_usd'])
      .where('id', '=', aId)
      .executeTakeFirstOrThrow();

  it('adds the pools a first attempt missed, with their bars, and recomputes the metrics; a complete list costs one request', async () => {
    // First fetch, as before.
    await runBackfill(options());
    expect(await poolAddresses()).toEqual([GRAD_A, P1].sort());
    // Later: the list holds more. Q is liquid and quoted in SOL; R is quoted in another token; S
    // is held by another coin (so storing it clashed).
    coinA.pools.push(pool(Q), pool(R, { quote: WEIRD }), pool(S));
    await upsertPool(db, {
      chain: 'solana',
      address: S,
      coinId: (
        await db.selectFrom('coins').select('id').where('address', '=', Y).executeTakeFirstOrThrow()
      ).id,
      dex: 'Raydium',
      isPrimary: true,
      isGraduationPool: true,
    });
    const before = await metricsRow();
    const stored = provider.queries.length;
    const file = await coinsFile([A]);

    const report = await runBackfill(
      options({ refreshPools: { coinsFile: file }, now: () => new Date((NOW + 3_600) * 1000) }),
    );
    expect(report.status).toBe('done');
    expect(await poolAddresses()).toEqual([GRAD_A, P1, Q].sort());
    const asked = provider.queries.slice(stored);
    expect(asked.filter((q) => q.includes('listPairsWithMetadataForToken'))).toHaveLength(1);
    expect(asked.filter((q) => q.includes('token(input'))).toHaveLength(0);
    const bars = asked.filter((q) => q.includes('getBars('));
    expect(bars.length).toBeGreaterThan(0);
    expect(bars.every((q) => q.includes(Q))).toBe(true); // nothing held is asked for again
    const qChunks = await sql<{ n: string }>`select count(*)::text as n from candle_chunks c
      join pools p on p.id = c.pool_id where p.address = ${Q}`.execute(db);
    expect(Number(qChunks.rows[0]!.n)).toBeGreaterThan(0);
    const detail = (
      await db
        .selectFrom('coin_stages')
        .select('detail')
        .where('coin_id', '=', aId)
        .where('stage', '=', 'candles')
        .executeTakeFirstOrThrow()
    ).detail as Record<string, unknown>;
    expect(detail).toMatchObject({ poolsAdded: 1, otherQuotePools: 2 });
    const metricsStage = await db
      .selectFrom('coin_stages')
      .select('status')
      .where('coin_id', '=', aId)
      .where('stage', '=', 'metrics')
      .executeTakeFirstOrThrow();
    expect(metricsStage.status).toBe('done');
    expect((await metricsRow()).metrics_computed_at).not.toEqual(before.metrics_computed_at);

    // Refresh again: the list is complete. One list request, no bars, metrics untouched.
    const again = await metricsRow();
    const rows = await snapshotTables(db);
    const requests = provider.queries.length;
    await runBackfill(
      options({ refreshPools: { coinsFile: file }, now: () => new Date((NOW + 7_200) * 1000) }),
    );
    const second = provider.queries.slice(requests);
    expect(second).toHaveLength(1);
    expect(second[0]).toContain('listPairsWithMetadataForToken');
    expect(await metricsRow()).toEqual(again);
    expect(await snapshotTables(db)).toEqual(rows);
  }, 120_000);

  it('a dry run prints the estimate, asks no provider and writes nothing', async () => {
    await runBackfill(options());
    const rows = await snapshotTables(db);
    const stages = (await sql`select * from coin_stages order by coin_id, stage`.execute(db)).rows;
    const requests = provider.queries.length;
    const lines: string[] = [];
    const report = await runBackfill(
      options({
        confirm: false,
        refreshPools: { coinsFile: await coinsFile([String(aId)]) },
        out: (x) => lines.push(x),
      }),
    );
    expect(report.status).toBe('dry_run');
    expect(report.plan.refresh).toEqual({ coins: 1, candlesDone: 1 });
    expect(lines.join('\n')).toMatch(/Pool-list refresh: 1 coins; 1 of them have candles done/);
    expect(lines.join('\n')).toMatch(/one pool-list request a coin, about \d+ compute units/);
    expect(lines.join('\n')).toMatch(/cannot be known before the list is read/);
    expect(provider.queries.length).toBe(requests);
    expect(await snapshotTables(db)).toEqual(rows);
    expect((await sql`select * from coin_stages order by coin_id, stage`.execute(db)).rows).toEqual(
      stages,
    );
  }, 120_000);

  it('refuses to run without a coin selection, and a coin list that names an unknown coin', async () => {
    const script = fileURLToPath(new URL('../../scripts/backfill.ts', import.meta.url));
    const cwd = fileURLToPath(new URL('../..', import.meta.url));
    await expect(
      run('node', ['--import', 'tsx', script, 'run', '--refresh-pools'], {
        cwd,
        env: { PATH: process.env['PATH'] ?? '' },
      }),
    ).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('needs a coin selection') });
    await expect(
      runBackfill(
        options({
          confirm: false,
          refreshPools: { coinsFile: await coinsFile([addr('U', 'nknown')]) },
        }),
      ),
    ).rejects.toThrow(/not in the database/);
  });

  it('reads a coin list: ids and addresses, comments and blanks', () => {
    expect(parseCoinRefs(`# first\n12\n\n${A}, extra\n12\n`)).toEqual(['12', A]);
    expect(() => parseCoinRefs('not a coin!')).toThrow(/Not a coin id/);
  });
});
