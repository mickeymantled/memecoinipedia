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

  it('runs every coin through every stage once, each after the stage it requires', async () => {
    const addresses = Array.from({ length: 12 }, (_, i) => mintN(i + 1));
    const ids = [...(await seedCoins(db, addresses)).values()];
    const w = worker(
      new StageRegistry()
        .register(discoveredStage)
        .register(stage('metadata'))
        .register(stage('candles'))
        .register(stage('metrics')),
    );
    // metadata and candles both need only `discovered`; metrics waits for candles. Counted before
    // the workers start: once they run, a candles job can finish before the metrics count is taken.
    const todo: Record<string, number> = {};
    for (const name of w.activeStages) todo[name] = (await w.coinsToDo(name)).length;
    expect(todo).toEqual({ discovered: 0, metadata: 12, candles: 12, metrics: 0 });
    await w.start();
    await w.enqueueNotDone();
    await w.waitUntilIdle();

    const rows = await stages();
    expect(rows).toHaveLength(12 * 4); // no duplicate rows
    expect(rows.every((r) => r.status === 'done')).toBe(true);
    expect((await runsOf()).map((r) => r.n)).toEqual(Array(12).fill(1));
    // metrics started only after candles finished.
    for (const id of ids) {
      const c = rows.find((r) => r.coin_id === id && r.stage === 'candles')!;
      const m = rows.find((r) => r.coin_id === id && r.stage === 'metrics')!;
      expect(m.started_at!.getTime()).toBeGreaterThanOrEqual(c.finished_at!.getTime());
    }
  });

  it('runs only the registered stages', async () => {
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

  it('a failed metadata stage does not hold back candles and metrics, and failed candles hold back metrics', async () => {
    const ids = await seedCoins(db, [mintN(1), mintN(2), mintN(3)]);
    const noMeta = ids.get(mintN(1))!;
    const noCandles = ids.get(mintN(2))!;
    const w = worker(
      new StageRegistry()
        .register(discoveredStage)
        .register(
          stage('metadata', (id) =>
            id === noMeta
              ? { status: 'failed', reason: 'helius_error: x', retry: false }
              : { status: 'done' },
          ),
        )
        .register(
          stage('candles', (id) =>
            id === noCandles
              ? { status: 'failed', reason: 'no_pools: none', retry: false }
              : { status: 'done' },
          ),
        )
        .register(stage('metrics')),
    );
    await w.start();
    await w.enqueueNotDone();
    await w.waitUntilIdle();
    const status = async (coin: number, stage: string) =>
      (await stages()).find((r) => r.coin_id === coin && r.stage === stage)?.status ?? 'none';
    expect(await status(noMeta, 'metadata')).toBe('failed');
    expect(await status(noMeta, 'candles')).toBe('done');
    expect(await status(noMeta, 'metrics')).toBe('done');
    expect(await status(noCandles, 'candles')).toBe('failed');
    expect(await status(noCandles, 'metrics')).toBe('none');
    expect(await status(noCandles, 'metadata')).toBe('done');
  });

  it('a held stage claims no coin and leaves its coins as they were', async () => {
    const ids = await seedCoins(db, [mintN(1), mintN(2), mintN(3)]);
    let open = true;
    let ran = 0;
    const gated: Stage = {
      ...stage('candles', () => {
        ran++;
        open = false; // the first coin closes the gate, as a spend ceiling does
        return { status: 'done' };
      }),
      admit: () => open,
    };
    const w = worker(new StageRegistry().register(discoveredStage).register(gated), {
      concurrency: 1,
    });
    await w.start();
    await w.enqueueNotDone();
    await w.waitUntilIdle();
    const rows = (await stages()).filter((r) => r.stage === 'candles');
    expect(ran).toBe(1);
    expect(rows.filter((r) => r.status === 'done')).toHaveLength(1);
    // The other two were never claimed: no attempt, no row change beyond what was there.
    expect(rows.filter((r) => r.status !== 'done')).toEqual([]);
    expect(ids.size).toBe(3);
    // A later run with the gate open finishes them, and the first coin is not run again.
    open = true;
    const again = worker(new StageRegistry().register(discoveredStage).register(gated));
    await again.start();
    expect(await again.enqueueNotDone()).toEqual({ discovered: 0, candles: 2 });
    await again.waitUntilIdle();
    expect(ran).toBe(3);
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
        .register(stage('candles'))
        .register(stage('metrics')),
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
    // Candles does not need metadata: the failed coin got candles and metrics like the others.
    expect(rows.filter((r) => r.stage === 'candles' && r.status === 'done')).toHaveLength(3);
    expect(rows.filter((r) => r.stage === 'metrics' && r.status === 'done')).toHaveLength(3);
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
      new StageRegistry().register(discoveredStage).register(
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
