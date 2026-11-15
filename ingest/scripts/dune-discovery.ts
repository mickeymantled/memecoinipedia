/**
 * Runs the graduates query (`graduates.sql`, issue #21) one launch month at a time, saves each
 * month's CSV, then sizes the target set and draws the Phase A sample. Issue #23.
 *
 * Run from the `ingest` directory (that is where `tsx` resolves):
 *   node --env-file=/path/to/.env --import tsx scripts/dune-discovery.ts \
 *     --from 2024-01 --to 2026-10 --max-credits 500 [--confirm]
 *
 * Arguments
 *   --from YYYY-MM, --to YYYY-MM   first and last launch month, both included (required)
 *   --window-days N                days of trading to look at after a month ends. Default 90
 *   --max-credits N                the most this run may spend, in Dune credits. Required to run
 *   --export-rate N                credits per MB exported. Default 10 (Analyst); Plus is 2
 *   --performance small|medium|large   Dune engine tier. Default medium
 *   --out DIR                      where the CSVs and the sample go. Default data/dune (git-ignored)
 *   --sql FILE                     the query template. Default ingest/sql/dune/graduates.sql
 *   --probes FILE                  probe coins. Default probes/coins.json
 *   --min-headroom N               credits that must be left before the first month. Default 50
 *   --confirm                      without it the script prints the plan and exits, making no call
 *
 * Without `--confirm` no client is built and nothing is sent. With it, for each month whose file
 * is not on disk: render the SQL, execute, wait, download to `<file>.part`, and rename into place
 * only when complete. It stops before a month when the credits left are below the largest month
 * so far (or below `--min-headroom` when no month has run yet).
 *
 * The key comes from DUNE_API_KEY, and is never printed.
 *
 * Template placeholders it can fill (a template may use any of them, and no others):
 *   {{month_start}}  first day of the month, a date         {{month_end}}  first day of the next month
 *   {{window_end}}   month_end plus the window, a date      {{window_days}} the window, a number
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  drawSample,
  formatSizingTable,
  readGraduatesFiles,
  sampleToCsv,
  sizeTargetSet,
} from '../src/discovery/index.js';
import { BudgetExceededError, UnitBudget } from '../src/sources/budget.js';
import {
  DUNE_PROVIDER,
  DuneClient,
  duneApiKeyFromEnv,
  renderSql,
  templatePlaceholders,
  type DunePerformance,
} from '../src/sources/dune/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

/** CSV text can be larger than Dune's raw size figure; allow this much more before cutting off. */
export const CSV_SIZE_FACTOR = 1.5;

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export interface RunnerArgs {
  from: string;
  to: string;
  windowDays: number;
  maxCredits: number | null;
  exportRate: number;
  performance: DunePerformance;
  out: string;
  sql: string;
  probes: string;
  minHeadroom: number;
  confirm: boolean;
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

function positive(name: string, text: string): number {
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`${name} must be a positive number`);
  return n;
}

