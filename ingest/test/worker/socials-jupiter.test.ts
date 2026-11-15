/**
 * Social links from Jupiter's token answer (issue #89): the metadata stage stores them for coins
 * whose own metadata file has not been read, the file replaces them when it arrives, and a coin
 * whose file is done keeps what the file gave, also when that is nothing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createRun, type Database } from '@memecoinipedia/db';
import { createTestDatabase, type TestDatabase } from '@memecoinipedia/db/testing';
import { sql, type Kysely } from 'kysely';
import type { JupiterToken } from '../../src/sources/jupiter/client.js';
import { executeStage, type ExecuteOptions } from '../../src/worker/execute.js';
import { StageRegistry } from '../../src/worker/stage.js';
import { discoveredStage } from '../../src/worker/stages/discovered.js';
import {
  METADATA_STAGE_VERSION,
  createMetadataLoaders,
  createMetadataStage,
} from '../../src/worker/stages/metadata.js';
import { createMetadataFileStage } from '../../src/worker/stages/metadataFile.js';
import { decideSocials } from '../../src/worker/stages/socials.js';
import {
  adminUrl,
  asset,
  describeDb,
  mintN,
  okResult,
  seedCoins,
  testLog,
  token,
} from './helpers.js';

const CID = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
const M = mintN(1);
const JUP = {
  website: 'https://jup.example/coin',
  twitter: 'https://x.com/jup_coin',
  telegram: 'https://t.me/jup_coin',
};
const FILE = { website: 'https://file.example/', twitter: 'https://x.com/file_coin' };

describe('decideSocials', () => {
  const base = { fileStageDone: false, currentSource: null } as const;
  it('stores Jupiter links for a coin whose file is not done, cleaned, with what was dropped', () => {
    const d = decideSocials({
      ...base,
      from: 'jupiter',
      links: { website: 'http://a.example/x', twitter: '@handle', telegram: null },
    });
    expect(d).toEqual({
      socials: { website: 'https://a.example/x' },
      source: 'jupiter',
      dropped: [{ field: 'twitter', value: '@handle' }],
    });
  });
  it('leaves a coin with a finished file alone', () => {
    expect(decideSocials({ ...base, from: 'jupiter', links: JUP, fileStageDone: true })).toBeNull();
  });
  it('does nothing when Jupiter gave no row', () => {
    expect(decideSocials({ ...base, from: 'jupiter', links: null })).toBeNull();
  });
  it('lets the file replace, also with nothing; a second empty file does not wipe links the file gave', () => {
    expect(
      decideSocials({ ...base, from: 'metadata_file', links: {}, currentSource: 'jupiter' }),
    ).toEqual({ socials: {}, source: 'metadata_file', dropped: [] });
    expect(
      decideSocials({ ...base, from: 'metadata_file', links: null, currentSource: 'jupiter' }),
    ).toEqual({ socials: {}, source: 'metadata_file', dropped: [] });
    expect(
      decideSocials({
        ...base,
        from: 'metadata_file',
        links: null,
        currentSource: 'metadata_file',
      }),
    ).toBeNull();
  });
});

describeDb('social links from Jupiter', () => {
  let t: TestDatabase;
  let db: Kysely<Database>;
  let coinId: number;
  let runId: number;
  let jupiterFor: (mint: string) => JupiterToken;
  let fileJson: Record<string, unknown>;

  const opts = (): ExecuteOptions => ({
    db,
    registry: new StageRegistry()
      .register(discoveredStage)
      .register(
        createMetadataStage({
          assets: {
            get: async (m) =>
              asset(m, { uri: `https://ipfs.io/ipfs/${CID}`, description: 'From Helius' }),
          },
          prices: { get: async (m) => jupiterFor(m) },
        }),
      )
      .register(
        createMetadataFileStage({
          fetchMetadata: async () => okResult(fileJson),
        }),
      ),
    now: () => new Date(),
    log: testLog,
    runId,
    staleAfterMs: 60_000,
    maxAttempts: 3,
  });
  const runMeta = () => executeStage(opts(), 'metadata', coinId);
  const runFile = () => executeStage(opts(), 'metadata_file', coinId);
  const coin = () =>
    db
      .selectFrom('coins')
      .select(['socials', 'socials_source', 'description'])
      .where('id', '=', coinId)
      .executeTakeFirstOrThrow();
  const issues = async () =>
    (
      await db
        .selectFrom('data_issues')
        .select(['kind', 'detail'])
        .where('coin_id', '=', coinId)
        .orderBy('kind')
        .execute()
    ).filter((r) => r.kind === 'social_links_dropped');
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
    jupiterFor = (m) => token(m, JUP);
    fileJson = { ...FILE, description: 'From the file' };
  });

  it('a coin with no file gets Jupiter links, source jupiter', async () => {
    expect(await runMeta()).toMatchObject({ kind: 'done' });
    expect(await coin()).toMatchObject({ socials: JUP, socials_source: 'jupiter' });
    expect(await issues()).toEqual([]);
  });

  it('a coin with the file done and links is unchanged by a rerun', async () => {
    await runMeta();
    expect(await runFile()).toMatchObject({ kind: 'done' });
    const before = await coin();
    expect(before).toMatchObject({ socials: FILE, socials_source: 'metadata_file' });
    await rerun();
    await runMeta();
    expect(await coin()).toMatchObject({ socials: FILE, socials_source: 'metadata_file' });
  });

  it('a coin with the file done and no links still has none, whatever Jupiter says', async () => {
    fileJson = { description: 'No links here' };
    await runMeta();
    await runFile();
    expect(await coin()).toMatchObject({ socials: {}, socials_source: 'metadata_file' });
    await rerun();
    await runMeta();
    expect(await coin()).toMatchObject({ socials: {}, socials_source: 'metadata_file' });
  });

  it('the file arriving after Jupiter replaces the links', async () => {
    await runMeta();
    expect(await coin()).toMatchObject({ socials: JUP, socials_source: 'jupiter' });
    await runFile();
    expect(await coin()).toMatchObject({ socials: FILE, socials_source: 'metadata_file' });
  });

  it('a file with no links replaces Jupiter links with none', async () => {
    await runMeta();
    fileJson = { description: 'No links here' };
    await runFile();
    expect(await coin()).toMatchObject({ socials: {}, socials_source: 'metadata_file' });
  });

  it('a bad link from Jupiter is dropped and recorded like a bad link from a file; the file stage replaces the record', async () => {
    jupiterFor = (m) =>
      token(m, { website: 'not a link', twitter: 'https://x.com/ok', telegram: null });
    await runMeta();
    expect(await coin()).toMatchObject({
      socials: { twitter: 'https://x.com/ok' },
      socials_source: 'jupiter',
    });
    expect(await issues()).toEqual([
      {
        kind: 'social_links_dropped',
        detail: { links: [{ field: 'website', value: 'not a link' }], source: 'jupiter' },
      },
    ]);
    // A rerun with clean links clears the record.
    jupiterFor = (m) => token(m, JUP);
    await rerun();
    await runMeta();
    expect(await issues()).toEqual([]);
    // A coin Jupiter does not know is left as it is.
    jupiterFor = (m) => token(m, { found: false, priceUsd: null });
    await rerun();
    await runMeta();
    expect(await coin()).toMatchObject({ socials: JUP, socials_source: 'jupiter' });
  });

  it('a Jupiter row without links stores none with source jupiter', async () => {
    jupiterFor = (m) => token(m);
    await runMeta();
    expect(await coin()).toMatchObject({ socials: {}, socials_source: 'jupiter' });
  });

  it('the rerun of a coin already done asks Jupiter once per 100 coins and Helius once per 1,000, and no gateway', async () => {
    await db.deleteFrom('coins').execute();
    const mints = Array.from({ length: 120 }, (_, i) => mintN(100 + i));
    const ids = [...(await seedCoins(db, mints)).values()];
    // Every coin finished the metadata stage at the version before this change.
    await db
      .insertInto('coin_stages')
      .values(
        ids.map((id) => ({
          coin_id: id,
          stage: 'metadata' as const,
          status: 'done' as const,
          version: METADATA_STAGE_VERSION - 1,
        })),
      )
      .execute();
    const jupiterCalls: number[] = [];
    const heliusCalls: number[] = [];
    const { assets, prices } = createMetadataLoaders({
      db,
      helius: {
        getAssets: async (ms) => {
          heliusCalls.push(ms.length);
          return ms.map((x) => asset(x, { uri: `https://ipfs.io/ipfs/${CID}` }));
        },
      },
      jupiter: {
        getTokens: async (ms) => {
          jupiterCalls.push(ms.length);
          return ms.map((x) => token(x, JUP));
        },
      },
      addresses: mints,
    });
    const o: ExecuteOptions = {
      ...opts(),
      registry: new StageRegistry()
        .register(discoveredStage)
        .register(createMetadataStage({ assets, prices })),
    };
    for (const id of ids)
      expect(await executeStage(o, 'metadata', id)).toMatchObject({ kind: 'done' });
    expect(jupiterCalls).toEqual([100, 20]);
    expect(heliusCalls).toEqual([120]);
    const n = await sql<{ n: string }>`select count(*)::text as n from coins
      where socials_source = 'jupiter' and address = any(${mints})`.execute(db);
    expect(n.rows[0]!.n).toBe('120');
  });
});
