/**
 * The backfill: seed the candidate list, then run the stages over a selection of it.
 *
 *   Seed (writes only; no provider call; needs --confirm to write):
 *     tsx scripts/backfill.ts seed --file FILE [--source NAME] [--confirm]
 *
 *   Run (a dry run without --confirm: the selection, coins per stage and the estimate in units):
 *     tsx scripts/backfill.ts run [--min-rough-peak 30000] [--limit N] [--order peak|hash]
 *       [--include-no-price] [--stages candles,metrics,metadata]
 *       [--codex-rps 100] [--concurrency 200] [--metrics-concurrency N] [--metadata-concurrency N]
 *       [--db-pool 30] [--queue-pool 8] [--gateway-rps 1] [--max-attempts 3] [--retry-failed]
 *       [--max-codex-units N] [--max-helius-credits N] [--confirm]
 *
 *   Refresh the pool list of chosen coins that are already fetched (dry run without --confirm):
 *     tsx scripts/backfill.ts run --refresh-pools --coins FILE [--stages candles,metrics]
 *       [--max-codex-units N] [--confirm]
 *   FILE has one coin id or mint address a line. Each coin's candles stage lists the pools again,
 *   stores the ones not held (side pools only when quoted in SOL, USDC or USDT), fetches bars for
 *   them and no bar twice; a coin that gained a pool has its metrics put back to pending.
 *   It refuses to run without --coins or --rule.
 *   --rule NAME picks the coins from the database instead of a file; the rule is
 *   late-graduation-pool: a graduation pool created more than 3,600 seconds after the coin's
 *   graduation time, or no graduation pool on a coin whose candles are done. It asks no provider.
 *     tsx scripts/backfill.ts run --refresh-pools --rule late-graduation-pool [--confirm ...]
 *
 *   Print the coins a rule picks, one id a line, to a file for --coins (no provider call, no write;
 *   the count goes to stderr):
 *     tsx scripts/backfill.ts select --rule late-graduation-pool > coins.txt
 *
 *   What is running, and how far: tsx scripts/backfill-status.ts
 *
 * Run it from the `ingest` directory (`pnpm -C ingest exec tsx scripts/backfill.ts ...`), with
 * DATABASE_URL, CODEX_API_KEY and HELIUS_API_KEY in the environment (nothing prints them).
 *
 * Order. `peak`: largest rough peak first. `hash`: a fixed pseudo-random order by a hash of the
 * address, so `--limit N` is the same fair sample every time. A coin already done is skipped
 * whatever the order; the limit counts the first N coins of the order, done or not.
 *
 * Stop with Ctrl-C or SIGTERM: no new coin is taken, the ones in flight finish, the summary is
 * printed, the exit code is 0. A second signal exits at once. Running the same command again
 * carries on; nothing is fetched twice.
 */
import { parseArgs } from 'node:util';
import { COIN_RULES, createDb, selectCoinsByRule, type CoinRule } from '@memecoinipedia/db';
import { DEFAULT_PLAN_LIMITS } from '../src/candles/plan.js';
import { BACKFILL_STAGES, type BackfillStageName } from '../src/backfill/setup.js';
import { DEFAULT_MIN_ROUGH_PEAK_USD } from '../src/backfill/defaults.js';
import { runBackfill } from '../src/backfill/run.js';
import { formatSeedReport, seedFromCandidateFile } from '../src/backfill/seed.js';
import { installStopSignals } from '../src/backfill/signals.js';
import { consoleLogger, secretsFromEnv } from '../src/worker/log.js';

function usage(message?: string): never {
  if (message) process.stderr.write(`${message}\n\n`);
  process.stderr.write(
    'Usage: backfill.ts seed --file FILE [--source NAME] [--confirm]\n' +
      '       backfill.ts run [--min-rough-peak USD] [--limit N] [--order peak|hash]\n' +
      '                       [--include-no-price] [--stages candles,metrics,metadata]\n' +
      '                       [--codex-rps N] [--concurrency N] [--metrics-concurrency N]\n' +
      '                       [--metadata-concurrency N] [--db-pool N] [--queue-pool N]\n' +
      '                       [--gateway-rps N] [--max-attempts N] [--retry-failed]\n' +
      '                       [--max-codex-units N] [--max-helius-credits N] [--confirm]\n' +
      '       backfill.ts run --refresh-pools (--coins FILE | --rule late-graduation-pool)\n' +
      '                       [--max-codex-units N] [--confirm]\n' +
      '       backfill.ts select --rule late-graduation-pool\n',
  );
  process.exit(message ? 2 : 0);
}

