/**
 * Issue #118: the loaders prefetch the coins the worker takes next.
 *
 * The first test is the run that went wrong on the dev database: candles done for every coin,
 * `metrics` and `metadata` named together, a metrics stage that finishes at once, so the whole
 * selection is queued for metadata before the first metadata job runs. Helius and Jupiter are
 * counted fakes. The others are the cases next to it: a run started again with jobs left in the
 * queue, the live process started with jobs left, and the queue's own order.
 *
 * Each counting fake stops the run when its count is far beyond the bound, so a failure here is a
 * count, not a timeout.
 */
import { discoverCoins, setLiveState, type Database } from '@memecoinipedia/db';
import { dayKey, STATE_REFRESH } from '../../src/live/constants.js';
import { createTestDatabase, type TestDatabase } from '@memecoinipedia/db/testing';
import { PgBoss } from 'pg-boss';
import type * as Candles from '../../src/candles/index.js';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { runBackfill, type BackfillOptions } from '../../src/backfill/run.js';
import { runLive } from '../../src/live/run.js';
import { METRICS_VERSION } from '../../src/candles/index.js';
import { CANDLES_STAGE_VERSION } from '../../src/worker/stages/candles.js';
import type { SourceClients } from '../../src/worker/run.js';
import { PipelineWorker, queueName } from '../../src/worker/worker.js';
import { buildBackfillRegistry } from '../../src/backfill/setup.js';
import { createMetadataLoaders } from '../../src/worker/stages/metadata.js';
import { UsageMeter } from '../../src/worker/usage.js';
import { captureLog, liveFixture } from '../live/helpers.js';
import {
  adminUrl,
  asset,
  coinRow,
  describeDb,
  mintN,
  seedCoins,
  testLog,
  token,
} from '../worker/helpers.js';

// Metrics finishes at once: the bars are not what is under test, the queue is.
vi.mock('../../src/candles/index.js', async (importOriginal) => {
  const original = await importOriginal<typeof Candles>();
  return {
    ...original,
    computeMetricsForCoin: async () => ({
      ok: true,
      noCandles: false,
      sidePoolsLeftOut: 0,
      asOf: new Date(),
      result: { flags: [] },
    }),
  };
});

/** Coins in the selection. More than the 5,000 the old ring and the loaders' cache hold. */
const COINS = 6_500;
/** Requests above the stated bound that are allowed (a batch cut short at an edge). */
const SLACK = 3;
/** A run that sends this many requests of one kind is stopped: the bound is long gone. */
const RUNAWAY = 600;

interface Counts {
  heliusRequests: number;
  heliusMints: number;
  jupiterRequests: number;
  /** Mints per Helius request, in order. */
  heliusSizes: number[];
  jupiterSizes: number[];
}

