/**
 * A pool-list refresh that is stopped and started again carries on: it does not list the coins it
 * finished a second time (issue 86). Simulated provider.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { discoverCoins, type Database } from '@memecoinipedia/db';
import { createTestDatabase, type TestDatabase } from '@memecoinipedia/db/testing';
import type { Kysely } from 'kysely';
import { runBackfill, type BackfillOptions } from '../../src/backfill/run.js';
import { UnitBudget } from '../../src/sources/budget.js';
import { CodexClient } from '../../src/sources/codex/index.js';
import type { FetchLike } from '../../src/sources/http.js';
import type { SourceClients } from '../../src/worker/run.js';
import { minute, simProvider, type SimCoin, type SimMinute, type SimPool } from '../candles/sim.js';
import { asset, coinRow, okResult, token } from '../worker/helpers.js';
import { adminUrl, describeDb, testLog } from './helpers.js';

const DAY = 86_400;
const T0 = 1_767_225_600;
const LAUNCH = T0 + 3 * 3_600;
const GRAD = LAUNCH + 2 * 3_600;
const NOW = GRAD + 5 * DAY;
const COINS = 8;
const mcap = (usd: number): number => usd / 1e9;
const addr = (ch: string, tag: string): string => ch.repeat(44 - tag.length) + tag;
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

describeDb('backfill run --refresh-pools, stopped and started again', () => {
  let t: TestDatabase;
  let db: Kysely<Database>;
  let dir: string;
  let sims: SimCoin[];
  let listRequests: Map<string, number>;
  let onList: (total: number) => void;
  let clients: SourceClients;

  beforeEach(async () => {
    t = await createTestDatabase(adminUrl!);
    db = t.db;
    dir = await mkdtemp(join(tmpdir(), 'refresh-continue-'));
    sims = Array.from({ length: COINS }, (_, i) => {
      const tag = `n${'abcdefghij'[i]}`;
      return {
        mint: addr('A', tag),
        createdAt: LAUNCH,
        migratedAt: GRAD,
        migratedPoolAddress: addr('G', tag),
        pools: [
          pool(addr('G', tag), {
            createdAt: GRAD,
            minutes: dense(GRAD, 200, (k) => mcap(60_000 + k * 2_211)),
          }),
          pool(addr('P', tag)),
        ],
      };
    });
    await discoverCoins(
      db,
      sims.map((s) =>
        coinRow(s.mint, {
          launchedAt: new Date(LAUNCH * 1000),
          graduatedAt: new Date(GRAD * 1000),
          roughAthMarketCapUsd: 5_000_000,
        }),
      ),
      { now: new Date(NOW * 1000) },
    );
    const providers = new Map(sims.map((s) => [s.mint, simProvider(s)]));
    listRequests = new Map();
    onList = () => undefined;
    const fetch: FetchLike = async (url, init) => {
      const query = (JSON.parse(init.body) as { query: string }).query;
      const owner =
        sims.find((s) => query.includes(s.mint)) ??
        sims.find((s) => s.pools.some((p) => query.includes(p.address)));
      if (!owner) throw new Error('unrouted query');
      const answer = await providers.get(owner.mint)!.fetch(url, init);
      if (query.includes('listPairsWithMetadataForToken')) {
        listRequests.set(owner.mint, (listRequests.get(owner.mint) ?? 0) + 1);
        onList([...listRequests.values()].reduce((a, b) => a + b, 0));
      }
      return answer;
    };
    clients = {
      codex: new CodexClient({
        apiKey: 'test-key-not-real',
        fetch,
        budget: new UnitBudget(),
        http: { maxRetries: 0, sleep: async () => {} },
      }),
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
    candlesConcurrency: 1,
    feedPage: 2,
    maxQueued: 2,
    now: () => new Date(NOW * 1000),
    ...over,
  });
  const doneCount = async (): Promise<number> =>
    (
      await db
        .selectFrom('coin_stages')
        .select('coin_id')
        .where('stage', '=', 'candles')
        .where('status', '=', 'done')
        .execute()
    ).length;

  it("asks for each coin's pool list once in total, and a refresh that finished is a new refresh the next time", async () => {
    await runBackfill(options());
    expect(await doneCount()).toBe(COINS);
    listRequests.clear();
    const ids = (await db.selectFrom('coins').select('id').orderBy('id').execute()).map(
      (r) => r.id,
    );
    const file = join(dir, 'coins.txt');
    await writeFile(file, ids.join('\n'));
    const later = () => new Date((NOW + 3_600) * 1000);

    // The refresh is stopped after its fourth list request.
    const stop = new AbortController();
    onList = (total) => {
      if (total >= 4) stop.abort();
    };
    const first = await runBackfill(
      options({ refreshPools: { coinsFile: file }, now: later, signal: stop.signal }),
    );
    expect(first.status).toBe('stopped');
    const askedFirst = [...listRequests.values()].reduce((a, b) => a + b, 0);
    expect(askedFirst).toBeGreaterThanOrEqual(4);
    expect(askedFirst).toBeLessThan(COINS);

    // Started again with the same list: it carries on.
    onList = () => undefined;
    const second = await runBackfill(options({ refreshPools: { coinsFile: file }, now: later }));
    expect(second.status).toBe('done');
    expect(listRequests.size).toBe(COINS);
    for (const [mint, n] of listRequests) expect(`${mint}: ${n}`).toBe(`${mint}: 1`);
    expect(await doneCount()).toBe(COINS);

    // That refresh ended done: asking for the same list again is a new refresh, every coin again.
    listRequests.clear();
    const third = await runBackfill(options({ refreshPools: { coinsFile: file }, now: later }));
    expect(third.status).toBe('done');
    for (const [mint, n] of listRequests) expect(`${mint}: ${n}`).toBe(`${mint}: 1`);
    expect(listRequests.size).toBe(COINS);
  }, 180_000);
});
