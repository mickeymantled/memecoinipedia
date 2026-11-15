/**
 * The live worker: keep the database up to date after the backfill.
 *
 *   Run. A dry run without --confirm: prints the watched coins by age and the requests and units a
 *   day it expects, reads the database only, and asks nothing of any provider.
 *     tsx scripts/live.ts run [--max-codex-units-per-day 40000] [--codex-rps 100]
 *       [--gateway-rps 1] [--max-attempts 3] [--graduates-per-day N] [--confirm]
 *
 *   Status (read-only, from the database alone; works whether or not the process is running):
 *     tsx scripts/live.ts status
 *
 *   Health (read-only, one transaction, no provider request, takes no lock: runs beside the live
 *   process). One line per check, ok / warn / alert; exit 0 when nothing alerts, 1 when something
 *   does, 2 for a usage error or a database it cannot read. A warn never changes the exit code.
 *     tsx scripts/live.ts health [--json] [--limit NAME=VALUE]... [--monthly-codex-units N]
 *       [--max-codex-units-per-day N]
 *   --limit overrides one limit of `HealthLimits` (src/live/health.ts) and may be repeated.
 *
 * Run it from the `ingest` directory (`pnpm -C ingest exec tsx scripts/live.ts ...`), with
 * DATABASE_URL, CODEX_API_KEY and HELIUS_API_KEY (and JUPITER_API_KEY if you have one) in the
 * environment (nothing prints them).
 *
 * What it does, every pass: every 5 minutes it asks Codex.io for pump.fun graduates since the
 * cursor and stores the new ones; it reads the price of every coin that graduated in the last 14
 * days and has not been fetched (Jupiter, 100 mints a request) and queues a coin for its candles,
 * metrics and metadata when its market cap reaches $90,000; once a UTC day it reads discovery
 * again for 48 hours and queues the candle stage for every such coin a day old or more.
 *
 * The daily ceiling: --max-codex-units-per-day (default 40,000) is always in force. When the UTC
 * day's Codex.io units reach it, discovery and candle fetches pause until the next UTC day (the
 * log says so); the price watch, which costs Codex.io nothing, goes on.
 *
 * One pipeline process per database: `live run --confirm` and `backfill run --confirm` take the
 * same lock, and the second to start refuses.
 *
 * Stop with Ctrl-C or SIGTERM: what is running finishes, then it exits 0. A second signal exits at
 * once. Starting it again continues from the cursor.
 */
import { parseArgs } from 'node:util';
import { createReadOnlyDb } from '@memecoinipedia/db';
import { collectLiveStatus, formatLiveStatus } from '../src/live/status.js';
import {
  applyLimitOverrides,
  formatHealth,
  healthExitCode,
  runHealth,
} from '../src/live/health.js';
import { runLive } from '../src/live/run.js';
import { installStopSignals } from '../src/shared/signals.js';
import { consoleLogger, secretsFromEnv } from '../src/worker/log.js';

function usage(message?: string): never {
  if (message) process.stderr.write(`${message}\n\n`);
  process.stderr.write(
    'Usage: live.ts run [--max-codex-units-per-day N] [--codex-rps N] [--gateway-rps N]\n' +
      '                   [--max-attempts N] [--graduates-per-day N] [--confirm]\n' +
      '       live.ts status\n' +
      '       live.ts health [--json] [--limit NAME=VALUE]... [--monthly-codex-units N]\n' +
      '                      [--max-codex-units-per-day N]\n',
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
  if (command === '--help' || command === '-h') usage();
  if (command !== 'run' && command !== 'status' && command !== 'health')
    usage(command ? `Unknown command "${command}"` : undefined);
  const { values } = parseArgs({
    args: rest,
    options: {
      'max-codex-units-per-day': { type: 'string' },
      'codex-rps': { type: 'string' },
      'gateway-rps': { type: 'string' },
      'max-attempts': { type: 'string' },
      'graduates-per-day': { type: 'string' },
      confirm: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      limit: { type: 'string', multiple: true },
      'monthly-codex-units': { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (values.help) usage();
  const log = consoleLogger({ secrets: secretsFromEnv(process.env) });
  const out = (text: string) => process.stdout.write(`${text}\n`);

  if (command === 'status') {
    const url = process.env['DATABASE_URL'];
    if (!url) usage('DATABASE_URL is not set');
    const db = createReadOnlyDb(url);
    try {
      out(formatLiveStatus(await collectLiveStatus(db)));
    } finally {
      await db.destroy();
    }
    return;
  }

  if (command === 'health') {
    const url = process.env['DATABASE_URL'];
    if (!url) usage('DATABASE_URL is not set');
    let limits;
    try {
      limits = applyLimitOverrides(values.limit ?? []);
    } catch (err) {
      usage((err as Error).message);
    }
    const monthly = positive('--monthly-codex-units', values['monthly-codex-units'], false);
    const ceiling = positive('--max-codex-units-per-day', values['max-codex-units-per-day'], false);
    const now = new Date();
    let report;
    try {
      const db = createReadOnlyDb(url);
      try {
        report = await runHealth(db, now, limits, {
          ...(monthly !== undefined ? { monthlyCodexUnits: monthly } : {}),
          ...(ceiling !== undefined ? { maxCodexUnitsPerDay: ceiling } : {}),
        });
      } finally {
        await db.destroy();
      }
    } catch (err) {
      let text = err instanceof Error ? err.message : String(err);
      for (const s of secretsFromEnv(process.env))
        if (s.length >= 6) text = text.split(s).join('[redacted]');
      process.stderr.write(`health: cannot read the database: ${text}\n`);
      process.exit(2);
    }
    out(values.json ? JSON.stringify(report) : formatHealth(report));
    process.exitCode = healthExitCode(report);
    return;
  }

  const maxCodexUnits = positive(
    '--max-codex-units-per-day',
    values['max-codex-units-per-day'],
    false,
  );
  const rps = positive('--codex-rps', values['codex-rps'], false);
  const gatewayRps = positive('--gateway-rps', values['gateway-rps'], false);
  const maxAttempts = positive('--max-attempts', values['max-attempts']);
  const graduates = positive('--graduates-per-day', values['graduates-per-day'], false);

  const report = await runLive({
    ...(maxCodexUnits !== undefined ? { maxCodexUnitsPerDay: maxCodexUnits } : {}),
    ...(rps !== undefined ? { codexRps: rps } : {}),
    ...(gatewayRps !== undefined ? { gatewayRps } : {}),
    ...(maxAttempts !== undefined ? { maxAttempts } : {}),
    ...(graduates !== undefined ? { graduatesPerDay: graduates } : {}),
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
  process.stderr.write(`live failed: ${text}\n`);
  process.exit(1);
});
