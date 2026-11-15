import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createRun, type Database } from '@memecoinipedia/db';
import { createTestDatabase, type TestDatabase } from '@memecoinipedia/db/testing';
import type { Kysely } from 'kysely';
import { BudgetExceededError } from '../../src/sources/budget.js';
import type { AssetInfo } from '../../src/sources/helius/client.js';
import type { JupiterToken } from '../../src/sources/jupiter/client.js';
import type { MetadataResult } from '../../src/sources/metadata/fetch.js';
import { executeStage, type ExecuteOptions } from '../../src/worker/execute.js';
import { StageRegistry } from '../../src/worker/stage.js';
import { discoveredStage } from '../../src/worker/stages/discovered.js';
import { createMetadataStage } from '../../src/worker/stages/metadata.js';
import { UsageMeter } from '../../src/worker/usage.js';
import {
  adminUrl,
  asset,
  badResult,
  describeDb,
  mintN,
  okResult,
  seedCoins,
  SPL,
  testLog,
  token,
} from './helpers.js';

const CID = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
const M = mintN(1);

describeDb('metadata stage', () => {
  let t: TestDatabase;
  let db: Kysely<Database>;
  let coinId: number;
  let runId: number;
  const meter = new UsageMeter();

  // What the fakes answer; each test sets what it needs.
  let assetFor: (mint: string) => AssetInfo | Error;
  let priceFor: (mint: string) => JupiterToken | Error;
  let metaFor: (uri: string) => MetadataResult | Error;
  const metaCalls: string[] = [];

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
        fetchMetadata: async (uri) => {
          metaCalls.push(uri);
          const r = metaFor(uri);
          if (r instanceof Error) throw r;
          return r;
        },
        usage: meter,
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
  const run = (maxAttempts?: number) => executeStage(opts(maxAttempts), 'metadata', coinId);
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
    metaCalls.length = 0;
    assetFor = (m) => asset(m, { uri: `https://ipfs.io/ipfs/${CID}` });
    priceFor = (m) => token(m);
    metaFor = () => okResult({ name: 'Json Name', symbol: 'JSYM', description: 'A coin.' });
  });

  describe('ok', () => {
    it('stores identity, description, socials, raw JSON, image reference and price', async () => {
      const json = {
        name: 'Json Name',
        symbol: 'JSYM',
        description: 'A very good coin',
        image: `https://ipfs.io/ipfs/${CID}/pic.png`,
        twitter: 'http://x.com/coin',
        telegram: 'https://t.me/coin',
        website: '@coin_handle',
        showName: true,
      };
      metaFor = () => okResult(json);
      expect(await run()).toMatchObject({ kind: 'done' });

      const c = await coin();
      expect(c).toMatchObject({
        ticker: `T${M.slice(4, 7)}`, // on-chain symbol wins over the JSON one
        name: `Name ${M.slice(0, 6)}`,
        token_program: SPL,
        metadata_uri: `https://ipfs.io/ipfs/${CID}`,
        description: 'A very good coin',
        image_url: `ipfs://${CID}/pic.png`,
        socials: { twitter: 'https://x.com/coin', telegram: 'https://t.me/coin' },
        metadata_raw: json,
        current_price_usd: 0.0002,
        current_liquidity_usd: 1500,
        current_volume_24h_usd: 300,
      });
      expect(c.current_market_cap_usd).toBeCloseTo(0.0002 * 1e9, 3);
      expect(c.current_refreshed_at).not.toBeNull();
      expect(await stage()).toMatchObject({ status: 'done', attempts: 1, last_error: null });

      // The handle was not a full URL: dropped and counted.
      expect(await issues()).toEqual([
        {
          kind: 'social_links_dropped',
          detail: { links: [{ field: 'website', value: '@coin_handle' }] },
        },
      ]);
      expect(metaCalls).toEqual([`https://ipfs.io/ipfs/${CID}`]);
    });

    it('falls back to the JSON name and symbol when the chain has none', async () => {
      assetFor = (m) => asset(m, { name: null, symbol: null });
      await run();
      expect(await coin()).toMatchObject({ ticker: 'JSYM', name: 'Json Name' });
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

    it('counts gateway requests for the run summary', async () => {
      const before = meter.snapshot()['metadata-fetch']?.requests ?? 0;
      await run();
      expect(meter.snapshot()['metadata-fetch']?.requests).toBe(before + 1);
    });
  });

  describe.each([
    ['not_found', 'metadata_not_found'],
    ['invalid', 'metadata_invalid'],
    ['too_large', 'metadata_too_large'],
    ['unsupported_uri', 'metadata_unsupported_uri'],
  ] as const)('outcome %s', (outcome, kind) => {
    it('finishes the stage as done and records the reason as a data issue', async () => {
      metaFor = () =>
        badResult(outcome, outcome === 'unsupported_uri' ? 'scheme ftp is not supported' : null);
      expect(await run()).toMatchObject({ kind: 'done' });
      expect(await stage()).toMatchObject({ status: 'done', last_error: null });
      const found = await issues();
      expect(found.map((i) => i.kind)).toEqual([kind]);
      expect(found[0]?.detail).toMatchObject({ uri: `https://ipfs.io/ipfs/${CID}` });
      // What the chain gave us is kept; nothing from the missing JSON is invented.
      expect(await coin()).toMatchObject({
        ticker: `T${M.slice(4, 7)}`,
        token_program: SPL,
        metadata_uri: `https://ipfs.io/ipfs/${CID}`,
        description: null,
        image_url: null,
        socials: {},
        metadata_raw: null,
        current_price_usd: 0.0002,
      });
    });
  });

  describe('unreachable', () => {
    it('fails the stage as retryable, keeps the chain fields, and a later success clears it', async () => {
      metaFor = () => badResult('unreachable');
      const out = await run();
      expect(out).toMatchObject({ kind: 'retry' });
      expect(await stage()).toMatchObject({ status: 'failed', attempts: 1 });
      expect((await stage()).last_error).toMatch(
        /^metadata_unreachable: ipfs\.filebase\.io timeout/,
      );
      expect(await coin()).toMatchObject({ ticker: `T${M.slice(4, 7)}`, description: null });
      expect(await issues()).toEqual([]);

      metaFor = () => okResult({ description: 'back again' });
      expect(await run()).toMatchObject({ kind: 'done' });
      expect(await stage()).toMatchObject({ status: 'done', attempts: 2, last_error: null });
      expect((await coin()).description).toBe('back again');
    });

    it('is left failed for good once the attempts are used up', async () => {
      metaFor = () => badResult('unreachable');
      expect(await run(2)).toMatchObject({ kind: 'retry' });
      expect(await run(2)).toMatchObject({ kind: 'failed' });
      expect(await stage()).toMatchObject({ status: 'failed', attempts: 2 });
    });
  });

  describe('the chain side', () => {
    it('no asset at Helius: done with an issue, and the price is still stored', async () => {
      assetFor = (m) =>
        asset(m, { found: false, name: null, symbol: null, uri: null, tokenProgramId: null });
      expect(await run()).toMatchObject({ kind: 'done' });
      expect((await issues()).map((i) => i.kind)).toEqual(['asset_not_found']);
      expect(metaCalls).toEqual([]);
      expect(await coin()).toMatchObject({ ticker: null, current_price_usd: 0.0002 });
    });

    it('a malformed asset row: done with an issue that lists the problems', async () => {
      assetFor = (m) => asset(m, { invalid: ['token_info.supply: expected number'] });
      await run();
      const found = await issues();
      expect(found.map((i) => i.kind)).toEqual(['asset_invalid']);
      expect(found[0]?.detail).toMatchObject({ problems: ['token_info.supply: expected number'] });
    });

    it('an asset without a URI: done with an issue, no fetch', async () => {
      assetFor = (m) => asset(m, { uri: null });
      await run();
      expect((await issues()).map((i) => i.kind)).toEqual(['metadata_no_uri']);
      expect(metaCalls).toEqual([]);
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

    it('an exception from the fetcher is a retryable failure', async () => {
      metaFor = () => new Error('boom');
      expect(await run()).toMatchObject({ kind: 'retry' });
      expect((await stage()).last_error).toMatch(/^metadata_error: /);
    });
  });

  describe('idempotence', () => {
    it('a second run replaces the issues instead of adding to them', async () => {
      metaFor = () => badResult('invalid');
      await run();
      // Force it to run again, as a version bump or a manual reset would.
      await db
        .updateTable('coin_stages')
        .set({ status: 'pending' })
        .where('coin_id', '=', coinId)
        .execute();
      await run();
      expect((await issues()).map((i) => i.kind)).toEqual(['metadata_invalid']);
    });

    it('a stage that is done is not run again', async () => {
      await run();
      metaCalls.length = 0;
      expect(await run()).toMatchObject({ kind: 'final' });
      expect(metaCalls).toEqual([]);
      expect((await stage()).attempts).toBe(1);
    });

    it('a finished metadata stage keeps its image as an IPFS reference for each gateway style', async () => {
      const cases: Array<[string, string]> = [
        [`ipfs://${CID}`, `ipfs://${CID}`],
        [`https://gateway.pinata.cloud/ipfs/${CID}`, `ipfs://${CID}`],
        ['https://cdn.example.com/x.png', 'https://cdn.example.com/x.png'],
      ];
      for (const [image, expected] of cases) {
        metaFor = () => okResult({ image });
        await db
          .updateTable('coin_stages')
          .set({ status: 'pending' })
          .where('coin_id', '=', coinId)
          .execute();
        await run();
        expect((await coin()).image_url).toBe(expected);
      }
    });
  });
});

describe('metadata stage without a database', () => {
  it('is registered under the name and version the pipeline expects', () => {
    const stage = createMetadataStage({
      assets: { get: async (m) => asset(m) },
      prices: { get: async (m) => token(m) },
      fetchMetadata: async () => okResult({}),
    });
    expect(stage).toMatchObject({ name: 'metadata', version: 1 });
  });
});
