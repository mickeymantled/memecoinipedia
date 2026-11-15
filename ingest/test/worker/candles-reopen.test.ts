/**
 * A metrics run that raises `peak_outside_minute_coverage` reopens the coin's candles and metrics
 * stages once per candle rules version (issue 43, item 4; `CANDLE_RULES_VERSION`, issue 77). The provider is simulated.
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createRun, discoverCoins, type Database, type StageName } from '@memecoinipedia/db';
import { createTestDatabase, type TestDatabase } from '@memecoinipedia/db/testing';
import { sql, type Kysely } from 'kysely';
import {
  CANDLE_RULES_VERSION,
  fetchCandlesForCoin,
  METRICS_VERSION,
  type FetchCandlesOptions,
} from '../../src/candles/index.js';
import { UnitBudget } from '../../src/sources/budget.js';
import { CodexClient } from '../../src/sources/codex/index.js';
import { StageRegistry } from '../../src/worker/stage.js';
import { discoveredStage } from '../../src/worker/stages/discovered.js';
import { createCandlesStage } from '../../src/worker/stages/candles.js';
import { metricsStage } from '../../src/worker/stages/metrics.js';
import { PipelineWorker } from '../../src/worker/worker.js';
import { snapshotTables } from '../candles/helpers.js';
import { minute, simProvider, type SimCoin, type SimMinute } from '../candles/sim.js';
import { adminUrl, coinRow, describeDb, testLog } from './helpers.js';

const DAY = 86_400;
const T0 = 1_767_225_600;
const LAUNCH = T0 + 3 * 3_600;
const GRAD = LAUNCH + 2 * 3_600;
const NOW = GRAD + 6 * DAY;
const mcap = (usd: number): number => usd / 1e9;
const MINT = 'D'.repeat(43) + '9';

function coinWith(minutes: SimMinute[]): SimCoin {
  const grad = 'C'.repeat(43) + '9';
  return {
    mint: MINT,
    createdAt: LAUNCH,
    migratedAt: GRAD,
    migratedPoolAddress: grad,
    pools: [
      {
        address: grad,
        exchange: 'PumpSwap',
        protocol: 'PumpAmm',
        createdAt: GRAD,
        liquidity: 30_000,
        minutes,
      },
    ],
  };
}

/** A peak inside one hour 26 hours after graduation, beyond the first 1,500 minutes: $585,000. */
const rug = (): SimMinute[] => [
  ...Array.from({ length: 100 }, (_, i) => minute(GRAD + i * 60, mcap(60_000 + i * 900), 3_000)),
  ...Array.from({ length: 40 }, (_, k) =>
    minute(GRAD + 26 * 3_600 + k * 60, mcap(k < 30 ? 150_000 + k * 15_000 : 3_000), 3_000),
  ),
];

/** The flag is raised, but the highest uncovered period is $85,000: under the refine line. */
const lowTarget = (): SimMinute[] => [
  ...Array.from({ length: 100 }, (_, i) =>
    minute(GRAD + i * 60, mcap(i === 50 ? 95_000 : 60_000), 3_000),
  ),
  ...Array.from({ length: 30 }, (_, k) => minute(GRAD + 3 * DAY + k * 60, mcap(85_000), 3_000)),
];

