/**
 * Ingest a sample file through the per-coin pipeline (seed, then metadata).
 *
 *   node --env-file=.env --import tsx ingest/scripts/ingest-sample.ts \
 *     --sample FILE [--stages discovered,metadata] [--concurrency 5] \
 *     [--max-helius-credits 300] [--gateway-rps 1] [--retry-failed] [--confirm]
 *
 * Without --confirm it prints the plan and the cost estimate (requests and
 * credits per provider) and stops: no call, no write. With it, it runs and
 * prints a summary. A stage that used up its retries stays failed on later runs
 * (a run with nothing else to do says so); --retry-failed gives those a fresh set. Keys come from the environment (HELIUS_API_KEY, optional
 * JUPITER_API_KEY, DATABASE_URL); nothing prints them.
 */
import { parseArgs } from 'node:util';
import type { StageName } from '@memecoinipedia/db';
import { consoleLogger, secretsFromEnv } from '../src/worker/log.js';
import { DEFAULT_STAGES, runIngest } from '../src/worker/run.js';

const STAGE_NAMES: readonly string[] = ['discovered', 'metadata', 'candles', 'metrics'];

function usage(message?: string): never {
  if (message) process.stderr.write(`${message}\n\n`);
  process.stderr.write(
    'Usage: ingest-sample.ts --sample FILE [--stages discovered,metadata] [--concurrency N]\n' +
      '                        [--max-helius-credits N] [--gateway-rps N] [--retry-failed] [--confirm]\n',
  );
  process.exit(message ? 2 : 0);
}

function positiveInt(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) usage(`${name} must be a positive integer`);
  return n;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      sample: { type: 'string' },
      stages: { type: 'string' },
      concurrency: { type: 'string' },
      'max-helius-credits': { type: 'string' },
      'gateway-rps': { type: 'string' },
      'retry-failed': { type: 'boolean', default: false },
      confirm: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (values.help) usage();
  if (!values.sample) usage('--sample FILE is required');

  const stages = (values.stages ?? DEFAULT_STAGES.join(',')).split(',').map((s) => s.trim());
  for (const s of stages) if (!STAGE_NAMES.includes(s)) usage(`Unknown stage "${s}"`);

  const log = consoleLogger({ secrets: secretsFromEnv(process.env) });
  const abort = new AbortController();
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => {
      log.warn(`${sig} received: finishing running jobs, then stopping`);
      abort.abort();
    });
  }

  const concurrency = positiveInt('--concurrency', values.concurrency);
  const maxHeliusCredits = positiveInt('--max-helius-credits', values['max-helius-credits']);
  const gatewayRps = positiveInt('--gateway-rps', values['gateway-rps']);
  const report = await runIngest({
    samplePath: values.sample,
    stages: stages as StageName[],
    ...(concurrency !== undefined ? { concurrency } : {}),
    maxHeliusCredits: maxHeliusCredits ?? null,
    ...(gatewayRps !== undefined ? { gatewayRps } : {}),
    retryFailed: values['retry-failed'],
    confirm: values.confirm,
    env: process.env,
    log,
    out: (text) => process.stdout.write(`${text}\n`),
    signal: abort.signal,
  });
  if (report.status === 'failed') process.exitCode = 1;
}

main().catch((err: unknown) => {
  const secrets = secretsFromEnv(process.env);
  const message = err instanceof Error ? err.message : String(err);
  let text = message;
  for (const s of secrets) if (s.length >= 6) text = text.split(s).join('[redacted]');
  process.stderr.write(`ingest-sample failed: ${text}\n`);
  process.exit(1);
});