function positive(name: string, value: string | undefined, integer = true): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || (integer && !Number.isInteger(n))) {
    usage(`${name} must be a positive ${integer ? 'integer' : 'number'}`);
  }
  return n;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command !== 'seed' && command !== 'run' && command !== 'select')
    usage(command ? `Unknown command "${command}"` : undefined);
  const { values } = parseArgs({
    args: rest,
    options: {
      file: { type: 'string' },
      source: { type: 'string' },
      'min-rough-peak': { type: 'string' },
      limit: { type: 'string' },
      order: { type: 'string' },
      'include-no-price': { type: 'boolean', default: false },
      stages: { type: 'string' },
      'codex-rps': { type: 'string' },
      concurrency: { type: 'string' },
      'metrics-concurrency': { type: 'string' },
      'metadata-concurrency': { type: 'string' },
      'db-pool': { type: 'string' },
      'queue-pool': { type: 'string' },
      'gateway-rps': { type: 'string' },
      'max-attempts': { type: 'string' },
      'max-codex-units': { type: 'string' },
      'max-helius-credits': { type: 'string' },
      'refresh-pools': { type: 'boolean', default: false },
      coins: { type: 'string' },
      rule: { type: 'string' },
      'retry-failed': { type: 'boolean', default: false },
      confirm: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (values.help) usage();
  const log = consoleLogger({ secrets: secretsFromEnv(process.env) });
  const out = (text: string) => process.stdout.write(`${text}\n`);

  if (command === 'seed') {
    if (!values.file) usage('--file FILE is required');
    const url = process.env['DATABASE_URL'];
    if (values.confirm && !url) usage('DATABASE_URL is not set');
    const db = values.confirm && url ? createDb(url, { max: 4 }) : undefined;
    try {
      const report = await seedFromCandidateFile({
        file: values.file,
        confirm: values.confirm,
        db,
        ...(values.source ? { discoverySource: values.source } : {}),
        onProgress: (n) => {
          if (n % 50_000 === 0) log.info(`seeded ${n.toLocaleString('en-US')} rows`);
        },
      });
      out(formatSeedReport(report, values.confirm));
    } finally {
      await db?.destroy();
    }
    return;
  }

  let rule: CoinRule | undefined;
  if (values.rule !== undefined) {
    if (!(COIN_RULES as readonly string[]).includes(values.rule)) {
      usage(`Unknown rule "${values.rule}" (known: ${COIN_RULES.join(', ')})`);
    }
    rule = values.rule as CoinRule;
  }

  if (command === 'select') {
    if (!rule) usage('select needs --rule NAME');
    const url = process.env['DATABASE_URL'];
    if (!url) usage('DATABASE_URL is not set');
    const db = createDb(url, { max: 2 });
    try {
      const ids = await selectCoinsByRule(db, rule, {
        maxDelaySeconds: DEFAULT_PLAN_LIMITS.maxGraduationPoolDelaySeconds,
      });
      for (const id of ids) out(String(id));
      process.stderr.write(`${ids.length} coins picked by ${rule}\n`);
    } finally {
      await db.destroy();
    }
    return;
  }

  if (values['refresh-pools'] && !values.coins && !rule) {
    usage(
      '--refresh-pools needs a coin selection: --coins FILE (one coin id or address a line) ' +
        'or --rule late-graduation-pool',
    );
  }
  if (values.coins && rule) usage('--coins and --rule are alternatives: give one');
  if ((values.coins || rule) && !values['refresh-pools']) {
    usage('--coins and --rule are only used with --refresh-pools');
  }
  const order = values.order ?? 'peak';
  if (order !== 'peak' && order !== 'hash') usage('--order is peak or hash');
  const stages = (
    values.stages ?? (values['refresh-pools'] ? 'candles,metrics' : BACKFILL_STAGES.join(','))
  )
    .split(',')
    .map((s) => s.trim());
  for (const s of stages) {
    if (!(BACKFILL_STAGES as readonly string[]).includes(s)) usage(`Unknown stage "${s}"`);
  }
  const limit = positive('--limit', values.limit);
  const floor = positive('--min-rough-peak', values['min-rough-peak'], false);
  const concurrency = positive('--concurrency', values.concurrency);
  const metrics = positive('--metrics-concurrency', values['metrics-concurrency']);
  const metadata = positive('--metadata-concurrency', values['metadata-concurrency']);
  const dbPool = positive('--db-pool', values['db-pool']);
  const queuePool = positive('--queue-pool', values['queue-pool']);
  const rps = positive('--codex-rps', values['codex-rps'], false);
  const gatewayRps = positive('--gateway-rps', values['gateway-rps'], false);
  const maxAttempts = positive('--max-attempts', values['max-attempts']);
  const maxCodexUnits = positive('--max-codex-units', values['max-codex-units'], false);
  const maxHelius = positive('--max-helius-credits', values['max-helius-credits'], false);
  if (values.confirm && stages.includes('candles') && maxCodexUnits === undefined) {
    usage('--max-codex-units N is required with --confirm when the candles stage is selected');
  }

  const report = await runBackfill({
    selection: {
      chain: 'solana',
      minRoughPeakUsd: floor ?? DEFAULT_MIN_ROUGH_PEAK_USD,
      includeNoPrice: values['include-no-price'],
      order,
      limit: limit ?? null,
    },
    stages: stages as BackfillStageName[],
    ...(rps !== undefined ? { codexRps: rps } : {}),
    ...(concurrency !== undefined ? { candlesConcurrency: concurrency } : {}),
    ...(metrics !== undefined ? { metricsConcurrency: metrics } : {}),
    ...(metadata !== undefined ? { metadataConcurrency: metadata } : {}),
    ...(dbPool !== undefined ? { dbPoolSize: dbPool } : {}),
    ...(queuePool !== undefined ? { queuePoolSize: queuePool } : {}),
    ...(gatewayRps !== undefined ? { gatewayRps } : {}),
    ...(maxAttempts !== undefined ? { maxAttempts } : {}),
    maxCodexUnits: maxCodexUnits ?? null,
    maxHeliusCredits: maxHelius ?? null,
    retryFailed: values['retry-failed'],
    ...(values['refresh-pools'] && values.coins
      ? { refreshPools: { coinsFile: values.coins } }
      : {}),
    ...(values['refresh-pools'] && rule ? { refreshPools: { rule } } : {}),
    confirm: values.confirm,
    env: process.env,
    log,
    out,
    // Installed only for a real run: a dry run has nothing to stop.
    ...(values.confirm ? { signal: installStopSignals(log) } : {}),
  });
  if (report.status === 'failed') process.exitCode = 1;
}

main().catch((err: unknown) => {
  const secrets = secretsFromEnv(process.env);
  let text = err instanceof Error ? err.message : String(err);
  for (const s of secrets) if (s.length >= 6) text = text.split(s).join('[redacted]');
  process.stderr.write(`backfill failed: ${text}\n`);
  process.exit(1);
});
