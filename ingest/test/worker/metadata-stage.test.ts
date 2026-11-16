import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createRun, type Database } from '@memecoinipedia/db';
import { createTestDatabase, type TestDatabase } from '@memecoinipedia/db/testing';
import type { Kysely } from 'kysely';
import { BudgetExceededError } from '../../src/sources/budget.js';
import type { AssetInfo } from '../../src/sources/helius/client.js';
import type { JupiterToken } from '../../src/sources/jupiter/client.js';
import { executeStage, type ExecuteOptions } from '../../src/worker/execute.js';
import { StageRegistry } from '../../src/worker/stage.js';
import { discoveredStage } from '../../src/worker/stages/discovered.js';
import { createMetadataStage } from '../../src/worker/stages/metadata.js';
import { adminUrl, asset, describeDb, mintN, seedCoins, SPL, testLog, token } from './helpers.js';

const CID = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
const M = mintN(1);

describeDb('metadata stage', () => {
  let t: TestDatabase;
  let db: Kysely<Database>;
  let coinId: number;
  let runId: number;

  // What the fakes answer; each test sets what it needs.
  let assetFor: (mint: string) => AssetInfo | Error;
  let priceFor: (mint: string) => JupiterToken | Error;

  const registry = () =>
    new StageRegistry().register(discoveredStage).register(
      createMetadataStage({
        assets: {
          get: async (m) => {
            const a = assetFor(m);
            if (a instanceof Error) throw a;
            return a;
          },
        },
        prices: {
          get: async (m) => {
            const p = priceFor(m);
            if (p instanceof Error) throw p;
            return p;
          },
        },
      }),
    );

  const opts = (maxAttempts = 3): ExecuteOptions => ({
    db,
    registry: registry(),
    now: () => new Date(),
    log: testLog,
    runId,
    staleAfterMs: 60_000,
    maxAttempts,
  });
  const run = () => executeStage(opts(), 'metadata', coinId);
  const coin = () =>
    db.selectFrom('coins').selectAll().where('id', '=', coinId).executeTakeFirstOrThrow();
  const stage = () =>
    db
      .selectFrom('coin_stages')
      .selectAll()
      .where('coin_id', '=', coinId)
      .where('stage', '=', 'metadata')
      .executeTakeFirstOrThrow();
  const issues = async () =>
    (
      await db
        .selectFrom('data_issues')
        .select(['kind', 'detail'])
        .where('coin_id', '=', coinId)
        .orderBy('kind')
        .execute()
    ).map((r) => ({ kind: r.kind, detail: r.detail as Record<string, unknown> | null }));
  /** Marks the metadata_file stage as it would be after the file stage ran. */
  const fileStage = (status: 'done' | 'skipped' | 'failed') =>
    db
      .insertInto('coin_stages')
      .values({ coin_id: coinId, stage: 'metadata_file', status })
      .onConflict((oc) => oc.columns(['coin_id', 'stage']).doUpdateSet({ status }))
      .execute();
  const rerun = () =>
    db
      .updateTable('coin_stages')
      .set({ status: 'pending' })
      .where('coin_id', '=', coinId)
      .where('stage', '=', 'metadata')
      .execute();

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
    coinId = (await seedCoins(db, [M])).get(M)!;
    assetFor = (m) =>
      asset(m, {
        uri: `https://ipfs.io/ipfs/${CID}`,
        description: 'From Helius',
        image: `https://ipfs.io/ipfs/${CID}/pic.png`,
      });
    priceFor = (m) => token(m);
  });

  describe('ok', () => {
    it('stores identity, URI, description, image reference and price, and makes no file request', async () => {
      expect(await run()).toMatchObject({ kind: 'done' });
      const c = await coin();
      expect(c).toMatchObject({
        ticker: `T${M.slice(4, 7)}`,
        name: `Name ${M.slice(0, 6)}`,
        token_program: SPL,
        metadata_uri: `https://ipfs.io/ipfs/${CID}`,
        description: 'From Helius',
        image_url: `ipfs://${CID}/pic.png`,
        socials: {},
        metadata_raw: null,
        current_price_usd: 0.0002,
        current_liquidity_usd: 1500,
        current_volume_24h_usd: 300,
      });
      expect(c.current_market_cap_usd).toBeCloseTo(0.0002 * 1e9, 3);
      expect(c.current_refreshed_at).not.toBeNull();
      expect(await stage()).toMatchObject({
        status: 'done',
        attempts: 1,
        version: 2,
        last_error: null,
      });
      expect(await issues()).toEqual([]);
    });

    it('stores text as written: NUL removed, blank becomes null, whitespace kept', async () => {
      assetFor = (m) => asset(m, { description: '  hello\u0000 world \n', image: null });
      await run();
      expect((await coin()).description).toBe('  hello world \n');
      await rerun();
      assetFor = (m) => asset(m, { description: '   \n', image: null });
      await run();
      expect(await coin()).toMatchObject({ description: null, image_url: null });
    });

    it('keeps an image as an IPFS reference for each gateway style', async () => {
      const cases: Array<[string, string]> = [
        [`ipfs://${CID}`, `ipfs://${CID}`],
        [`https://gateway.pinata.cloud/ipfs/${CID}`, `ipfs://${CID}`],
        ['https://cdn.example.com/x.png', 'https://cdn.example.com/x.png'],
      ];
      for (const [image, expected] of cases) {
        assetFor = (m) => asset(m, { image });
        await rerun();
        await run();
        expect((await coin()).image_url).toBe(expected);
      }
    });

    it('keeps an unpriced coin without a price', async () => {
      priceFor = (m) => token(m, { priceUsd: null, liquidityUsd: null, volume24hUsd: null });
      await run();
      expect(await coin()).toMatchObject({ current_price_usd: null, current_market_cap_usd: null });
      expect(await stage()).toMatchObject({ status: 'done' });
    });

    it('leaves the price alone when Jupiter does not know the coin', async () => {
      priceFor = (m) => token(m, { found: false, priceUsd: null });
      await run();
      expect((await coin()).current_refreshed_at).toBeNull();
      expect(await stage()).toMatchObject({ status: 'done' });
    });
  });

  describe('precedence of the file over Helius', () => {
    const fileWrote = () =>
      db
        .updateTable('coins')
        .set({ description: 'From the file', image_url: 'ipfs://bafyfile/pic.png' })
        .where('id', '=', coinId)
        .execute();

    it('a re-run after metadata_file is done does not put the Helius description and image back', async () => {
      await run();
      await fileWrote();
      await fileStage('done');
      await rerun();
      assetFor = (m) =>
        asset(m, {
          uri: `https://ipfs.io/ipfs/${CID}`,
          description: 'Helius changed its mind',
          image: 'https://cdn.example.com/other.png',
          name: 'New Name',
        });
      expect(await run()).toMatchObject({ kind: 'done' });
      // The file's two fields stand; everything else is refreshed.
      expect(await coin()).toMatchObject({
        description: 'From the file',
        image_url: 'ipfs://bafyfile/pic.png',
        name: 'New Name',
        current_price_usd: 0.0002,
      });
    });

    it('while metadata_file is not done (pending, failed or skipped), a re-run refreshes them', async () => {
      for (const status of ['failed', 'skipped'] as const) {
        await run();
        await fileStage(status);
        await rerun();
        assetFor = (m) => asset(m, { description: `Helius ${status}`, image: null });
        await run();
        expect(await coin()).toMatchObject({ description: `Helius ${status}`, image_url: null });
      }
    });
  });

  describe('the chain side', () => {
    it('no asset at Helius: done with an issue, the price is still stored, text is left alone', async () => {
      await db.updateTable('coins').set({ description: 'kept' }).where('id', '=', coinId).execute();
      assetFor = (m) =>
        asset(m, { found: false, name: null, symbol: null, uri: null, tokenProgramId: null });
      expect(await run()).toMatchObject({ kind: 'done' });
      expect((await issues()).map((i) => i.kind)).toEqual(['asset_not_found']);
      expect(await coin()).toMatchObject({
        ticker: null,
        description: 'kept',
        current_price_usd: 0.0002,
      });
    });

    it('a malformed asset row: done with an issue that lists the problems', async () => {
      assetFor = (m) => asset(m, { invalid: ['token_info.supply: expected number'] });
      await run();
      const found = await issues();
      expect(found.map((i) => i.kind)).toEqual(['asset_invalid']);
      expect(found[0]?.detail).toMatchObject({ problems: ['token_info.supply: expected number'] });
    });

    it('an asset without a URI: done with an issue', async () => {
      assetFor = (m) => asset(m, { uri: null });
      await run();
      expect((await issues()).map((i) => i.kind)).toEqual(['metadata_no_uri']);
      expect(await coin()).toMatchObject({ ticker: `T${M.slice(4, 7)}`, metadata_uri: null });
    });

    it('Helius failing is a retryable failure', async () => {
      assetFor = () => new Error('Helius getAssetBatch error 429: slow down');
      expect(await run()).toMatchObject({ kind: 'retry' });
      expect((await stage()).last_error).toMatch(/^helius_error: /);
    });

    it('a spent Helius budget is a failure that is not retried', async () => {
      assetFor = () => new BudgetExceededError('helius', 300, 10, 300);
      expect(await run()).toMatchObject({ kind: 'failed' });
      expect((await stage()).last_error).toMatch(/^budget_exceeded: /);
    });

    it('Jupiter failing is a retryable failure', async () => {
      priceFor = () => new Error('connection reset');
      expect(await run()).toMatchObject({ kind: 'retry' });
      expect((await stage()).last_error).toMatch(/^price_error: /);
    });
  });

  describe('idempotence', () => {
    it('a second run replaces the issues instead of adding to them', async () => {
      assetFor = (m) => asset(m, { uri: null });
      await run();
      await rerun();
      await run();
      expect((await issues()).map((i) => i.kind)).toEqual(['metadata_no_uri']);
    });

    it('does not remove the issues the file stage owns', async () => {
      await db
        .insertInto('data_issues')
        .values({ coin_id: coinId, kind: 'metadata_not_found', detail: null })
        .execute();
      await run();
      expect((await issues()).map((i) => i.kind)).toEqual(['metadata_not_found']);
    });

    it('a stage that is done is not run again', async () => {
      await run();
      expect(await run()).toMatchObject({ kind: 'final' });
      expect((await stage()).attempts).toBe(1);
    });
  });
});

describe('metadata stage without a database', () => {
  it('is registered under the name and version the pipeline expects', () => {
    const stage = createMetadataStage({
      assets: { get: async (m) => asset(m) },
      prices: { get: async (m) => token(m) },
    });
    expect(stage).toMatchObject({ name: 'metadata', version: 2 });
  });
});
