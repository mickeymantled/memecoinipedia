/**
 * metadata_file coins in flight (issue 90): its own default and option, the dry run says the
 * figure, a gateway double that slows down as requests pile up, and the once-a-run attempt rule.
 * Gateway doubles only: no request leaves the process.
 */
import { createRun, type Database } from '@memecoinipedia/db';
import { createTestDatabase, type TestDatabase } from '@memecoinipedia/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { DEFAULT_METADATA_FILE_CONCURRENCY } from '../../src/backfill/defaults.js';
import { runBackfill, type BackfillOptions } from '../../src/backfill/run.js';
import type { MetadataResult } from '../../src/sources/metadata/fetch.js';
import { executeStage } from '../../src/worker/execute.js';
import { StageRegistry } from '../../src/worker/stage.js';
import { createMetadataFileStage } from '../../src/worker/stages/metadataFile.js';
import type { SourceClients } from '../../src/worker/run.js';
import { asset, badResult, mintN, okResult, seedCoins, token } from '../worker/helpers.js';
import { adminUrl as workerAdminUrl, describeDb as describeWorkerDb } from '../worker/helpers.js';
import { describeDb, seededDatabase, testClients, testLog, type Fixture } from './helpers.js';

const ROWS = 300;
/** The double's gateway: answers well up to this many requests open at once, then times out. */
const GATEWAY_OK_UP_TO = 6;

/** A gateway that gets slower as requests pile up, and times out past `GATEWAY_OK_UP_TO` open. */
function slowingGateway() {
  const state = { open: 0, peak: 0, calls: 0, timeouts: 0 };
  const fetchMetadata = async (): Promise<MetadataResult> => {
    state.calls++;
    state.open++;
    state.peak = Math.max(state.peak, state.open);
    const crowded = state.open > GATEWAY_OK_UP_TO;
    await new Promise((r) => setTimeout(r, 5 + state.open * 4));
    state.open--;
    if (crowded) {
      state.timeouts++;
      return badResult('unreachable');
    }
    return okResult({ description: 'from the file' });
  };
  return { state, fetchMetadata };
}

describeDb('backfill: metadata_file coins in flight', () => {
  let f: Fixture;
  const opts = (over: Partial<BackfillOptions>): BackfillOptions => ({
    selection: {
      chain: 'solana',
      minRoughPeakUsd: 30_000,
      includeNoPrice: false,
      order: 'hash',
      limit: null,
    },
    codexRps: 10_000,
    maxCodexUnits: 10_000_000,
    maxHeliusCredits: 1_000_000,
    confirm: true,
    env: { DATABASE_URL: f.t.url },
    log: testLog,
    out: () => undefined,
    db: f.t.db,
    candlesConcurrency: 40,
    feedPage: 50,
    maxQueued: 100,
    ...over,
  });
  const clientsWith = (fetchMetadata: SourceClients['fetchMetadata']): SourceClients => ({
    ...testClients().clients,
    helius: {
      getAssets: async (mints) =>
        mints.map((m) => asset(m, { uri: `https://ipfs.io/ipfs/bafy${m.slice(0, 20)}` })),
    },
    jupiter: { getTokens: async (mints) => mints.map((m) => token(m)) },
    fetchMetadata,
  });
  const count = async (stage: string, status: string) =>
    Number(
      (
        await sql<{ n: string }>`select count(*)::text as n from coin_stages
          where stage = ${stage} and status = ${status}`.execute(f.t.db)
      ).rows[0]!.n,
    );
  /** Puts every metadata_file row back as it was before any run. */
  const resetFiles = () =>
    sql`delete from coin_stages where stage = 'metadata_file'`.execute(f.t.db);

  beforeAll(async () => {
    f = await seededDatabase(ROWS);
    // The metadata stage first: it stores the URIs the file stage reads.
    await runBackfill(opts({ clients: clientsWith(async () => okResult({})) }));
  }, 120_000);
  afterAll(async () => {
    await f.cleanup();
  });
  beforeEach(resetFiles);

  it('the default is 3 and has its own option', () => {
    expect(DEFAULT_METADATA_FILE_CONCURRENCY).toBe(3);
  });

  it('the dry run prints the coins in flight beside the gateway rate, default and override', async () => {
    const say = async (over: Partial<BackfillOptions>) => {
      const lines: string[] = [];
      await runBackfill(
        opts({ confirm: false, stages: ['metadata_file'], out: (x) => lines.push(x), ...over }),
      );
      return lines.join('\n');
    };
    expect(await say({ gatewayRps: 1.5 })).toContain(
      'At 1.5 request a second to each gateway with 3 coins in flight',
    );
    expect(await say({ gatewayRps: 1.5, fileConcurrency: 8 })).toContain(
      'At 1.5 request a second to each gateway with 8 coins in flight',
    );
    // --metadata-concurrency keeps its meaning for the metadata stage only.
    expect(await say({ gatewayRps: 1.5, metadataConcurrency: 37 })).toContain(
      'with 3 coins in flight',
    );
  });

  it('without any option, a gateway that slows down as requests pile up fails no coin', async () => {
    const g = slowingGateway();
    const report = await runBackfill(
      opts({
        stages: ['metadata_file'],
        clients: clientsWith(g.fetchMetadata),
        metadataConcurrency: 37,
      }),
    );
    expect(report.status).toBe('done');
    expect(g.state.calls).toBeGreaterThan(8);
    expect(g.state.peak).toBeLessThanOrEqual(DEFAULT_METADATA_FILE_CONCURRENCY);
    expect(g.state.timeouts).toBe(0);
    expect(await count('metadata_file', 'failed')).toBe(0);
    expect(await count('metadata_file', 'done')).toBe(g.state.calls);
  }, 120_000);

  it('the option overrides the default (and a hot setting does trip the double)', async () => {
    const g = slowingGateway();
    await runBackfill(
      opts({
        stages: ['metadata_file'],
        clients: clientsWith(g.fetchMetadata),
        fileConcurrency: 30,
        maxAttempts: 1,
      }),
    );
    expect(g.state.peak).toBeGreaterThan(DEFAULT_METADATA_FILE_CONCURRENCY);
    expect(g.state.peak).toBeLessThanOrEqual(30);
    expect(g.state.timeouts).toBeGreaterThan(0);
  }, 120_000);
});