export function parseRunnerArgs(argv: readonly string[]): RunnerArgs {
  const values = new Map<string, string>();
  let confirm = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--confirm') {
      confirm = true;
      continue;
    }
    const known = [
      '--from',
      '--to',
      '--window-days',
      '--max-credits',
      '--export-rate',
      '--performance',
      '--out',
      '--sql',
      '--probes',
      '--min-headroom',
    ];
    if (!known.includes(a)) throw new UsageError(`Unknown argument ${a}`);
    const v = argv[++i];
    if (v === undefined || v.startsWith('--')) throw new UsageError(`${a} needs a value`);
    values.set(a, v);
  }
  const from = values.get('--from');
  const to = values.get('--to');
  if (!from || !to) throw new UsageError('--from and --to are required (YYYY-MM)');
  if (!MONTH.test(from) || !MONTH.test(to)) throw new UsageError('--from and --to must be YYYY-MM');
  if (from > to) throw new UsageError('--from is after --to');
  const performance = values.get('--performance') ?? 'medium';
  if (!['small', 'medium', 'large'].includes(performance)) {
    throw new UsageError('--performance must be small, medium or large');
  }
  const windowDays = values.has('--window-days')
    ? positive('--window-days', values.get('--window-days')!)
    : 90;
  if (!Number.isInteger(windowDays) || windowDays > 3650) {
    throw new UsageError('--window-days must be a whole number up to 3650');
  }
  const maxCredits = values.has('--max-credits')
    ? positive('--max-credits', values.get('--max-credits')!)
    : null;
  if (confirm && maxCredits === null)
    throw new UsageError('--max-credits is required with --confirm');
  const abs = (v: string | undefined, fallback: string) =>
    v ? path.resolve(v) : path.join(REPO, fallback);
  return {
    from,
    to,
    windowDays,
    maxCredits,
    exportRate: values.has('--export-rate')
      ? positive('--export-rate', values.get('--export-rate')!)
      : 10,
    performance: performance as DunePerformance,
    out: abs(values.get('--out'), 'data/dune'),
    sql: abs(values.get('--sql'), 'ingest/sql/dune/graduates.sql'),
    probes: abs(values.get('--probes'), 'probes/coins.json'),
    minHeadroom: values.has('--min-headroom')
      ? positive('--min-headroom', values.get('--min-headroom')!)
      : 50,
    confirm,
  };
}

/** `YYYY-MM` from `from` to `to`, both included. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const last = to;
  for (;;) {
    const label = `${y}-${String(m).padStart(2, '0')}`;
    if (label > last) break;
    out.push(label);
    if (m === 12) {
      y++;
      m = 1;
    } else m++;
  }
  return out;
}

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The values for the placeholders a template uses. Throws on a placeholder it cannot fill. */
export function monthParams(
  month: string,
  windowDays: number,
  names: readonly string[],
): Record<string, string | number> {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const start = Date.UTC(y, m - 1, 1);
  const end = Date.UTC(y, m, 1);
  const all: Record<string, string | number> = {
    month_start: iso(start),
    month_end: iso(end),
    window_end: iso(end + windowDays * 86_400_000),
    window_days: windowDays,
  };
  const unsupported = names.filter((n) => !(n in all));
  if (unsupported.length > 0) {
    throw new UsageError(
      `The SQL template uses placeholders this script cannot fill: ${unsupported.join(', ')}. ` +
        `It can fill: ${Object.keys(all).join(', ')}`,
    );
  }
  return Object.fromEntries(names.map((n) => [n, all[n] as string | number]));
}

export const monthFile = (out: string, month: string): string =>
  path.join(out, `graduates-${month}.csv`);

// Plan -----------------------------------------------------------------

export interface Plan {
  months: string[];
  existing: string[];
  toRun: string[];
  sqlExists: boolean;
  text: string;
}

/** What a run would do. Reads the disk only. Makes no call. */
export function buildPlan(args: RunnerArgs): Plan {
  const months = monthsBetween(args.from, args.to);
  const existing = months.filter((m) => fs.existsSync(monthFile(args.out, m)));
  const toRun = months.filter((m) => !existing.includes(m));
  const sqlExists = fs.existsSync(args.sql);
  const lines = [
    'Dry-run plan. Nothing was sent to Dune. Add --confirm to run it.',
    `Months: ${args.from} to ${args.to} (${months.length})`,
    `Output directory: ${args.out}`,
    `Already on disk (skipped): ${existing.length === 0 ? 'none' : existing.join(', ')}`,
    `Would run: ${toRun.length === 0 ? 'nothing' : toRun.join(', ')}`,
    `SQL: ${args.sql} (${sqlExists ? 'found' : 'MISSING: the run would fail at once'})`,
    `Performance tier: ${args.performance}; window ${args.windowDays} days; export rate ${args.exportRate} credits per MB`,
    `Credit ceiling: ${args.maxCredits === null ? 'not set (required with --confirm)' : args.maxCredits}`,
    'Execution cost is unknown until a month has run (Dune bills by compute); each month reserves',
    'the credits left, then records the cost Dune reports. Each export costs size in MB, rounded up, times the rate.',
  ];
  if (sqlExists) {
    try {
      const template = fs.readFileSync(args.sql, 'utf8');
      const first = toRun[0] ?? months[0];
      if (first) {
        renderSql(template, monthParams(first, args.windowDays, templatePlaceholders(template)));
        lines.push(`SQL template renders for ${first}.`);
      }
    } catch (err) {
      lines.push(`SQL template does not render: ${err instanceof Error ? err.message : 'error'}`);
    }
  }
  return { months, existing, toRun, sqlExists, text: lines.join('\n') };
}

