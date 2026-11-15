import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createRun, type Database } from '@memecoinipedia/db';
import { createTestDatabase, type TestDatabase } from '@memecoinipedia/db/testing';
import { sql, type Kysely } from 'kysely';
import {
  StageRegistry,
  type PipelineStageName,
  type Stage,
  type StageResult,
} from '../../src/worker/stage.js';
import { discoveredStage } from '../../src/worker/stages/discovered.js';
import { PipelineWorker, type PipelineWorkerOptions } from '../../src/worker/worker.js';
import { adminUrl, describeDb, mintN, seedCoins, testLog } from './helpers.js';

const INGEST_DIR = fileURLToPath(new URL('../..', import.meta.url));
const CHILD = fileURLToPath(new URL('./kill-child.ts', import.meta.url));

describeDb('queue worker', () => {
  let t: TestDatabase;
  let db: Kysely<Database>;
  let runId: number;
  const workers: PipelineWorker[] = [];

  beforeEach(async () => {
    t = await createTestDatabase(adminUrl!);
    db = t.db;
    runId = await createRun(db, { kind: 'test' });
    await sql`create table test_stage_runs (coin_id bigint not null, pid int)`.execute(db);
  });
  afterEach(async () => {
    await Promise.all(
      workers.splice(0).map((w) => w.stop({ timeoutMs: 5000 }).catch(() => undefined)),
    );
    await t.drop();
  });

  /** A fake stage that records each finished run in `test_stage_runs` and follows a script per coin. */
  const stage = (
    name: PipelineStageName,
    behave: (coinId: number, attempt: number) => StageResult | Promise<StageResult> = () => ({
      status: 'done',
    }),
  ): Stage => {
    const seen = new Map<number, number>();
    return {
      name,
      version: 1,
      async run(_ctx, coin) {
        const attempt = (seen.get(coin.id) ?? 0) + 1;
        seen.set(coin.id, attempt);
        const result = await behave(coin.id, attempt);
        if (name === 'metadata') {
          await sql`insert into test_stage_runs (coin_id, pid) values (${coin.id}, ${process.pid})`.execute(
            db,
          );
        }
        return result;
      },
    };
  };

  const worker = (registry: StageRegistry, extra: Partial<PipelineWorkerOptions> = {}) => {
    const w = new PipelineWorker({
      connectionString: t.url,
      db,
      registry,
      runId,
      log: testLog,
      concurrency: 4,
      maxAttempts: 3,
      retryDelaySeconds: 1,
      stageTimeoutSeconds: 2,
      monitorIntervalSeconds: 1,
      pollingIntervalSeconds: 0.5,
      ...extra,
    });
    workers.push(w);
    return w;
  };

  const stages = async () =>
    db.selectFrom('coin_stages').selectAll().orderBy('coin_id').orderBy('stage').execute();
  const runsOf = async () =>
    (
      await sql<{ coin_id: number; n: string }>`
      select coin_id, count(*)::text as n from test_stage_runs group by coin_id order by coin_id
    `.execute(db)
    ).rows.map((r) => ({ coin: Number(r.coin_id), n: Number(r.n) }));

  it('runs every coin through every stage once, in order', async () => {
    const addresses = Array.from({ length: 12 }, (_, i) => mintN(i + 1));
    const ids = [...(await seedCoins(db, addresses)).values()];
    const w = worker(
      new StageRegistry()
        .register(discoveredStage)
        .register(stage('metadata'))
        .register(stage('candles')),
    );
    await w.start();
    expect(await w.enqueueNotDone()).toEqual({ discovered: 0, metadata: 12, candles: 0 });
    await w.waitUntilIdle();

    const rows = await stages();
    expect(rows).toHaveLength(12 * 3); // no duplicate rows
    expect(rows.every((r) => r.status === 'done')).toBe(true);
    expect((await runsOf()).map((r) => r.n)).toEqual(Array(12).fill(1));
    // candles started only after metadata finished.
    for (const id of ids) {
      const m = rows.find((r) => r.coin_id === id && r.stage === 'metadata')!;
      const c = rows.find((r) => r.coin_id === id && r.stage === 'candles')!;
      expect(c.started_at!.getTime()).toBeGreaterThanOrEqual(m.finished_at!.getTime());
    }
  });

  it('stops after metadata when no later stage is registered', async () => {
    await seedCoins(db, [mintN(1), mintN(2)]);
    const w = worker(new StageRegistry().register(discoveredStage).register(stage('metadata')));
    await w.start();
    await w.enqueueNotDone();
    await w.waitUntilIdle();
    expect((await stages()).map((r) => r.stage).sort()).toEqual([
      'discovered',
      'discovered',
      'metadata',
      'metadata',
    ]);
  });

  it('retries a failing stage with backoff, then leaves it failed with the reason', async () => {
    const ids = await seedCoins(db, [mintN(1), mintN(2), mintN(3)]);
    const bad = ids.get(mintN(2))!;
    const w = worker(
      new StageRegistry()
        .register(discoveredStage)
        .register(
          stage('metadata', (id) =>
            id === bad
              ? {
                  status: 'failed',
                  reason: 'metadata_unreachable: ipfs.filebase.io timeout',
                  retry: true,
                }
              : { status: 'done' },
          ),
        )
        .register(stage('candles')),
    );
    await w.start();
    await w.enqueueNotDone();
    await w.waitUntilIdle();

    const rows = await stages();
    const badRow = rows.find((r) => r.coin_id === bad && r.stage === 'metadata')!;
    expect(badRow).toMatchObject({
      status: 'failed',
      attempts: 3, // one try and two retries, then final
      last_error: 'metadata_unreachable: ipfs.filebase.io timeout',
    });
    // The failed coin never reached the next stage; the others did.
    expect(rows.filter((r) => r.coin_id === bad && r.stage === 'candles')).toEqual([]);
    expect(rows.filter((r) => r.stage === 'candles' && r.status === 'done')).toHaveLength(2);
    // Its work ran three times and the others once.
    expect((await runsOf()).find((r) => r.coin === bad)?.n).toBe(3);
  }, 30_000);

  it('a stage that fails once and then works ends up done after two attempts', async () => {
    const ids = await seedCoins(db, [mintN(1)]);
    const id = [...ids.values()][0]!;
    const w = worker(
      new StageRegistry().register(discoveredStage).register(
        stage('metadata', (_id, attempt) => {
          if (attempt === 1) throw new Error('socket hang up');
          return { status: 'done' };
        }),
      ),
    );
    await w.start();
    await w.enqueueNotDone();
    await w.waitUntilIdle();
    expect((await stages()).find((r) => r.coin_id === id && r.stage === 'metadata')).toMatchObject({
      status: 'done',
      attempts: 2,
      last_error: null,
    });
  }, 30_000);

  it('does not retry a failure marked not retryable', async () => {
    const ids = await seedCoins(db, [mintN(1)]);
    const w = worker(
      new StageRegistry()
        .register(discoveredStage)
        .register(
          stage('metadata', () => ({
            status: 'failed',
            reason: 'budget_exceeded: ceiling',
            retry: false,
          })),
        ),
    );
    await w.start();
    await w.enqueueNotDone();
    await w.waitUntilIdle();
    expect(
      (await stages()).find((r) => r.coin_id === [...ids.values()][0] && r.stage === 'metadata'),
    ).toMatchObject({ status: 'failed', attempts: 1, last_error: 'budget_exceeded: ceiling' });
  });

  it('a second start over finished coins queues nothing and runs nothing', async () => {
    await seedCoins(
      db,
      Array.from({ length: 5 }, (_, i) => mintN(i + 1)),
    );
    const registry = () =>
      new StageRegistry().register(discoveredStage).register(stage('metadata'));
    const first = worker(registry());
    await first.start();
    await first.enqueueNotDone();
    await first.waitUntilIdle();
    await first.stop();
    const before = await stages();

    const second = worker(registry());
    await second.start();
    expect(await second.enqueueNotDone()).toEqual({ discovered: 0, metadata: 0 });
    await second.waitUntilIdle();
    expect(await stages()).toEqual(before);
    expect((await runsOf()).map((r) => r.n)).toEqual(Array(5).fill(1));
  });

  it('killing the process mid-run and starting again finishes the rest with no duplicates and nothing run twice', async () => {
    const addresses = [
      mintN(1),
      `HANG${mintN(2).slice(4)}`,
      ...Array.from({ length: 20 }, (_, i) => mintN(i + 3)),
    ];
    const ids = await seedCoins(db, addresses);
    const hangId = ids.get(addresses[1]!)!;

    const child = spawn(process.execPath, ['--import', 'tsx', CHILD], {
      cwd: INGEST_DIR,
      env: {
        ...process.env,
        CHILD_DB_URL: t.url,
        CHILD_RUN_ID: String(runId),
        CHILD_STAGE_TIMEOUT: '2',
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));

    // Wait until it has finished some coins and is stuck on the hanging one.
    const deadline = Date.now() + 25_000;
    let finished = 0;
    while (Date.now() < deadline) {
      finished = (await runsOf()).length;
      if (finished >= 6 && out.includes(`hanging ${hangId}`)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(finished).toBeGreaterThanOrEqual(6);
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));

    const killedAt = await stages();
    const doneBefore = killedAt.filter((r) => r.stage === 'metadata' && r.status === 'done').length;
    expect(doneBefore).toBeLessThan(addresses.length); // it really died mid-run
    expect(killedAt.find((r) => r.coin_id === hangId && r.stage === 'metadata')?.status).toBe(
      'running',
    );

    // Start again.
    const resumed = worker(
      new StageRegistry().register(discoveredStage).register(stage('metadata')),
    );
    await resumed.start();
    await resumed.enqueueNotDone();
    await resumed.waitUntilIdle({ pollMs: 200 });

    const rows = await stages();
    expect(rows).toHaveLength(addresses.length * 2); // no duplicate rows
    expect(rows.every((r) => r.status === 'done')).toBe(true);
    const runs = await runsOf();
    expect(runs).toHaveLength(addresses.length);
    expect(runs.every((r) => r.n === 1)).toBe(true); // no stage ran to completion twice
    // The coin the dead process was holding was taken over once, by the new one.
    expect(rows.find((r) => r.coin_id === hangId && r.stage === 'metadata')?.attempts).toBe(2);
    // Everything that was done before the kill was left alone.
    for (const r of killedAt.filter((r) => r.stage === 'metadata' && r.status === 'done')) {
      expect(rows.find((x) => x.coin_id === r.coin_id && x.stage === 'metadata')?.attempts).toBe(1);
    }
  }, 60_000);
});
