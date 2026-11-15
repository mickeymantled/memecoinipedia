import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createRun, type Database } from '@memecoinipedia/db';
import { createTestDatabase, type TestDatabase } from '@memecoinipedia/db/testing';
import type { Kysely } from 'kysely';
import type { MetadataResult } from '../../src/sources/metadata/fetch.js';
import { executeStage, type ExecuteOptions } from '../../src/worker/execute.js';
import { StageRegistry } from '../../src/worker/stage.js';
import { createMetadataFileStage } from '../../src/worker/stages/metadataFile.js';
import { UsageMeter } from '../../src/worker/usage.js';
import { adminUrl, badResult, describeDb, mintN, okResult, seedCoins, testLog } from './helpers.js';

const CID = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
const URI = `https://ipfs.io/ipfs/${CID}`;
const M = mintN(1);

describeDb('metadata_file stage', () => {
  let t: TestDatabase;
  let db: Kysely<Database>;
  let coinId: number;
  let runId: number;
  const meter = new UsageMeter();
  let metaFor: (uri: string) => MetadataResult | Error;
  const calls: string[] = [];

  const opts = (maxAttempts = 3): ExecuteOptions => ({
    db,
    registry: new StageRegistry().register(
      createMetadataFileStage({
        fetchMetadata: async (uri) => {
          calls.push(uri);
          const r = metaFor(uri);
          if (r instanceof Error) throw r;
          return r;
        },
        usage: meter,
      }),
    ),
    now: () => new Date(),
    log: testLog,
    runId,
    staleAfterMs: 60_000,
    maxAttempts,
  });
  const run = (maxAttempts?: number) => executeStage(opts(maxAttempts), 'metadata_file', coinId);
  const coin = () =>
    db.selectFrom('coins').selectAll().where('id', '=', coinId).executeTakeFirstOrThrow();
  const stage = () =>
    db
      .selectFrom('coin_stages')
      .selectAll()
      .where('coin_id', '=', coinId)
      .where('stage', '=', 'metadata_file')
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
  /** The coin as the `metadata` stage leaves it: URI, ticker, name and what Helius had. */
  const afterMetadata = (extra: Record<string, unknown> = {}) =>
    db
      .updateTable('coins')
      .set({
        ticker: 'TKR',
        name: 'Chain Name',
        metadata_uri: URI,
        description: 'From Helius',
        image_url: `ipfs://${CID}/helius.png`,
        ...extra,
      } as never)
      .where('id', '=', coinId)
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
    calls.length = 0;
    await afterMetadata();
    metaFor = () => okResult({ description: 'From the file' });
  });

  it('stores the raw JSON and the social links, and the file replaces the Helius description and image', async () => {
    const json = {
      name: 'Json Name',
      symbol: 'JSYM',
      description: 'A very good coin',
      image: `https://ipfs.io/ipfs/${CID}/pic.png`,
      twitter: 'http://x.com/coin',
      telegram: 'https://t.me/coin',
      website: '@coin_handle',
    };
    metaFor = () => okResult(json);
    expect(await run()).toMatchObject({ kind: 'done' });
    expect(await coin()).toMatchObject({
      ticker: 'TKR', // the chain's name and symbol win
      name: 'Chain Name',
      description: 'A very good coin',
      image_url: `ipfs://${CID}/pic.png`,
      socials: { twitter: 'https://x.com/coin', telegram: 'https://t.me/coin' },
      metadata_raw: json,
    });
    expect(await stage()).toMatchObject({ status: 'done', version: 1, last_error: null });
    expect(await issues()).toEqual([
      {
        kind: 'social_links_dropped',
        detail: { links: [{ field: 'website', value: '@coin_handle' }], source: 'metadata_file' },
      },
    ]);
    expect(calls).toEqual([URI]);
  });

  it('a coin whose Helius asset had no description gets one from the file', async () => {
    await afterMetadata({ description: null, image_url: null });
    metaFor = () => okResult({ description: 'Only in the file', image: `ipfs://${CID}` });
    await run();
    expect(await coin()).toMatchObject({
      description: 'Only in the file',
      image_url: `ipfs://${CID}`,
    });
  });

  it('where the file has no description or image, the Helius values stay', async () => {
    metaFor = () => okResult({ name: 'x', description: '   ' });
    await run();
    expect(await coin()).toMatchObject({
      description: 'From Helius',
      image_url: `ipfs://${CID}/helius.png`,
    });
  });

  it('falls back to the file name and symbol when the chain has none', async () => {
    await afterMetadata({ ticker: null, name: null });
    metaFor = () => okResult({ name: 'Json Name', symbol: 'JSYM' });
    await run();
    expect(await coin()).toMatchObject({ ticker: 'JSYM', name: 'Json Name' });
  });

  it('counts gateway requests for the run summary', async () => {
    const before = meter.snapshot()['metadata-fetch']?.requests ?? 0;
    await run();
    expect(meter.snapshot()['metadata-fetch']?.requests).toBe(before + 1);
  });

  describe.each([
    ['not_found', 'metadata_not_found'],
    ['invalid', 'metadata_invalid'],
    ['too_large', 'metadata_too_large'],
    ['unsupported_uri', 'metadata_unsupported_uri'],
  ] as const)('outcome %s', (outcome, kind) => {
    it('finishes done with a data issue and keeps the Helius values', async () => {
      metaFor = () =>
        badResult(outcome, outcome === 'unsupported_uri' ? 'scheme ftp is not supported' : null);
      expect(await run()).toMatchObject({ kind: 'done' });
      const found = await issues();
      expect(found.map((i) => i.kind)).toEqual([kind]);
      expect(found[0]?.detail).toMatchObject({ uri: URI });
      expect(await coin()).toMatchObject({
        description: 'From Helius',
        image_url: `ipfs://${CID}/helius.png`,
        metadata_raw: null,
      });
    });
  });

  describe('unreachable', () => {
    it('fails as retryable, keeps the Helius description, and a later success replaces it', async () => {
      metaFor = () => badResult('unreachable');
      expect(await run()).toMatchObject({ kind: 'retry' });
      expect(await stage()).toMatchObject({ status: 'failed', attempts: 1 });
      expect((await stage()).last_error).toMatch(
        /^metadata_unreachable: ipfs\.filebase\.io timeout/,
      );
      expect(await coin()).toMatchObject({ description: 'From Helius', metadata_raw: null });
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

    it('an exception from the fetcher is a retryable failure', async () => {
      metaFor = () => new Error('boom');
      expect(await run()).toMatchObject({ kind: 'retry' });
      expect((await stage()).last_error).toMatch(/^metadata_error: /);
    });
  });

  it('a coin with no metadata URI skips the stage, and nothing is fetched', async () => {
    await afterMetadata({ metadata_uri: null });
    expect(await run()).toMatchObject({ kind: 'skipped' });
    expect(await stage()).toMatchObject({ status: 'skipped', last_error: 'no_metadata_uri' });
    expect(calls).toEqual([]);
    expect(await coin()).toMatchObject({ description: 'From Helius' });
  });

  it('a second run replaces the file issues instead of adding to them', async () => {
    metaFor = () => badResult('invalid');
    await run();
    await db
      .updateTable('coin_stages')
      .set({ status: 'pending' })
      .where('coin_id', '=', coinId)
      .execute();
    await run();
    expect((await issues()).map((i) => i.kind)).toEqual(['metadata_invalid']);
  });
});

describe('metadata_file stage without a database', () => {
  it('is registered under the name and version the pipeline expects', () => {
    const stage = createMetadataFileStage({ fetchMetadata: async () => okResult({}) });
    expect(stage).toMatchObject({ name: 'metadata_file', version: 1 });
  });
});
