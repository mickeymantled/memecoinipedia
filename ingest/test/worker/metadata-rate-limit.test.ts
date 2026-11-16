/**
 * Jupiter that keeps answering HTTP 429 stops the metadata stage the way the unit ceiling stops the
 * candles stage: the stage takes no new coin, the coins of the batch go back to be retried, and no
 * attempt is spent. Real client on a fake always-429 fetch and a fake clock; nothing waits.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createRun, type Database } from '@memecoinipedia/db';
import { createTestDatabase, type TestDatabase } from '@memecoinipedia/db/testing';
import type { Kysely } from 'kysely';
import { JupiterClient } from '../../src/sources/jupiter/index.js';
import { executeStage, type ExecuteOptions } from '../../src/worker/execute.js';
import { StageRegistry } from '../../src/worker/stage.js';
import { discoveredStage } from '../../src/worker/stages/discovered.js';
import { createMetadataLoaders, createMetadataStage } from '../../src/worker/stages/metadata.js';
import { fakeClock } from '../sources/helpers.js';
import { fakeGetFetch } from '../sources/net-helpers.js';
import { adminUrl, asset, describeDb, mintN, seedCoins, testLog } from './helpers.js';

const MINTS = [mintN(1), mintN(2), mintN(3)];

describeDb('metadata stage and Jupiter 429', () => {
  let t: TestDatabase;
  let db: Kysely<Database>;
  let runId: number;
  let ids: number[];

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
    const m = await seedCoins(db, MINTS);
    ids = MINTS.map((x) => m.get(x)!);
  });

  function build(opts: { stopHoldMs?: number; nowMs?: () => number } = {}) {
    const clock = fakeClock();
    let jupiterRequests = 0;
    const f = fakeGetFetch(() => {
      jupiterRequests++;
      return { status: 429 };
    });
    const jupiter = new JupiterClient({
      fetch: f.fetch,
      now: clock.now,
      sleep: clock.sleep,
      http: { sleep: clock.sleep },
    });
    const { assets, prices } = createMetadataLoaders({
      db,
      helius: {
        getAssets: async (ms) => ms.map((x) => asset(x, { uri: `https://example.test/${x}` })),
      },
      jupiter,
      addresses: MINTS,
    });
    const stage = createMetadataStage({
      assets,
      prices,
      ...(opts.stopHoldMs !== undefined ? { stopHoldMs: opts.stopHoldMs } : {}),
      ...(opts.nowMs ? { now: opts.nowMs } : {}),
    });
    const eopts: ExecuteOptions = {
      db,
      registry: new StageRegistry().register(discoveredStage).register(stage),
      now: () => new Date(),
      log: testLog,
      runId,
      staleAfterMs: 60_000,
      maxAttempts: 3,
    };
    return { stage, jupiter, clock, eopts, jupiterRequests: () => jupiterRequests };
  }

  const rows = () =>
    db
      .selectFrom('coin_stages')
      .select(['coin_id', 'status', 'attempts', 'last_error'])
      .where('stage', '=', 'metadata')
      .orderBy('coin_id')
      .execute();

  it('retries the coins of the batch without spending an attempt, and the stage takes no new coin', async () => {
    const h = build();
    const first = await executeStage(h.eopts, 'metadata', ids[0]!);
    expect(first).toMatchObject({ kind: 'retry' });
    expect(h.stage.stopped).toBe(true);
    expect(h.stage.stopReason).toMatch(/kept answering HTTP 429/);
    // One request per pause, five pauses: one batch, not one run of five requests per coin.
    expect(h.jupiterRequests()).toBe(5);
    expect(h.jupiter.pauseStats().pauses).toBe(5);
    // The first coin is back for a retry with its attempt given back.
    const [r1] = await rows();
    expect(r1).toMatchObject({ coin_id: ids[0], attempts: 0 });
    expect(r1!.last_error).toMatch(/^jupiter_rate_limited:/);
    // The next coin is held: no claim, no stage row, no request.
    const second = await executeStage(h.eopts, 'metadata', ids[1]!);
    expect(second).toMatchObject({ kind: 'held' });
    expect(h.jupiterRequests()).toBe(5);
    expect((await rows()).map((r) => r.coin_id)).toEqual([ids[0]]);
  });

  it('lets the stage go on after its hold, when it has one (the live process)', async () => {
    let nowMs = 0;
    const h = build({ stopHoldMs: 60_000, nowMs: () => nowMs });
    await executeStage(h.eopts, 'metadata', ids[0]!);
    expect(h.stage.stopped).toBe(true);
    nowMs = 59_999;
    expect(h.stage.stopped).toBe(true);
    nowMs = 60_000;
    expect(h.stage.stopped).toBe(false);
    expect(await executeStage(h.eopts, 'metadata', ids[1]!)).toMatchObject({ kind: 'retry' });
  });
});
