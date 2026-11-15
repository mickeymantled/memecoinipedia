/**
 * A backfill process for the stop test. The parent spawns it, waits for some finished coins, and
 * sends it SIGTERM. Env: CHILD_DB_URL, CHILD_SEED. The provider is the synthetic one, slowed so
 * the run is still going when the signal arrives.
 */
import { createDb } from '@memecoinipedia/db';
import { runBackfill } from '../../src/backfill/run.js';
import { installStopSignals } from '../../src/shared/signals.js';
import { silentLogger } from '../../src/worker/log.js';
import { testClients } from './helpers.js';
import { synthProvider } from './synthetic.js';

const url = process.env['CHILD_DB_URL']!;
const db = createDb(url, { max: 6 });
const log = silentLogger;
const signal = installStopSignals(log);
const { clients } = testClients({
  provider: synthProvider({ seed: Number(process.env['CHILD_SEED'] ?? 1), latencyMs: 20 }),
});
process.stdout.write('started\n');
const report = await runBackfill({
  selection: {
    chain: 'solana',
    minRoughPeakUsd: 30_000,
    includeNoPrice: false,
    order: 'hash',
    limit: null,
  },
  stages: ['candles'],
  codexRps: 10_000,
  maxCodexUnits: 10_000_000,
  confirm: true,
  env: { DATABASE_URL: url },
  log,
  out: () => undefined,
  db,
  clients,
  candlesConcurrency: 8,
  maxQueued: 30,
  feedPage: 10,
  signal,
});
process.stdout.write(`finished ${report.status}\n`);
await db.destroy();
process.exit(0);
