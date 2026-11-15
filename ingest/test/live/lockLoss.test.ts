/**
 * The pipeline lock lives on a database connection. If that connection is killed while the process
 * runs, the lock is gone and a second process could start, so the process must notice, take no new
 * work, let running jobs finish, and exit with an error that says the lock was lost. Both runners.
 */
import {
  acquirePipelineLock,
  PIPELINE_LOCK_KEY,
  PipelineLockLostError,
  type Database,
} from '@memecoinipedia/db';
import { sql, type Kysely } from 'kysely';
import { afterEach, expect, it } from 'vitest';
import { countRunningStages, runBackfill } from '../../src/backfill/run.js';
import { runLive } from '../../src/live/run.js';
import {
  describeDb as describeBackfillDb,
  seededDatabase,
  testClients,
  testLog,
  type Fixture,
} from '../backfill/helpers.js';
import { synthProvider } from '../backfill/synthetic.js';
import { captureLog, describeDb, liveFixture, type LiveFixture } from './helpers.js';

let fx: LiveFixture | undefined;
let seeded: Fixture | undefined;
afterEach(async () => {
  await fx?.cleanup();
  await seeded?.cleanup();
  fx = undefined;
  seeded = undefined;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The session that holds the pipeline lock, or null while nobody does. */
async function lockHolderPid(db: Kysely<Database>): Promise<number | null> {
  const r = await sql<{ pid: number }>`
    select pid from pg_locks
    where locktype = 'advisory' and classid = ${Math.floor(PIPELINE_LOCK_KEY / 2 ** 32)}::oid
      and objid = ${PIPELINE_LOCK_KEY % 2 ** 32}::oid and granted`.execute(db);
  return r.rows[0]?.pid ?? null;
}

/** Kills the connection that holds the lock, as a network drop or a database restart would. */
async function killLockConnection(db: Kysely<Database>): Promise<void> {
  const pid = await lockHolderPid(db);
  expect(pid).not.toBeNull();
  await sql`select pg_terminate_backend(${pid})`.execute(db);
}

async function until(what: string, test: () => Promise<boolean>, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await test()) return;
    await sleep(20);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

describeDb('live run: the lock connection is killed', () => {
  it('stops with the lock-lost error, and the lock is free afterwards', async () => {
    fx = await liveFixture();
    const f = fx;
    const lines: string[] = [];
    const run = runLive({
      confirm: true,
      env: { DATABASE_URL: f.t.url },
      log: captureLog().log,
      out: (t) => lines.push(t),
      db: f.db,
      clients: f.clients,
      now: f.clock.now,
      tickSeconds: 0.02,
      // Without the check this would run for minutes: the test fails by timing out.
      maxTicks: 100_000,
    });
    const settled = run.then(
      () => null,
      (e: unknown) => e,
    );
    await until(
      'the live process to hold the lock',
      async () => (await lockHolderPid(f.db)) !== null,
    );
    await sleep(100);
    await killLockConnection(f.db);

    const err = await settled;
    expect(err).toBeInstanceOf(PipelineLockLostError);
    expect((err as Error).message).toMatch(/pipeline lock was lost/);
    // The run was closed out as failed and nothing was left running.
    const runs = await sql<{ status: string }>`
      select status from ingest_runs where kind = 'live' order by id desc limit 1`.execute(f.db);
    expect(runs.rows[0]!.status).toBe('failed');
    expect(await countRunningStages(f.db)).toBe(0);
    // Another process may now take the lock, and the dead one's hint did not remove its own.
    const again = await acquirePipelineLock(f.t.url, 'backfill');
    await again.release();
  }, 60_000);
});

describeBackfillDb('backfill run: the lock connection is killed', () => {
  it('takes no new coin, lets the jobs in flight finish, and fails with the lock-lost error', async () => {
    seeded = await seededDatabase(200, 3);
    const f = seeded;
    const tc = testClients({ provider: synthProvider({ seed: 3, latencyMs: 15 }) });
    const run = runBackfill({
      selection: {
        chain: 'solana',
        minRoughPeakUsd: 30_000,
        includeNoPrice: false,
        order: 'peak',
        limit: null,
      },
      stages: ['candles'],
      codexRps: 10_000,
      maxCodexUnits: 10_000_000,
      confirm: true,
      env: { DATABASE_URL: f.t.url },
      log: testLog,
      out: () => {},
      db: f.t.db,
      clients: tc.clients,
      candlesConcurrency: 8,
      maxQueued: 30,
      feedPage: 10,
      lockCheckSeconds: 0.05,
    });
    const settled = run.then(
      () => null,
      (e: unknown) => e,
    );
    const done = async () =>
      Number(
        (
          await sql<{
            n: string;
          }>`select count(*)::text as n from coin_stages where stage = 'candles' and status = 'done'`.execute(
            f.t.db,
          )
        ).rows[0]!.n,
      );
    await until('some coins to finish', async () => (await done()) >= 10);
    await killLockConnection(f.t.db);

    const err = await settled;
    expect(err).toBeInstanceOf(PipelineLockLostError);
    expect((err as Error).message).toMatch(/pipeline lock was lost/);
    // Jobs in flight finished; the rest were never started.
    expect(await countRunningStages(f.t.db)).toBe(0);
    const finished = await done();
    expect(finished).toBeGreaterThanOrEqual(10);
    expect(finished).toBeLessThan(200);
    const runs = await sql<{ status: string }>`
      select status from ingest_runs order by id desc limit 1`.execute(f.t.db);
    expect(runs.rows[0]!.status).toBe('failed');
  }, 120_000);
});