describeWorkerDb('metadata_file: an overloaded-gateway failure costs one attempt a run', () => {
  let t: TestDatabase;
  let db: Kysely<Database>;
  let runId: number;
  let ids: number[];
  let answer: MetadataResult;

  beforeAll(async () => {
    t = await createTestDatabase(workerAdminUrl!);
    db = t.db;
    runId = await createRun(db, { kind: 'test' });
    const seeded = await seedCoins(db, [mintN(1), mintN(2), mintN(3)]);
    ids = [...seeded.values()];
    for (const id of ids) {
      await db
        .updateTable('coins')
        .set({
          metadata_uri: 'https://ipfs.io/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
        })
        .where('id', '=', id)
        .execute();
    }
  });
  afterAll(async () => {
    await t.drop();
  });

  /** Every gateway failed, one of them with a 429: the gateways were asked too much at once. */
  const mixed = (): MetadataResult => ({
    ...badResult('unreachable'),
    attempts: [
      { gateway: 'ipfs.filebase.io', result: 'timeout', status: null, requests: 1 },
      { gateway: 'gateway.pinata.cloud', result: 'rate_limited', status: 429, requests: 1 },
    ],
  });

  // One stage for the whole run: the rule remembers what this run charged.
  const registry = () =>
    new StageRegistry().register(createMetadataFileStage({ fetchMetadata: async () => answer }));
  const attempts = async (id: number) =>
    (
      await db
        .selectFrom('coin_stages')
        .select(['status', 'attempts'])
        .where('coin_id', '=', id)
        .where('stage', '=', 'metadata_file')
        .executeTakeFirstOrThrow()
    ).attempts;

  it('charges the first, gives back the repeats; another kind of failure is charged every time', async () => {
    const reg = registry();
    const run = (id: number) =>
      executeStage(
        {
          db,
          registry: reg,
          now: () => new Date(),
          log: testLog,
          runId,
          staleAfterMs: 60_000,
          maxAttempts: 3,
        },
        'metadata_file',
        id,
      );
    const [a, b, c] = ids as [number, number, number];

    // A 429 among timeouts is a gateway saying "too many at once": charged once, repeats given back.
    answer = mixed();
    for (let i = 0; i < 5; i++) expect(await run(a)).toMatchObject({ kind: 'retry' });
    expect(await attempts(a)).toBe(1);

    // Timeouts alone can be a hanging host of the coin's own: charged every time, fails at the limit.
    answer = badResult('unreachable');
    expect(await run(b)).toMatchObject({ kind: 'retry' });
    expect(await attempts(b)).toBe(1);
    expect(await run(b)).toMatchObject({ kind: 'retry' });
    expect(await attempts(b)).toBe(2);
    expect(await run(b)).toMatchObject({ kind: 'failed' });
    expect(await attempts(b)).toBe(3);

    // A server error among the answers is not overload either.
    const other = badResult('unreachable');
    other.attempts = [
      { gateway: 'ipfs.filebase.io', result: 'server_error', status: 502, requests: 1 },
      { gateway: 'gateway.pinata.cloud', result: 'rate_limited', status: 429, requests: 1 },
    ];
    answer = other;
    expect(await run(c)).toMatchObject({ kind: 'retry' });
    expect(await attempts(c)).toBe(1);
    expect(await run(c)).toMatchObject({ kind: 'retry' });
    expect(await attempts(c)).toBe(2);
  });

  it('a new run charges the coin again', async () => {
    const id = ids[0]!;
    const before = await attempts(id);
    answer = mixed();
    const fresh = registry(); // a new process, a new run
    await executeStage(
      {
        db,
        registry: fresh,
        now: () => new Date(),
        log: testLog,
        runId,
        staleAfterMs: 60_000,
        maxAttempts: 3,
      },
      'metadata_file',
      id,
    );
    expect(await attempts(id)).toBe(before + 1);
  });
});
