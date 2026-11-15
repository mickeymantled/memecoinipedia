import { afterAll, beforeAll, expect, it } from 'vitest';
import { createRun, type Database } from '@memecoinipedia/db';
import { createTestDatabase, type TestDatabase } from '@memecoinipedia/db/testing';
import type { Kysely } from 'kysely';
import { executeStage } from '../../src/worker/execute.js';
import { StageRegistry } from '../../src/worker/stage.js';
import { discoveredStage } from '../../src/worker/stages/discovered.js';
import { createMetadataLoaders, createMetadataStage } from '../../src/worker/stages/metadata.js';
import { adminUrl, asset, describeDb, mintN, seedCoins, testLog, token } from './helpers.js';

const COINS = 1000;

describeDb('metadata stage at volume', () => {
  let t: TestDatabase;
  let db: Kysely<Database>;
  beforeAll(async () => {
    t = await createTestDatabase(adminUrl!);
    db = t.db;
  });
  afterAll(async () => {
    await t.drop();
  });

  it('1,000 coins make one Helius request, one Jupiter request per 100 coins, and no gateway request', async () => {
    const mints = Array.from({ length: COINS }, (_, i) => mintN(i + 1));
    const ids = [...(await seedCoins(db, mints)).values()];
    const runId = await createRun(db, { kind: 'test' });
    const calls = { helius: [] as number[], jupiter: [] as number[], gateway: 0 };
    const { assets, prices } = createMetadataLoaders({
      db,
      helius: {
        getAssets: async (m) => {
          calls.helius.push(m.length);
          return m.map((x) => asset(x, { description: 'd', image: 'https://ipfs.io/ipfs/bafy1' }));
        },
      },
      jupiter: {
        getTokens: async (m) => {
          calls.jupiter.push(m.length);
          return m.map((x) => token(x));
        },
      },
    });
    // The stage has no way to reach a gateway: its dependencies are the two loaders only.
    const registry = new StageRegistry()
      .register(discoveredStage)
      .register(createMetadataStage({ assets, prices }));
    const exec = {
      db,
      registry,
      now: () => new Date(),
      log: testLog,
      runId,
      staleAfterMs: 60_000,
      maxAttempts: 3,
    };
    for (const id of ids) {
      expect(await executeStage(exec, 'metadata', id)).toMatchObject({ kind: 'done' });
    }
    expect(calls.helius).toEqual([1000]);
    expect(calls.jupiter).toEqual(Array(10).fill(100));
    expect(calls.gateway).toBe(0);
  }, 120_000);
});
