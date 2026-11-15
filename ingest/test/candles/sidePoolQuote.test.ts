/**
 * Metric rules v5 (issue 68): a side pool counts only when its quote token is SOL, USDC or USDT,
 * by mint address or by symbol. Tested through the loader and the metrics stage on a throwaway
 * database; no provider is involved.
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  computeAndStoreCoinMetrics,
  createRun,
  getBars,
  loadMetricInput,
  upsertPool,
  putBars,
  OTHER_POOL_QUOTE,
  type CandleBar,
  type Database,
  type MetricInputShape,
} from '@memecoinipedia/db';
import { createTestDatabase, type TestDatabase } from '@memecoinipedia/db/testing';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { computeMetricsForCoin, METRICS_VERSION } from '../../src/candles/index.js';
import { computeCoinMetrics } from '../../src/metrics/index.js';
import { executeStage, type ExecuteOptions } from '../../src/worker/execute.js';
import { StageRegistry } from '../../src/worker/stage.js';
import { metricsStage } from '../../src/worker/stages/metrics.js';
import { seedCoins, mintN, adminUrl, describeDb, testLog } from '../worker/helpers.js';

const HOUR = 3_600;
const DAY = 86_400;
const MEME = 'MemeQuoteToken1111111111111111111111111111';
const mcap = (usd: number): number => usd / 1e9;

describeDb('metric rules v5: which side pools count', () => {
  let t: TestDatabase;
  let db: Kysely<Database>;
  let coinId: number;
  let start: number; // a minute boundary shortly after launch
  let now: Date;

  beforeEach(async () => {
    t = await createTestDatabase(adminUrl!);
    db = t.db;
    coinId = (await seedCoins(db, [mintN(1)])).get(mintN(1))!;
    const launched = await db
      .selectFrom('coins')
      .select('launched_at')
      .where('id', '=', coinId)
      .executeTakeFirstOrThrow();
    start = Math.floor(launched.launched_at!.getTime() / 1000 / DAY) * DAY + HOUR;
    now = new Date((start + 3 * DAY) * 1000);
  });
  afterEach(async () => {
    await t.drop();
  });

  const bar = (t0: number, usd: number, volume = 3_000): CandleBar => ({
    t: t0,
    o: mcap(usd),
    h: mcap(usd),
    l: mcap(usd),
    c: mcap(usd),
    volumeUsd: volume,
    trades: 20,
    traders: 10,
    liquidityUsd: 30_000,
  });

  async function addPool(
    address: string,
    opts: { primary: boolean; quote: string | null },
  ): Promise<number> {
    return upsertPool(db, {
      chain: 'solana',
      address,
      coinId,
      dex: 'PumpSwap',
      isPrimary: opts.primary,
      isGraduationPool: opts.primary,
      quoteToken: opts.quote,
    });
  }

  /**
   * A graduation pool quoted in SOL that tops out at $150,000, and a side pool that trades later
   * at $5,000,000 (minute bars) and prints an hourly bar at $9,000,000 two days on.
   */
  async function seedCoin(sideQuote: string | null): Promise<{ grad: string; side: string }> {
    const grad = 'G'.repeat(40) + 'rad1';
    const side = 'S'.repeat(40) + 'ide1';
    const gradId = await addPool(grad, { primary: true, quote: OTHER_POOL_QUOTE.SOL });
    const sideId = await addPool(side, { primary: false, quote: sideQuote });
    await putBars(
      db,
      gradId,
      60,
      Array.from({ length: 60 }, (_, i) => bar(start + i * 60, 100_000 + i * 850)),
    );
    await putBars(
      db,
      sideId,
      60,
      Array.from({ length: 20 }, (_, i) => bar(start + 7_200 + i * 60, 5_000_000, 6_000)),
    );
    await putBars(db, sideId, 3600, [bar(start + 2 * DAY, 9_000_000, 20_000)]);
    return { grad, side };
  }

  const run = () => computeMetricsForCoin({ db, clock: () => now }, { id: coinId });

  it.each([
    ['SOL', 'SOL'],
    ['USDC', 'USDC'],
    ['USDT', 'USDT'],
    ['wrapped SOL address', OTHER_POOL_QUOTE.SOL],
    ['USDC address', OTHER_POOL_QUOTE.USDC],
    ['USDT address', OTHER_POOL_QUOTE.USDT],
    ['a symbol with spaces around it', '  USDC '],
  ])('a side pool quoted in %s still counts', async (_name, quote) => {
    const { side } = await seedCoin(quote);
    const r = await run();
    if (!r.ok) throw new Error('metrics failed');
    expect(r.sidePoolsLeftOut).toBe(0);
    expect(r.result.athPoolAddress).toBe(side);
    expect(r.result.athMarketCapUsd).toBeGreaterThan(4_000_000);
    expect(r.result.flags).toContain('peak_outside_minute_coverage'); // the hourly $9M print
  });

  it.each([
    ['another token (address)', MEME],
    ['another token (symbol)', 'BONK'],
    ['a lower-case symbol', 'sol'],
    ['no quote token recorded', null],
  ])(
    'a side pool quoted in %s is left out: ATH, wick, level series and coverage come from the graduation pool alone',
    async (_name, quote) => {
      const { grad, side } = await seedCoin(quote);
      const r = await run();
      if (!r.ok) throw new Error('metrics failed');
      expect(r.sidePoolsLeftOut).toBe(1);
      expect(r.result.athPoolAddress).toBe(grad);
      expect(r.result.athWickPoolAddress).toBe(grad);
      expect(r.result.athMarketCapUsd).toBeGreaterThan(140_000);
      expect(r.result.athMarketCapUsd).toBeLessThan(160_000);
      expect(r.result.athWickMarketCapUsd).toBeLessThan(160_000);
      // The level series: never near $1M, so no time above it; time above $100k is the graduation pool's.
      expect(r.result.secondsAbove[1]).toBe(0);
      expect(r.result.secondsAbove[0]).toBeGreaterThan(0);
      expect(r.result.flags).not.toContain('peak_outside_minute_coverage');
      // Nothing is deleted: the side pool and its bars are still stored.
      const sideRow = await db
        .selectFrom('pools')
        .select('id')
        .where('address', '=', side)
        .executeTakeFirstOrThrow();
      expect((await getBars(db, sideRow.id, 60)).length).toBe(20);
      expect((await getBars(db, sideRow.id, 3600)).length).toBe(1);
    },
  );

  it('a graduation pool quoted in another token keeps counting', async () => {
    const grad = 'G'.repeat(40) + 'rad2';
    const gradId = await addPool(grad, { primary: true, quote: MEME });
    await putBars(
      db,
      gradId,
      60,
      Array.from({ length: 30 }, (_, i) => bar(start + i * 60, 200_000)),
    );
    const r = await run();
    if (!r.ok) throw new Error('metrics failed');
    expect(r.sidePoolsLeftOut).toBe(0);
    expect(r.result.athPoolAddress).toBe(grad);
    expect(r.result.athMarketCapUsd).toBeCloseTo(200_000, 0);
  });

  it('the metrics stage and the fetcher see the same pool set, and the stage records the count', async () => {
    const { grad } = await seedCoin(MEME);
    await addPool('T'.repeat(40) + 'ide2', { primary: false, quote: 'USDT' });
    const asOf = Math.floor(now.getTime() / 1000);

    // The fetcher's peak refinement (and the screened-out path) call `loadMetricInput`.
    const fetcher = await loadMetricInput(db, coinId, asOf);
    if (!fetcher.ok) throw new Error('load failed');
    // The metrics stage computes through `computeAndStoreCoinMetrics`, which calls the same loader.
    let stageInput: MetricInputShape | null = null;
    await computeAndStoreCoinMetrics(db, coinId, {
      compute: (input) => {
        stageInput = input;
        return computeCoinMetrics(input);
      },
      asOf,
      computedAt: now,
      metricsVersion: METRICS_VERSION,
    });
    expect(stageInput).not.toBeNull();
    const addresses = (i: MetricInputShape) => i.pools.map((p) => p.address);
    expect(addresses(stageInput!)).toEqual(addresses(fetcher.input));
    expect(addresses(fetcher.input)).toEqual([grad, 'T'.repeat(40) + 'ide2']);
    expect(fetcher.sidePoolsLeftOut).toBe(1);
    expect(fetcher.poolIds.size).toBe(3); // the left-out pool keeps its id

    const opts: ExecuteOptions = {
      db,
      registry: new StageRegistry().register(metricsStage),
      now: () => now,
      log: testLog,
      runId: await createRun(db, { kind: 'test' }),
      maxAttempts: 3,
    };
    expect((await executeStage(opts, 'metrics', coinId)).kind).toBe('done');
    const row = await db
      .selectFrom('coin_stages')
      .select('detail')
      .where('coin_id', '=', coinId)
      .where('stage', '=', 'metrics')
      .executeTakeFirstOrThrow();
    expect(row.detail).toMatchObject({ sidePoolsLeftOut: 1 });
  });

  it('has no sidePoolsLeftOut in the detail when none is left out', async () => {
    await seedCoin('USDC');
    const opts: ExecuteOptions = {
      db,
      registry: new StageRegistry().register(metricsStage),
      now: () => now,
      log: testLog,
      runId: await createRun(db, { kind: 'test' }),
      maxAttempts: 3,
    };
    await executeStage(opts, 'metrics', coinId);
    const row = await db
      .selectFrom('coin_stages')
      .select('detail')
      .where('coin_id', '=', coinId)
      .where('stage', '=', 'metrics')
      .executeTakeFirstOrThrow();
    expect(row.detail ?? {}).not.toHaveProperty('sidePoolsLeftOut');
  });

  it('is version 8: a coin done at version 7 is recomputed, and a second pass does nothing', async () => {
    expect(METRICS_VERSION).toBe(8);
    expect(metricsStage.version).toBe(8);
    await seedCoin(MEME);
    const opts: ExecuteOptions = {
      db,
      registry: new StageRegistry().register(metricsStage),
      now: () => now,
      log: testLog,
      runId: await createRun(db, { kind: 'test' }),
      maxAttempts: 3,
    };
    expect((await executeStage(opts, 'metrics', coinId)).kind).toBe('done');
    // Pretend the coin was finished under version 7.
    await sql`update coin_stages set version = 7 where coin_id = ${coinId} and stage = 'metrics'`.execute(
      db,
    );
    await db.updateTable('coins').set({ metrics_version: 7 }).where('id', '=', coinId).execute();
    expect((await executeStage(opts, 'metrics', coinId)).kind).toBe('done');
    const after = await db
      .selectFrom('coins')
      .select('metrics_version')
      .where('id', '=', coinId)
      .executeTakeFirstOrThrow();
    expect(after.metrics_version).toBe(8);
    const stage = await db
      .selectFrom('coin_stages')
      .selectAll()
      .where('coin_id', '=', coinId)
      .where('stage', '=', 'metrics')
      .executeTakeFirstOrThrow();
    expect(stage.version).toBe(8);
    expect((await executeStage(opts, 'metrics', coinId)).kind).toBe('final');
    expect(
      await db.selectFrom('coin_stages').selectAll().where('coin_id', '=', coinId).execute(),
    ).toContainEqual(stage);
  });
});