// Run ------------------------------------------------------------------

export type RunStatus = 'complete' | 'stopped_budget' | 'failed';

export interface RunSummary {
  status: RunStatus;
  ran: string[];
  skipped: string[];
  /** Credits recorded in the budget. */
  totalCredits: number;
  message: string | null;
}

export interface RunMonthsOptions {
  args: RunnerArgs;
  client: DuneClient;
  log?: (line: string) => void;
}

/**
 * The month loop. `client.budget` is the budget: its ceiling is `--max-credits`.
 * Never throws for a Dune or budget problem: it stops and says why in the summary.
 */
export async function runMonths(opts: RunMonthsOptions): Promise<RunSummary> {
  const { args, client } = opts;
  const log = opts.log ?? ((l: string) => console.log(l));
  const budget = client.budget;
  const months = monthsBetween(args.from, args.to);
  const ran: string[] = [];
  const skipped: string[] = [];
  const total = () => budget.summary(DUNE_PROVIDER).units;
  const done = (status: RunStatus, message: string | null): RunSummary => ({
    status,
    ran,
    skipped,
    totalCredits: total(),
    message,
  });

  if (!fs.existsSync(args.sql)) {
    return done('failed', `SQL file not found: ${args.sql}`);
  }
  const template = fs.readFileSync(args.sql, 'utf8');
  const names = templatePlaceholders(template);
  // Render every month first: a bad template should fail before anything is spent.
  const sqlFor = new Map<string, string>();
  try {
    for (const m of months)
      sqlFor.set(m, renderSql(template, monthParams(m, args.windowDays, names)));
  } catch (err) {
    return done('failed', err instanceof Error ? err.message : 'SQL template error');
  }
  fs.mkdirSync(args.out, { recursive: true });

  let largest = 0;
  for (const month of months) {
    const final = monthFile(args.out, month);
    if (fs.existsSync(final)) {
      skipped.push(month);
      log(`${month}: already on disk, skipped`);
      continue;
    }
    const remaining = budget.summary(DUNE_PROVIDER).remaining ?? Number.POSITIVE_INFINITY;
    const needed = largest > 0 ? largest : args.minHeadroom;
    if (remaining < needed) {
      return done(
        'stopped_budget',
        `Stopped before ${month}: ${remaining} credits left, below ${needed} ` +
          `(${largest > 0 ? 'the largest month so far' : '--min-headroom'}).`,
      );
    }
    const before = total();
    let executionId = '';
    try {
      const started = await client.executeSql(sqlFor.get(month) as string, {
        maxCredits: remaining,
        performance: args.performance,
      });
      if (started.status !== 'started') return done('failed', 'client is in dry-run mode');
      executionId = started.executionId;
      const waited = await client.waitForExecution(executionId);
      if (waited.outcome !== 'completed') {
        const why =
          waited.outcome === 'failed'
            ? `failed: ${waited.error}`
            : waited.outcome === 'dry_run'
              ? 'dry run'
              : waited.outcome;
        return done('failed', `${month}: execution ${executionId} ${why}`);
      }
      const execCredits = waited.chargedCredits ?? 0;
      const part = `${final}.part`;
      let bytes = 0;
      let exportCredits = 0;
      if (waited.rowCount === 0 || waited.resultBytes === 0) {
        // Nothing to download. A header-only file marks the month as done.
        fs.writeFileSync(part, waited.columns.join(',') + '\n');
        bytes = fs.statSync(part).size;
      } else {
        if (waited.resultBytes === null) {
          return done(
            'failed',
            `${month}: Dune did not report the result size, so the download was refused (execution ${executionId})`,
          );
        }
        const dl = await client.downloadCsv(executionId, part, {
          resultBytes: waited.resultBytes,
          maxBytes: Math.ceil(waited.resultBytes * CSV_SIZE_FACTOR),
        });
        if (dl.status !== 'downloaded') return done('failed', 'client is in dry-run mode');
        bytes = dl.bytes;
        exportCredits = dl.credits;
      }
      fs.renameSync(part, final);
      ran.push(month);
      largest = Math.max(largest, total() - before);
      log(
        `${month}: rows ${waited.rowCount ?? '?'}, bytes ${bytes}, execution credits ${execCredits}` +
          `${waited.estimated ? ' (estimated)' : ''}, export credits ${exportCredits}, running total ${total()}`,
      );
    } catch (err) {
      fs.rmSync(`${final}.part`, { force: true });
      const where = executionId
        ? ` (execution ${executionId}, its result stays on Dune for 90 days)`
        : '';
      if (err instanceof BudgetExceededError) {
        return done('stopped_budget', `Stopped at ${month}${where}: ${err.message}`);
      }
      return done('failed', `${month}${where}: ${err instanceof Error ? err.message : 'error'}`);
    }
  }
  return done('complete', null);
}