describeDb('reopening candles and metrics after a coverage flag', () => {
  let t: TestDatabase;
  let db: Kysely<Database>;
  let runId: number;
  const workers: PipelineWorker[] = [];

  beforeEach(async () => {
    t = await createTestDatabase(adminUrl!);
    db = t.db;
    runId = await createRun(db, { kind: 'test' });
  });
  afterEach(async () => {
    await Promise.all(
      workers.splice(0).map((w) => w.stop({ timeoutMs: 5000 }).catch(() => undefined)),
    );
    await t.drop();
  });

  /** One coin on a simulated provider; `pass` runs a worker over the chosen stages. */
  async function setup(coin: SimCoin) {
    await discoverCoins(
      db,
      [
        coinRow(coin.mint, {
          launchedAt: new Date(LAUNCH * 1000),
          graduatedAt: new Date(GRAD * 1000),
          roughAthMarketCapUsd: 600_000,
        }),
      ],
      { now: new Date(NOW * 1000) },
    );
    const coinId = (await db.selectFrom('coins').select('id').executeTakeFirstOrThrow()).id;
    const sim = simProvider(coin);
    const codex = new CodexClient({
      apiKey: 'test-key-not-real',
      fetch: sim.fetch,
      budget: new UnitBudget(),
      http: { maxRetries: 0, sleep: async () => {} },
    });
    const limits: { current: FetchCandlesOptions['limits'] } = { current: undefined };
    const registry = new StageRegistry()
      .register(discoveredStage)
      .register(
        createCandlesStage({
          codex,
          fetchCandles: (deps, c) => fetchCandlesForCoin(deps, c, { limits: limits.current }),
        }),
      )
      .register(metricsStage);
    const pass = async (stages: StageName[]): Promise<void> => {
      const w = new PipelineWorker({
        connectionString: t.url,
        db,
        registry,
        stages,
        runId,
        log: testLog,
        concurrency: 2,
        maxAttempts: 1,
        monitorIntervalSeconds: 1,
        pollingIntervalSeconds: 0.5,
        now: () => new Date(NOW * 1000),
      });
      workers.push(w);
      await w.start();
      await w.enqueueNotDone();
      await w.waitUntilIdle();
      await w.stop({ timeoutMs: 5000 });
    };
    const stage = async (name: StageName) =>
      db
        .selectFrom('coin_stages')
        .select(['status', 'attempts', 'detail'])
        .where('coin_id', '=', coinId)
        .where('stage', '=', name)
        .executeTakeFirstOrThrow();
    const flags = async () =>
      (
        await db
          .selectFrom('coins')
          .select('metric_flags')
          .where('id', '=', coinId)
          .executeTakeFirstOrThrow()
      ).metric_flags;
    /**
     * A coin fetched before this change: candles done (refinement off, so the flag stays), with no
     * `metricsVersion` in its detail, and no metrics stage yet.
     */
    const fetchedBefore = async (): Promise<void> => {
      limits.current = { maxRefinementRequests: 0 };
      await pass(['discovered', 'candles']);
      await sql`update coin_stages set detail = detail - 'metricsVersion'
        where coin_id = ${coinId} and stage = 'candles'`.execute(db);
    };
    return { coinId, sim, limits, pass, stage, flags, fetchedBefore };
  }

  const isMinuteQuery = (q: string) => /resolution:"1"/.test(q);

  it('reopens candles and metrics once; the rerun asks only for the missing minutes and the coin ends with the flag gone', async () => {
    const h = await setup(coinWith(rug()));
    await h.fetchedBefore();
    const before = [...h.sim.barsQueries()];
    const lookupsBefore = h.sim.lookups().length;

    // The metrics-only run raises the flag, reopens both stages and ends: candles is not active.
    await h.pass(['metrics']);
    expect(await h.flags()).toContain('peak_outside_minute_coverage');
    expect(await h.stage('candles')).toMatchObject({ status: 'pending', attempts: 0 });
    expect(await h.stage('metrics')).toMatchObject({ status: 'pending', attempts: 0 });
    expect(h.sim.barsQueries()).toEqual(before); // metrics made no request

    // A run that includes candles: candles fetches the missing minutes, then metrics recomputes.
    h.limits.current = undefined;
    await h.pass(['discovered', 'candles', 'metrics']);
    const added = h.sim.barsQueries().slice(before.length);
    expect(added.length).toBeGreaterThan(0);
    expect(added.every(isMinuteQuery)).toBe(true);
    expect(added.some((q) => before.includes(q))).toBe(false); // nothing asked for twice
    expect(h.sim.lookups().length).toBe(lookupsBefore); // pools and launch info are stored
    expect(await h.flags()).not.toContain('peak_outside_minute_coverage');
    expect(await h.stage('candles')).toMatchObject({ status: 'done' });
    expect((await h.stage('candles')).detail).toMatchObject({ metricsVersion: METRICS_VERSION });
    expect(await h.stage('metrics')).toMatchObject({ status: 'done' });
    const ath = await db.selectFrom('coins').select('ath_market_cap_usd').executeTakeFirstOrThrow();
    expect(Number(ath.ath_market_cap_usd)).toBeGreaterThan(540_000);

    // A second run after all that makes no request and changes no row.
    const requests = h.sim.queries.length;
    const rows = await snapshotTables(db);
    const stages = await sql`select * from coin_stages order by coin_id, stage`.execute(db);
    await h.pass(['discovered', 'candles', 'metrics']);
    expect(h.sim.queries.length).toBe(requests);
    expect(await snapshotTables(db)).toEqual(rows);
    expect((await sql`select * from coin_stages order by coin_id, stage`.execute(db)).rows).toEqual(
      stages.rows,
    );
  }, 90_000);

  it('reopens in the same run when candles is active', async () => {
    const h = await setup(coinWith(rug()));
    await h.fetchedBefore();
    h.limits.current = undefined;
    await h.pass(['discovered', 'candles', 'metrics']);
    expect(await h.stage('candles')).toMatchObject({ status: 'done' });
    expect(await h.stage('metrics')).toMatchObject({ status: 'done' });
    expect(await h.flags()).not.toContain('peak_outside_minute_coverage');
    expect((await h.stage('candles')).detail).toMatchObject({ metricsVersion: METRICS_VERSION });
  }, 90_000);

  it('does not reopen a second time when the flag survives the refetch', async () => {
    const h = await setup(coinWith(rug()));
    await h.fetchedBefore();
    await h.pass(['metrics']); // reopens
    // The refetch cannot refine (cap 0), so the flag stays after the recompute.
    h.limits.current = { maxRefinementRequests: 0 };
    await h.pass(['discovered', 'candles', 'metrics']);
    expect(await h.flags()).toContain('peak_outside_minute_coverage');
    expect((await h.stage('candles')).detail).toMatchObject({ metricsVersion: METRICS_VERSION });
    expect(await h.stage('candles')).toMatchObject({ status: 'done' });
    expect(await h.stage('metrics')).toMatchObject({ status: 'done' });

    const requests = h.sim.queries.length;
    const rows = await snapshotTables(db);
    await h.pass(['discovered', 'candles', 'metrics']);
    expect(h.sim.queries.length).toBe(requests);
    expect(await snapshotTables(db)).toEqual(rows);
    expect(await h.stage('candles')).toMatchObject({ status: 'done', attempts: 1 });
  }, 90_000);

  it('does not reopen when the hourly cap was hit', async () => {
    const h = await setup(coinWith(rug()));
    await h.fetchedBefore();
    await sql`update coin_stages set detail = detail || '{"hourlyCapHit": true}'::jsonb
      where coin_id = ${h.coinId} and stage = 'candles'`.execute(db);
    await h.pass(['metrics']);
    expect(await h.flags()).toContain('peak_outside_minute_coverage');
    expect(await h.stage('candles')).toMatchObject({ status: 'done' });
    expect(await h.stage('metrics')).toMatchObject({ status: 'done' });
  }, 90_000);

  it('does not reopen when the candles were already fetched under the current version', async () => {
    const h = await setup(coinWith(rug()));
    await h.fetchedBefore();
    await sql`update coin_stages set detail = detail || ${JSON.stringify({ metricsVersion: METRICS_VERSION })}::jsonb
      where coin_id = ${h.coinId} and stage = 'candles'`.execute(db);
    await h.pass(['metrics']);
    expect(await h.flags()).toContain('peak_outside_minute_coverage');
    expect(await h.stage('candles')).toMatchObject({ status: 'done' });
    expect(await h.stage('metrics')).toMatchObject({ status: 'done' });
  }, 90_000);

  it('a metrics-only run fills ath_near_volume_usd and the flag for a coin computed at version 5, and reopens no candle stage', async () => {
    // Thin trading: 1,000 USD a minute, so the volume near the high is a sliver of its market cap.
    const h = await setup(coinWith(rug().map((m) => ({ ...m, volume: 1_000 }))));
    h.limits.current = undefined;
    await h.pass(['discovered', 'candles', 'metrics']);
    const current = await db
      .selectFrom('coins')
      .select(['ath_market_cap_usd', 'ath_near_volume_usd', 'metric_flags', 'metrics_version'])
      .executeTakeFirstOrThrow();
    expect(current.metrics_version).toBe(METRICS_VERSION);
    expect(current.ath_near_volume_usd).toBeGreaterThan(0);
    expect(current.metric_flags).toContain('ath_thinly_traded');

    // Make the coin look as version 5 left it: no new column, no flag, stages at version 5,
    // candles fetched under version 5.
    await db
      .updateTable('coins')
      .set({
        ath_near_volume_usd: null,
        metrics_version: 5,
        metric_flags: current.metric_flags.filter((f) => f !== 'ath_thinly_traded'),
      })
      .execute();
    await sql`update coin_stages set version = 5 where stage = 'metrics'`.execute(db);
    await sql`update coin_stages set detail = detail || '{"metricsVersion": 5}'::jsonb
      where stage = 'candles'`.execute(db);
    const candlesBefore = await h.stage('candles');
    const requests = h.sim.queries.length;

    await h.pass(['metrics']);

    const after = await db
      .selectFrom('coins')
      .select(['ath_market_cap_usd', 'ath_near_volume_usd', 'metric_flags', 'metrics_version'])
      .executeTakeFirstOrThrow();
    expect(after).toEqual(current);
    expect(await h.stage('metrics')).toMatchObject({ status: 'done' });
    expect(await h.stage('candles')).toEqual(candlesBefore); // done, untouched
    expect(h.sim.queries.length).toBe(requests); // no provider request
  }, 90_000);

  it('the candle rules version is never ahead of the metrics version', () => {
    expect(CANDLE_RULES_VERSION).toBeLessThanOrEqual(METRICS_VERSION);
  });

  it('does not reopen candles fetched under candle rules version 5 when metrics run at version 6', async () => {
    // Rules version 6 only adds an output, so it asks for no bars the fetch did not ask for.
    expect(METRICS_VERSION).toBeGreaterThan(5);
    const h = await setup(coinWith(rug()));
    await h.fetchedBefore();
    await sql`update coin_stages set detail = detail || '{"metricsVersion": 5}'::jsonb
      where coin_id = ${h.coinId} and stage = 'candles'`.execute(db);
    await h.pass(['metrics']);
    expect(await h.flags()).toContain('peak_outside_minute_coverage');
    expect(await h.stage('candles')).toMatchObject({ status: 'done' });
    expect(await h.stage('metrics')).toMatchObject({ status: 'done' });
  }, 90_000);

  it('still reopens candles fetched under metrics version 4', async () => {
    const h = await setup(coinWith(rug()));
    await h.fetchedBefore();
    await sql`update coin_stages set detail = detail || '{"metricsVersion": 4}'::jsonb
      where coin_id = ${h.coinId} and stage = 'candles'`.execute(db);
    await h.pass(['metrics']);
    expect(await h.flags()).toContain('peak_outside_minute_coverage');
    expect(await h.stage('candles')).toMatchObject({ status: 'pending', attempts: 0 });
    expect(await h.stage('metrics')).toMatchObject({ status: 'pending', attempts: 0 });
  }, 90_000);

  it('does not reopen when the flag points only at periods under the refine line', async () => {
    const h = await setup(coinWith(lowTarget()));
    await h.fetchedBefore();
    await h.pass(['metrics']);
    expect(await h.flags()).toContain('peak_outside_minute_coverage');
    expect(await h.stage('candles')).toMatchObject({ status: 'done' });
    expect(await h.stage('metrics')).toMatchObject({ status: 'done' });
  }, 90_000);
});
