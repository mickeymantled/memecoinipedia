/**
 * Follow-ups to the candles and metrics stages (issue 43): the candles stage replaces its own data
 * issues on a re-run, and a coin with no stored bar ends the metrics stage as done.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createRun, replaceCoinIssues, upsertCoin, type Database } from '@memecoinipedia/db';
import { createTestDatabase, type TestDatabase } from '@memecoinipedia/db/testing';
import type { Kysely } from 'kysely';
import {
  EXHAUSTIVE_PLAN_LIMITS,
  METRICS_VERSION,
  fetchCandlesForCoin,
  type FetchCandlesResult,
} from '../../src/candles/index.js';
import { UnitBudget } from '../../src/sources/budget.js';
import { CodexClient } from '../../src/sources/codex/index.js';
import { executeStage, type ExecuteOptions } from '../../src/worker/execute.js';
import { StageRegistry, type StageCoin } from '../../src/worker/stage.js';
import { createCandlesStage } from '../../src/worker/stages/candles.js';
import { metricsStage } from '../../src/worker/stages/metrics.js';
import { loadCandleFixture, replayFetch } from '../candles/helpers.js';
import { adminUrl, describeDb, mintN, seedCoins, testLog } from './helpers.js';

describeDb('candles and metrics stage follow-ups', () => {
  let t: TestDatabase;
  let db: Kysely<Database>;
  let runId: number;

  beforeAll(async () => {
    t = await createTestDatabase(adminUrl!);
    db = t.db;
    runId = await createRun(db, { kind: 'test' });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await db.deleteFrom('data_issues').execute();
    await db.deleteFrom('coin_stages').execute();
    await db.deleteFrom('coins').execute();
  });

  const openIssues = async (coinId: number) =>
    db
      .selectFrom('data_issues')
      .select(['id', 'kind'])
      .where('coin_id', '=', coinId)
      .where('resolved_at', 'is', null)
      .orderBy('kind')
      .execute();

  describe('candle issues on a re-run', () => {
    it("a coin that hit the hourly cap once and not the second time ends with no such issue, and metadata's issues stay", async () => {
      const f = loadCandleFixture('VANGOAT');
      const coinId = await upsertCoin(db, {
        chain: 'solana',
        address: f.mint,
        ticker: f.symbol,
        launchpad: 'pump.fun',
      });
      const coin = { id: coinId, address: f.mint, chain: 'solana' } as StageCoin;
      const replay = replayFetch([f]);
      const codex = new CodexClient({
        apiKey: 'test-key-not-real',
        fetch: replay.fetch,
        budget: new UnitBudget(),
        http: { maxRetries: 0, sleep: async () => {} },
      });
      let runs = 0;
      let first: FetchCandlesResult | null = null;
      const stage = createCandlesStage({
        codex,
        // The first run is the real fetch over the recording (it hits the cap). The second finds
        // the same bars, makes no request, and reports no cap hit.
        fetchCandles: async (deps, c) => {
          runs++;
          if (runs === 1) {
            first = await fetchCandlesForCoin(deps, c, { limits: EXHAUSTIVE_PLAN_LIMITS });
            return first;
          }
          const s = first!.summary;
          return {
            ok: true,
            summary: {
              ...s,
              hourlyCapHit: false,
              issues: [],
              issueRecords: [],
              issueKindsChecked: ['candle_hourly_cap_hit', 'peak_refinement_incomplete'],
            },
          };
        },
      });
      const ctx = { db, now: () => new Date(f.asOf * 1000), log: testLog, runId };

      // Metadata's issue, written by another stage.
      await replaceCoinIssues(db, coinId, ['asset_not_found'], [{ kind: 'asset_not_found' }]);
      const metadataIssue = (await openIssues(coinId)).find((i) => i.kind === 'asset_not_found')!;

      expect((await stage.run(ctx, coin)).status).toBe('done');
      expect((await openIssues(coinId)).map((i) => i.kind)).toEqual([
        'asset_not_found',
        'candle_hourly_cap_hit',
      ]);

      expect((await stage.run(ctx, coin)).status).toBe('done');
      const after = await openIssues(coinId);
      expect(after.map((i) => i.kind)).toEqual(['asset_not_found']);
      expect(after[0]).toEqual(metadataIssue); // the same row

      // Running the real fetch again over the same bars records the same single issue, not two.
      runs = 0;
      expect((await stage.run(ctx, coin)).status).toBe('done');
      expect((await openIssues(coinId)).map((i) => i.kind)).toEqual([
        'asset_not_found',
        'candle_hourly_cap_hit',
      ]);
    });

    it('a run that did not look at an issue kind leaves that kind as it was', async () => {
      const f = loadCandleFixture('VANGOAT');
      const coinId = await upsertCoin(db, { chain: 'solana', address: f.mint });
      await replaceCoinIssues(
        db,
        coinId,
        ['graduation_pool_not_found'],
        [{ kind: 'graduation_pool_not_found', detail: { poolsListed: 3 } }],
      );
      const codex = new CodexClient({
        apiKey: 'test-key-not-real',
        fetch: replayFetch([]).fetch,
        budget: new UnitBudget(),
        http: { maxRetries: 0, sleep: async () => {} },
      });
      const stage = createCandlesStage({
        codex,
        fetchCandles: async (_deps, c) => ({
          ok: true,
          summary: {
            coinId: c.id,
            mint: c.address,
            asOf: 0,
            path: 'light',
            screenedOut: false,
            w: null,
            escalated: false,
            pools: [],
            skippedOtherPools: 0,
            otherQuotePools: null,
            poolsTakenOver: 0,
            poolsAdded: 0,
            launchInfoNamedPool: null,
            graduationPoolUnverified: false,
            barsFetched: { '1m': 0, '1h': 0, '1d': 0 },
            barsStored: { '1m': 0, '1h': 0, '1d': 0 },
            requests: 0,
            lookupRequests: 0,
            units: 0,
            estimate: null,
            refinementRounds: 0,
            refinementRequestsTotal: 0,
            hourlyCapHit: false,
            flags: [],
            issues: [],
            issueRecords: [],
            // The pools were not listed in this run, so the graduation issue was not re-examined.
            issueKindsChecked: ['candle_hourly_cap_hit', 'peak_refinement_incomplete'],
          },
        }),
      });
      const coin = { id: coinId, address: f.mint, chain: 'solana' } as StageCoin;
      await stage.run({ db, now: () => new Date(), log: testLog, runId }, coin);
      expect((await openIssues(coinId)).map((i) => i.kind)).toEqual(['graduation_pool_not_found']);
    });
  });

  describe('a coin with no stored bars', () => {
    const opts = (): ExecuteOptions => ({
      db,
      registry: new StageRegistry().register(metricsStage),
      now: () => new Date(),
      log: testLog,
      runId,
      maxAttempts: 3,
    });

    it('ends the metrics stage as done with a null ATH and the no_candles flag, and a second run does nothing', async () => {
      const coinId = (await seedCoins(db, [mintN(1)])).get(mintN(1))!;
      const stageRow = () =>
        db
          .selectFrom('coin_stages')
          .selectAll()
          .where('coin_id', '=', coinId)
          .where('stage', '=', 'metrics')
          .executeTakeFirstOrThrow();
      const coinRow = () =>
        db
          .selectFrom('coins')
          .select([
            'ath_market_cap_usd',
            'ath_at',
            'metric_flags',
            'metrics_version',
            'metrics_computed_at',
            'status',
          ])
          .where('id', '=', coinId)
          .executeTakeFirstOrThrow();

      expect((await executeStage(opts(), 'metrics', coinId)).kind).toBe('done');
      const row = await stageRow();
      expect(row).toMatchObject({ status: 'done', last_error: null, attempts: 1 });
      expect(row.version).toBe(METRICS_VERSION);
      const coin = await coinRow();
      expect(coin).toMatchObject({
        ath_market_cap_usd: null,
        ath_at: null,
        metric_flags: ['no_candles'],
        metrics_version: METRICS_VERSION,
        status: 'unknown',
      });

      // A second run finds the stage final: nothing is claimed, nothing is written.
      expect((await executeStage(opts(), 'metrics', coinId)).kind).toBe('final');
      expect(await stageRow()).toEqual(row);
      expect(await coinRow()).toEqual(coin);
    });
  });
});
