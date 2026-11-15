import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { getRun, getUsage, type Database, type StageName } from '@memecoinipedia/db';
import { createTestDatabase, type TestDatabase } from '@memecoinipedia/db/testing';
import type { Kysely } from 'kysely';
import { runIngest, type SourceClients } from '../../src/worker/run.js';
import {
  adminUrl,
  asset,
  badResult,
  describeDb,
  mintN,
  okResult,
  schemaExists,
  tableCounts,
  testLog,
  token,
} from './helpers.js';

const HEADER =
  'mint,half_year,cell,probe,cell_size,created_at,creator,graduated_at,hours,peak_max_usd,peak_p999_usd,peak_at';
const csvRow = (mint: string, i: number) =>
  `${mint},2024-H1,100k-1M,true,2,2024-05-${String(10 + i).padStart(2, '0')}T04:58:06Z,${mintN(900)},2024-05-${String(10 + i).padStart(2, '0')}T06:21:58Z,670,934000,${100000 + i},2024-05-21T15:00:00Z`;

describeDb('runIngest', () => {
  let t: TestDatabase;
  let db: Kysely<Database>;
  let dir: string;
  let file: string;
  const N = 8;
  const mints = Array.from({ length: N }, (_, i) => mintN(i + 1));

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ingest-run-'));
    file = join(dir, 'sample.csv');
    await writeFile(
      file,
      [
        HEADER,
        ...mints.map(csvRow),
        csvRow(mints[0]!, 0), // a repeated mint
        'bad-mint,2024-H1,x,true,2,2024-05-10T04:58:06Z,,,1,1,1,2024-05-21T15:00:00Z',
      ].join('\n'),
    );
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    t = await createTestDatabase(adminUrl!);
    db = t.db;
  });
  afterEach(async () => {
    await t.drop();
  });

  /** Fake sources that count every call. */
  const sources = () => {
    const calls = { helius: [] as string[][], jupiter: [] as string[][], fetch: [] as string[] };
    const clients: SourceClients = {
      helius: {
        getAssets: async (m) => {
          calls.helius.push([...m]);
          return m.map((x) => asset(x, { uri: `https://example.test/${x}.json` }));
        },
      },
      jupiter: {
        getTokens: async (m) => {
          calls.jupiter.push([...m]);
          return m.map((x) => token(x));
        },
      },
      fetchMetadata: async (uri) => {
        calls.fetch.push(uri);
        if (uri.includes(mints[3]!)) return badResult('not_found');
        return okResult({
          description: `about ${uri.slice(-20)}`,
          image: 'https://ipfs.io/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG/a.png',
          twitter: uri.includes(mints[4]!) ? '@handle' : 'https://x.com/coin',
        });
      },
      readUsage: () => ({
        helius: { requests: calls.helius.length, units: calls.helius.length * 10 },
        jupiter: { requests: calls.jupiter.length, units: 0 },
      }),
    };
    return { calls, clients };
  };

  const base = (out: string[]) => ({
    samplePath: file,
    // These tests are about the first two stages; the candle stages have their own file.
    stages: ['discovered', 'metadata'] as StageName[],
    env: { DATABASE_URL: t.url },
    log: testLog,
    out: (s: string) => out.push(s),
  });
  const fast = { retryDelaySeconds: 1, monitorIntervalSeconds: 1, pollingIntervalSeconds: 0.5 };

  it('a dry run makes no call and no write, and prints the estimate', async () => {
    const { calls, clients } = sources();
    const before = await tableCounts(db);
    const out: string[] = [];
    const report = await runIngest({
      ...base(out),
      confirm: false,
      db,
      clients,
      maxHeliusCredits: 300,
    });

    expect(report.status).toBe('dry_run');
    expect(report.ranWork).toBe(false);
    expect(calls).toEqual({ helius: [], jupiter: [], fetch: [] });
    expect(await tableCounts(db)).toEqual(before);
    expect(await schemaExists(db, 'pgboss')).toBe(false); // not even the queue's tables
    const text = out.join('\n');
    expect(text).toContain(`${N} valid coins`);
    expect(text).toContain('1 rows rejected');
    expect(text).toContain('1 repeated mints');
    expect(text).toContain('helius: 1 requests, 10 credits (ceiling 300)');
    expect(text).toContain('jupiter: 1 requests');
    expect(text).toContain('Dry run');
  });

  it('a dry run needs no database at all', async () => {
    const out: string[] = [];
    const report = await runIngest({ ...base(out), env: {}, confirm: false });
    expect(report.status).toBe('dry_run');
    expect(report.plan.database).toBeNull();
    expect(report.plan.stageWork).toEqual({ discovered: N, metadata: N });
  });

  it('runs seed and metadata with one Helius request for all coins, then a second run does nothing', async () => {
    const { calls, clients } = sources();
    const out: string[] = [];
    const report = await runIngest({
      ...base(out),
      confirm: true,
      db,
      clients,
      concurrency: 3,
      worker: fast,
    });

    expect(report.status).toBe('done');
    expect(report.ranWork).toBe(true);
    // Batching: one request each for all eight coins, not one per coin.
    expect(calls.helius).toHaveLength(1);
    expect(calls.helius[0]).toHaveLength(N);
    expect(calls.jupiter).toHaveLength(1);
    expect(calls.fetch).toHaveLength(N);

    const stagesOf = (stage: string, status: string) =>
      report.summary!.stages.find((s) => s.stage === stage && s.status === status)?.coins ?? 0;
    expect(stagesOf('discovered', 'done')).toBe(N);
    expect(stagesOf('metadata', 'done')).toBe(N);
    expect(report.summary!.failures).toEqual([]);
    expect(report.summary!.metadata).toMatchObject({
      coins: N,
      withDescription: N - 1, // the not_found coin has none
      withImageReference: N - 1,
      withSocialLink: N - 2, // not_found has none, and one coin's only link was a handle
      socialLinksDropped: 1,
      coinsWithDroppedLinks: 1,
    });
    expect(report.summary!.issues.map((i) => i.kind)).toEqual([
      'metadata_not_found',
      'social_links_dropped',
    ]);

    // The run, its estimate and its usage are recorded.
    const run = await getRun(db, report.runId!);
    expect(run).toMatchObject({
      status: 'done',
      estimate: { helius: { requests: 1, credits: 10 } },
    });
    expect(await getUsage(db, report.runId!)).toEqual([
      { provider: 'helius', requests: 1, units: 10 },
      { provider: 'jupiter', requests: 1, units: 0 },
      { provider: 'metadata-fetch', requests: N + 1, units: 0 }, // the not_found coin asked two gateways
    ]);
    expect(out.join('\n')).toContain('Estimate against actual');

    // A second run: nothing queued, nothing called, nothing written, and it says so.
    const before = await tableCounts(db);
    const second = sources();
    const out2: string[] = [];
    const again = await runIngest({
      ...base(out2),
      confirm: true,
      db,
      clients: second.clients,
      worker: fast,
    });
    expect(again.status).toBe('nothing_to_do');
    expect(again.ranWork).toBe(false);
    expect(out2.join('\n')).toContain('Nothing to do');
    expect(second.calls).toEqual({ helius: [], jupiter: [], fetch: [] });
    expect(await tableCounts(db)).toEqual(before);
  }, 60_000);

  it('leaves coins that used up their retries on a re-run, and retries them with --retry-failed', async () => {
    const flaky = sources();
    let down = true;
    const original = flaky.clients.fetchMetadata;
    flaky.clients.fetchMetadata = async (uri) =>
      down && uri.includes(mints[2]!) ? badResult('unreachable') : original(uri);
    const out: string[] = [];
    const first = await runIngest({
      ...base(out),
      confirm: true,
      db,
      clients: flaky.clients,
      maxAttempts: 2,
      worker: fast,
    });
    expect(first.summary!.failures).toEqual([
      { stage: 'metadata', status: 'failed', reason: 'metadata_unreachable', coins: 1 },
    ]);
    const attemptsOf = async () =>
      (
        await db
          .selectFrom('coin_stages')
          .select('attempts')
          .where('stage', '=', 'metadata')
          .where('status', '=', 'failed')
          .execute()
      ).map((r) => r.attempts);
    expect(await attemptsOf()).toEqual([2]);

    // Same run again: the failed coin has used its two attempts, so there is nothing to do.
    const before = await tableCounts(db);
    down = false;
    const again = await runIngest({
      ...base([]),
      confirm: true,
      db,
      clients: flaky.clients,
      maxAttempts: 2,
      worker: fast,
    });
    expect(again.status).toBe('nothing_to_do');
    expect(await tableCounts(db)).toEqual(before);

    // With --retry-failed it gets a fresh set, and now it works.
    const out3: string[] = [];
    const retried = await runIngest({
      ...base(out3),
      confirm: true,
      db,
      clients: flaky.clients,
      maxAttempts: 2,
      retryFailed: true,
      worker: fast,
    });
    expect(retried.status).toBe('done');
    expect(retried.plan.stageWork['metadata']).toBe(1);
    expect(retried.summary!.failures).toEqual([]);
    expect(
      retried.summary!.stages.find((s) => s.stage === 'metadata' && s.status === 'done')?.coins,
    ).toBe(N);
  }, 60_000);

  it('seeding is limited to the stages asked for', async () => {
    const out: string[] = [];
    const { clients } = sources();
    const report = await runIngest({
      ...base(out),
      confirm: true,
      db,
      clients,
      stages: ['discovered'],
      worker: fast,
    });
    expect(report.status).toBe('done');
    expect((await tableCounts(db))['coins']).toBe(N);
    const stages = await db.selectFrom('coin_stages').select('stage').distinct().execute();
    expect(stages).toEqual([{ stage: 'discovered' }]);
  }, 60_000);

  it('refuses a stage this build does not have', async () => {
    const out: string[] = [];
    await expect(
      runIngest({
        ...base(out),
        confirm: false,
        db,
        stages: ['discovered', 'classified'],
      }),
    ).rejects.toThrow(/not available in this build/);
  });
});
