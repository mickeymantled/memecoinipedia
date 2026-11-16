/**
 * A worker process for the kill test. The parent spawns it, waits until it has
 * finished some coins, and kills it with SIGKILL. One coin (address starting
 * with "HANG") never finishes, so the process always dies mid-run.
 *
 * Env: CHILD_DB_URL, CHILD_RUN_ID, CHILD_STAGE_TIMEOUT. Each finished coin is
 * recorded in the test table `test_stage_runs`, which the parent reads.
 */
import { createDb } from '@memecoinipedia/db';
import { sql } from 'kysely';
import { silentLogger } from '../../src/worker/log.js';
import { StageRegistry } from '../../src/worker/stage.js';
import { discoveredStage } from '../../src/worker/stages/discovered.js';
import { PipelineWorker } from '../../src/worker/worker.js';

const url = process.env['CHILD_DB_URL']!;
const runId = Number(process.env['CHILD_RUN_ID']);
const db = createDb(url);

const registry = new StageRegistry().register(discoveredStage).register({
  name: 'metadata',
  version: 1,
  async run(_ctx, coin) {
    if (coin.address.startsWith('HANG')) {
      process.stdout.write(`hanging ${coin.id}\n`);
      await new Promise(() => undefined);
    }
    await new Promise((r) => setTimeout(r, 120));
    await sql`insert into test_stage_runs (coin_id, pid) values (${coin.id}, ${process.pid})`.execute(
      db,
    );
    return { status: 'done' };
  },
});

const worker = new PipelineWorker({
  connectionString: url,
  db,
  registry,
  runId,
  log: silentLogger,
  concurrency: 3,
  stageTimeoutSeconds: Number(process.env['CHILD_STAGE_TIMEOUT'] ?? 2),
  monitorIntervalSeconds: 1,
  pollingIntervalSeconds: 0.5,
});
await worker.start();
await worker.enqueueNotDone();
process.stdout.write('ready\n');
setInterval(() => undefined, 1000);