/** Sizing table and sample, from the files on disk. */
export async function sizeAndSample(
  args: RunnerArgs,
  log: (line: string) => void = (l) => console.log(l),
): Promise<void> {
  const files = monthsBetween(args.from, args.to)
    .map((m) => monthFile(args.out, m))
    .filter((p) => fs.existsSync(p));
  const { rows, records, duplicates, bad } = await readGraduatesFiles(files);
  log(
    `Read ${records} rows from ${files.length} files: ${rows.length} kept, ${bad.count} bad, ${duplicates} duplicates.`,
  );
  for (const b of bad.stored.slice(0, 10)) log(`  bad row, line ${b.line}: ${b.reason}`);
  if (bad.count > 10) log(`  ...and ${bad.count - 10} more bad rows`);
  log(formatSizingTable(sizeTargetSet(rows)));

  const probeList = JSON.parse(fs.readFileSync(args.probes, 'utf8')) as Array<{ mint?: unknown }>;
  const probes = probeList.flatMap((p) => (typeof p.mint === 'string' ? [p.mint] : []));
  const sample = drawSample(rows, { probes });
  const out = path.join(args.out, 'sample.csv');
  fs.writeFileSync(out, sampleToCsv(sample));
  const missing = sample.filter((s) => s.probeMissing).length;
  log(
    `Sample: ${sample.length} coins (${probes.length} probes, ${missing} missing from the list) written to ${out}`,
  );
}

export async function main(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Promise<number> {
  let args: RunnerArgs;
  try {
    args = parseRunnerArgs(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : 'bad arguments');
    return 2;
  }
  const plan = buildPlan(args);
  console.log(plan.text);
  if (!args.confirm) return 0;

  let client: DuneClient;
  try {
    client = new DuneClient({
      apiKey: duneApiKeyFromEnv(env),
      budget: new UnitBudget({ ceilingUnits: args.maxCredits as number }),
      exportCreditsPerMb: args.exportRate,
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : 'cannot build the client');
    return 2;
  }
  const summary = await runMonths({ args, client });
  console.log(
    `Ran ${summary.ran.length} months, skipped ${summary.skipped.length}, total credits ${summary.totalCredits}.`,
  );
  if (summary.status !== 'complete') {
    console.error(summary.message ?? summary.status);
    return summary.status === 'stopped_budget' ? 3 : 1;
  }
  await sizeAndSample(args);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), process.env).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : 'unexpected error');
      process.exitCode = 1;
    },
  );
}