/** Helius and Jupiter fakes that count. `before` holds the first Helius request until it resolves. */
function countingClients(
  stop: () => void,
  before?: () => Promise<void>,
): { clients: SourceClients; counts: Counts } {
  const counts: Counts = {
    heliusRequests: 0,
    heliusMints: 0,
    jupiterRequests: 0,
    heliusSizes: [],
    jupiterSizes: [],
  };
  let gate: Promise<void> | undefined;
  const clients: SourceClients = {
    helius: {
      getAssets: async (mints) => {
        if (before) await (gate ??= before());
        counts.heliusRequests++;
        counts.heliusMints += mints.length;
        counts.heliusSizes.push(mints.length);
        if (counts.heliusRequests > RUNAWAY) stop();
        return mints.map((m) => asset(m));
      },
    },
    jupiter: {
      getTokens: async (mints) => {
        counts.jupiterRequests++;
        counts.jupiterSizes.push(mints.length);
        if (counts.jupiterRequests > RUNAWAY) stop();
        return mints.map((m) => token(m));
      },
    },
    fetchMetadata: async () => {
      throw new Error('no metadata file fetch in this test');
    },
  };
  return { clients, counts };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describeDb('metadata prefetch follows the head of the queue (#118)', () => {
  let t: TestDatabase;

  const stageCount = async (stage: string, db: Kysely<Database> = t.db): Promise<number> => {
    const r = await sql<{
      n: string;
    }>`select count(*)::text as n from coin_stages where stage = ${stage} and status = 'done'`.execute(
      db,
    );
    return Number(r.rows[0]!.n);
  };
  const untilCount = async (
    stage: string,
    n: number,
    seconds = 60,
    db: Kysely<Database> = t.db,
  ): Promise<void> => {
    for (let i = 0; i < seconds * 10 && (await stageCount(stage, db)) < n; i++) await wait(100);
  };

  beforeAll(async () => {
    t = await createTestDatabase(adminUrl!);
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await sql`drop schema if exists pgboss cascade`.execute(t.db);
  });

  /** Fresh coins: listed (ATH $250k), candles done at the current version, nothing else. */
  const seed = async (n: number, metricsDone = false): Promise<void> => {
    await sql`delete from coins`.execute(t.db);
    await discoverCoins(
      t.db,
      Array.from({ length: n }, (_, i) => coinRow(mintN(i + 1))),
      { now: new Date() },
    );
    await sql`update coins set ath_market_cap_usd = 250000`.execute(t.db);
    await sql`
      insert into coin_stages (coin_id, stage, status, attempts, version, finished_at)
      select id, 'candles', 'done', 1, ${CANDLES_STAGE_VERSION}, now() from coins`.execute(t.db);
    if (metricsDone) {
      await sql`
        insert into coin_stages (coin_id, stage, status, attempts, version, finished_at)
        select id, 'metrics', 'done', 1, ${METRICS_VERSION}, now() from coins`.execute(t.db);
    }
  };

  const backfillOptions = (
    over: Partial<BackfillOptions> & { stages: NonNullable<BackfillOptions['stages']> },
  ): BackfillOptions => ({
    selection: {
      chain: 'solana',
      minRoughPeakUsd: 30_000,
      includeNoPrice: false,
      order: 'hash',
      limit: null,
    },
    maxHeliusCredits: 1_000_000,
    confirm: true,
    env: { DATABASE_URL: t.url },
    log: testLog,
    out: () => {},
    db: t.db,
    ...over,
  });

  it(
    'metrics and metadata together, the whole selection queued before the first metadata job: about one request per 100 coins for Jupiter, per 1,000 for Helius',
    { timeout: 180_000 },
    async () => {
      await seed(COINS);
      const stop = new AbortController();
      // Hold the first metadata request until metrics is done for every coin: by then the whole
      // selection is queued for metadata (the case the issue is about), whatever the machine's speed.
      const { clients, counts } = countingClients(
        () => stop.abort(),
        () => untilCount('metrics', COINS, 120),
      );
      const report = await runBackfill(
        backfillOptions({ stages: ['metrics', 'metadata'], clients, signal: stop.signal }),
      );
      expect(counts.jupiterRequests).toBeLessThanOrEqual(Math.ceil(COINS / 100) + SLACK);
      expect(counts.heliusRequests).toBeLessThanOrEqual(Math.ceil(COINS / 1000) + SLACK);
      expect(report.status).toBe('done');
      expect(await stageCount('metadata')).toBe(COINS);
    },
  );

  it(
    'a run stopped with jobs left in the queue, then a metadata-only run: no burst of small requests at the start',
    { timeout: 180_000 },
    async () => {
      const coins = 3_000;
      await seed(coins, true);
      // Run 1 stops after its first Helius request, leaving most of the queue behind.
      const stop1 = new AbortController();
      const first = countingClients(() => stop1.abort());
      const inner1 = first.clients.helius.getAssets.bind(first.clients.helius);
      first.clients.helius.getAssets = async (m) => {
        const out = await inner1(m);
        stop1.abort();
        return out;
      };
      const r1 = await runBackfill(
        backfillOptions({ stages: ['metadata'], clients: first.clients, signal: stop1.signal }),
      );
      expect(r1.status).toBe('stopped');
      const left = coins - (await stageCount('metadata'));
      expect(left).toBeGreaterThan(coins / 2);

      // Run 2 starts with run 1's jobs still in the queue.
      const stop2 = new AbortController();
      const second = countingClients(() => stop2.abort());
      const r2 = await runBackfill(
        backfillOptions({ stages: ['metadata'], clients: second.clients, signal: stop2.signal }),
      );
      expect(second.counts.jupiterRequests).toBeLessThanOrEqual(Math.ceil(left / 100) + SLACK);
      expect(second.counts.heliusRequests).toBeLessThanOrEqual(Math.ceil(left / 1000) + SLACK);
      expect(r2.status).toBe('done');
      expect(await stageCount('metadata')).toBe(coins);
    },
  );

  it(
    'a metadata-only run with the default feeder settings: full Helius batches',
    { timeout: 180_000 },
    async () => {
      await seed(COINS, true);
      const stop = new AbortController();
      const { clients, counts } = countingClients(() => stop.abort());
      const report = await runBackfill(
        backfillOptions({ stages: ['metadata'], clients, signal: stop.signal }),
      );
      expect(counts.heliusRequests).toBeLessThanOrEqual(Math.ceil(COINS / 1000) + SLACK);
      expect(counts.jupiterRequests).toBeLessThanOrEqual(Math.ceil(COINS / 100) + SLACK);
      expect(report.status).toBe('done');
      expect(await stageCount('metadata')).toBe(COINS);
    },
  );

  it(
    'the live process started with metadata jobs left in the queue by an earlier process',
    { timeout: 180_000 },
    async () => {
      const f = await liveFixture();
      try {
        const coins = 2_500;
        // Coins whose metrics are done and whose metadata jobs an earlier process queued.
        await f.db
          .insertInto('coins')
          .values(
            Array.from({ length: coins }, (_, i) => ({
              chain: 'solana',
              address: mintN(i + 1),
              ath_market_cap_usd: 250_000,
            })),
          )
          .execute();
        for (const [stage, version] of [
          ['discovered', 1],
          ['candles', CANDLES_STAGE_VERSION],
          ['metrics', METRICS_VERSION],
        ] as const) {
          await sql`
            insert into coin_stages (coin_id, stage, status, attempts, version, finished_at)
            select id, ${stage}, 'done', 1, ${version}, now() from coins`.execute(f.db);
        }
        // An earlier process queued the jobs and ended: a bare queue, no handler.
        const boss = new PgBoss({ connectionString: f.t.url, schema: 'pgboss' });
        await boss.start();
        await boss.createQueue(queueName('metadata'), { policy: 'short' });
        const ids = (await f.db.selectFrom('coins').select('id').orderBy('id').execute()).map(
          (r) => r.id,
        );
        for (let i = 0; i < ids.length; i += 500) {
          await boss.insert(
            queueName('metadata'),
            ids
              .slice(i, i + 500)
              .map((coinId) => ({ data: { coinId }, singletonKey: String(coinId) })),
          );
        }
        await boss.stop({ graceful: true, close: true });

        // Today's price refresh (a Jupiter request per 100 listed coins of its own) is done, so the
        // counts below are the metadata stage's alone.
        await setLiveState(
          f.db,
          STATE_REFRESH,
          { day: dayKey(f.clock.now()), afterId: 0, done: true, requests: 0, coins: 0 },
          f.clock.now(),
        );
        const stop = new AbortController();
        const { clients, counts } = countingClients(() => stop.abort());
        const done = (async () => {
          await untilCount('metadata', coins, 120, f.db);
          stop.abort();
        })();
        await runLive({
          confirm: true,
          env: { DATABASE_URL: f.t.url },
          log: captureLog().log,
          out: () => {},
          db: f.db,
          clients: { ...f.clients, helius: clients.helius, jupiter: clients.jupiter },
          now: f.clock.now,
          tickSeconds: 0.05,
          signal: stop.signal,
          maxCodexUnitsPerDay: 5_000,
        });
        await done;
        expect(counts.jupiterRequests).toBeLessThanOrEqual(Math.ceil(coins / 100) + SLACK);
        expect(counts.heliusRequests).toBeLessThanOrEqual(Math.ceil(coins / 1000) + SLACK);
        expect(await stageCount('metadata', f.db)).toBe(coins);
      } finally {
        await f.cleanup();
      }
    },
  );
  it('queuedCoinIds: running jobs first, then the queue in the order it hands jobs out; retries once due; other queues never', async () => {
    const clients = countingClients(() => {}).clients;
    const worker = new PipelineWorker({
      connectionString: t.url,
      db: t.db,
      registry: buildBackfillRegistry({
        db: t.db,
        clients,
        meter: new UsageMeter(),
        stages: ['metadata'],
        maxAttempts: 3,
        metadataCandidateIds: () => [],
      }).registry,
      stages: ['metadata'],
      runId: 1,
      log: testLog,
    });
    const boss = new PgBoss({ connectionString: t.url, schema: 'pgboss' });
    await boss.start();
    // A long retry delay: a failed job stays in backoff unless the test moves its time.
    await boss.createQueue(queueName('metadata'), {
      policy: 'short',
      retryLimit: 3,
      retryDelay: 3_600,
    });
    await boss.createQueue(queueName('metrics'), { policy: 'short' });
    const put = (stage: 'metadata' | 'metrics', coinId: number, startAfter?: Date) =>
      boss.insert(queueName(stage), [
        {
          data: { coinId },
          singletonKey: String(coinId),
          ...(startAfter ? { startAfter } : {}),
        },
      ]);
    try {
      // Queued in this order, not in coin id order.
      for (const id of [30, 10, 20]) await put('metadata', id);
      await put('metrics', 99);
      await put('metadata', 40, new Date(Date.now() + 3_600_000)); // not due
      expect(await worker.queuedCoinIds('metadata', 10)).toEqual([30, 10, 20]);
      expect(await worker.queuedCoinIds('metadata', 2)).toEqual([30, 10]);
      expect(await worker.queuedCoinIds('metadata', 0)).toEqual([]);

      // The first job is taken: it is running, and still listed first (its coin is being asked for).
      const taken = await boss.fetch<{ coinId: number }>(queueName('metadata'), { batchSize: 1 });
      expect(taken.map((j) => j.data.coinId)).toEqual([30]);
      await put('metadata', 50);
      expect(await worker.queuedCoinIds('metadata', 10)).toEqual([30, 10, 20, 50]);

      // It fails and goes to backoff: out of the list until its delay is over, then back in its place.
      await boss.fail(queueName('metadata'), taken[0]!.id);
      expect(await worker.queuedCoinIds('metadata', 10)).toEqual([10, 20, 50]);
      await sql`update pgboss.job set start_after = now() - interval '1 second'
        where name = ${queueName('metadata')} and state = 'retry'`.execute(t.db);
      expect(await worker.queuedCoinIds('metadata', 10)).toEqual([30, 10, 20, 50]);
    } finally {
      await boss.stop({ graceful: true, close: true });
    }
  });

  it('the loaders ask about the coins in the order given, not in coin id order', async () => {
    await sql`delete from coins`.execute(t.db);
    const ids = await seedCoins(
      t.db,
      Array.from({ length: 12 }, (_, i) => mintN(i + 1)),
    );
    const byAddress = [...ids.entries()];
    const idOf = (n: number) => ids.get(mintN(n))!;
    const requests: string[][] = [];
    // The worker will take 9, 3, 7, 1, 11 next (a queue that is not in id order).
    const { assets } = createMetadataLoaders({
      db: t.db,
      helius: {
        getAssets: async (m) => {
          requests.push([...m]);
          return m.map((x) => asset(x));
        },
      },
      jupiter: { getTokens: async (m) => m.map((x) => token(x)) },
      assetBatch: 3,
      candidateIds: () => [9, 3, 7, 1, 11].map(idOf),
    });
    expect(byAddress.length).toBe(12);
    await assets.get(mintN(9));
    // The coin asked for, then the next coins of the queue: 3 and 7, not the lowest ids (1, 2).
    expect(requests).toEqual([[mintN(9), mintN(3), mintN(7)]]);
  });
});
