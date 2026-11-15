/**
 * Downloads the candidate list (`discovery.sql`, run once on Dune) as one CSV, then sizes the
 * target set and draws the Phase A sample. Issues #21 and #23.
 *
 * Run from the `ingest` directory (that is where `tsx` resolves):
 *   node --env-file=/path/to/.env --import tsx scripts/dune-discovery.ts --max-credits 600 [--confirm]
 *
 * Arguments
 *   --sql FILE                 the query. Default ingest/sql/dune/discovery.sql. It takes no placeholders
 *   --out DIR                  where the files go. Default data/dune (git-ignored)
 *   --max-credits N            the most this run may spend, in Dune credits. Required with --confirm
 *   --performance small|medium|large   Dune engine tier. Default medium
 *   --probes FILE              probe coins. Default probes/coins.json
 *   --time-limit-minutes N     cancel the execution after this long. Default 10
 *   --execution-id ID          use a finished execution instead of running the SQL again
 *   --columns LIST             comma-separated columns to download (must include mint, created_at, graduated_at)
 *   --filter EXPR              a WHERE-style filter for the download (Dune's `filters=`)
 *   --page-rows N              rows per download page, 1 to 32000. Default 32000
 *   --confirm                  without it the script prints the plan and exits, sending nothing
 *
 * Without `--confirm` no client is built and nothing is sent. With it: read the usage figures,
 * execute (unless an execution id is given or saved), wait, then download page by page into
 * `discovery.csv.part`, one header row, and rename it to `discovery.csv` when the last page is in.
 * After every page a state file next to the part file records the execution id and the next
 * offset, so a stopped run continues from the next page and never pays for a page twice. Dune bills
 * a page when the request is made, so a page is never requested without being saved.
 *
 * If `discovery.csv` exists, Dune is skipped (no key needed) and the script goes straight to the
 * sizing table and `sample.csv`.
 *
 * The key comes from DUNE_API_KEY, and is never printed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  drawSample,
  formatSizingTable,
  readGraduatesFile,
  sampleToCsv,
  sizeTargetSet,
  sizeTotals,
} from '../src/discovery/index.js';
import { BudgetExceededError, UnitBudget } from '../src/sources/budget.js';
import {
  DUNE_MAX_PAGE_ROWS,
  DUNE_PROVIDER,
  DuneClient,
  duneApiKeyFromEnv,
  duneErrorMessage,
  renderSql,
  templatePlaceholders,
  type DunePerformance,
} from '../src/sources/dune/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

/** Credits assumed for a page before one has been measured. */
export const FIRST_PAGE_HEADROOM = 60;
/** Dune's CSV pages cost about this many credits per 1,000 rows of this shape (seen live). */
export const CREDITS_PER_1000_ROWS = 1.6;

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export interface RunnerArgs {
  sql: string;
  out: string;
  maxCredits: number | null;
  performance: DunePerformance;
  probes: string;
  timeLimitMinutes: number;
  executionId: string | null;
  columns: string[] | null;
  filter: string | null;
  pageRows: number;
  confirm: boolean;
}

const KNOWN = [
  '--sql',
  '--out',
  '--max-credits',
  '--performance',
  '--probes',
  '--time-limit-minutes',
  '--execution-id',
  '--columns',
  '--filter',
  '--page-rows',
];

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
    if (!KNOWN.includes(a)) throw new UsageError(`Unknown argument ${a}`);
    const v = argv[++i];
    if (v === undefined || v.startsWith('--')) throw new UsageError(`${a} needs a value`);
    values.set(a, v);
  }
  const performance = values.get('--performance') ?? 'medium';
  if (!['small', 'medium', 'large'].includes(performance)) {
    throw new UsageError('--performance must be small, medium or large');
  }
  const maxCredits = values.has('--max-credits')
    ? positive('--max-credits', values.get('--max-credits') as string)
    : null;
  if (confirm && maxCredits === null)
    throw new UsageError('--max-credits is required with --confirm');
  const pageRows = values.has('--page-rows')
    ? positive('--page-rows', values.get('--page-rows') as string)
    : DUNE_MAX_PAGE_ROWS;
  if (!Number.isInteger(pageRows) || pageRows > DUNE_MAX_PAGE_ROWS) {
    throw new UsageError(`--page-rows must be a whole number up to ${DUNE_MAX_PAGE_ROWS}`);
  }
  const executionId = values.get('--execution-id') ?? null;
  if (executionId !== null && !/^[A-Za-z0-9_-]{8,64}$/.test(executionId)) {
    throw new UsageError('--execution-id has an unexpected format');
  }
  const columns = values.get('--columns')?.split(',') ?? null;
  if (columns?.some((c) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(c))) {
    throw new UsageError('--columns must be a comma-separated list of column names');
  }
  const abs = (v: string | undefined, fallback: string) =>
    v ? path.resolve(v) : path.join(REPO, fallback);
  return {
    sql: abs(values.get('--sql'), 'ingest/sql/dune/discovery.sql'),
    out: abs(values.get('--out'), 'data/dune'),
    maxCredits,
    performance: performance as DunePerformance,
    probes: abs(values.get('--probes'), 'probes/coins.json'),
    timeLimitMinutes: values.has('--time-limit-minutes')
      ? positive('--time-limit-minutes', values.get('--time-limit-minutes') as string)
      : 10,
    executionId,
    columns,
    filter: values.get('--filter') ?? null,
    pageRows,
    confirm,
  };
}

export const discoveryFile = (out: string): string => path.join(out, 'discovery.csv');
export const partFile = (out: string): string => path.join(out, 'discovery.csv.part');
export const stateFile = (out: string): string => path.join(out, 'discovery.csv.part.state.json');

// State ----------------------------------------------------------------

export interface RunState {
  executionId: string;
  /** Offset of the next page to request. */
  nextOffset: number;
  /** Size of the part file after the last complete page. */
  partBytes: number;
  rows: number;
  pages: number;
  /** Credits recorded for the last page, for the stop rule. Null before the first page. */
  lastPageCredits: number | null;
  columns: string[] | null;
  filter: string | null;
}

function readState(file: string): RunState | null {
  if (!fs.existsSync(file)) return null;
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<RunState>;
    if (
      typeof s.executionId === 'string' &&
      Number.isInteger(s.nextOffset) &&
      Number.isInteger(s.partBytes)
    ) {
      return {
        executionId: s.executionId,
        nextOffset: s.nextOffset as number,
        partBytes: s.partBytes as number,
        rows: typeof s.rows === 'number' ? s.rows : 0,
        pages: typeof s.pages === 'number' ? s.pages : 0,
        lastPageCredits: typeof s.lastPageCredits === 'number' ? s.lastPageCredits : null,
        columns: Array.isArray(s.columns) ? (s.columns as string[]) : null,
        filter: typeof s.filter === 'string' ? s.filter : null,
      };
    }
  } catch {
    // fall through
  }
  throw new UsageError(
    `The state file ${file} is unreadable. Delete it and the .part file to start over.`,
  );
}

/** Written to a temporary file and renamed, so a crash never leaves half a state file. */
function writeState(file: string, state: RunState): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

// Plan -----------------------------------------------------------------

export interface Plan {
  csvExists: boolean;
  sqlExists: boolean;
  resumable: RunState | null;
  text: string;
}

/** What a run would do. Reads the disk only. Makes no call. */
export function buildPlan(args: RunnerArgs): Plan {
  const csvExists = fs.existsSync(discoveryFile(args.out));
  const sqlExists = fs.existsSync(args.sql);
  let resumable: RunState | null = null;
  const lines = ['Dry-run plan. Nothing was sent to Dune. Add --confirm to run it.'];
  try {
    resumable = readState(stateFile(args.out));
  } catch (err) {
    lines.push(err instanceof Error ? err.message : 'state file unreadable');
  }
  if (csvExists) {
    lines.push(
      `${discoveryFile(args.out)} exists: Dune would be skipped, and the sizing table and sample.csv written from it.`,
    );
  } else {
    lines.push(
      `SQL: ${args.sql} (${sqlExists ? 'found' : 'MISSING: the run would fail at once'})`,
      `Performance tier: ${args.performance}; time limit ${args.timeLimitMinutes} minutes`,
      args.executionId
        ? 'Execution: reuse the given execution id; the SQL is not run again.'
        : resumable
          ? `Execution: resume the saved one (next offset ${resumable.nextOffset}, ${resumable.rows} rows already saved).`
          : 'Execution: run the SQL once. Its cost is unknown until it has run (Dune bills by compute).',
      `Download: ${args.pageRows} rows a page, into ${partFile(args.out)}, renamed when the last page is in.`,
      'The number of rows is not known before the run. A download costs about ' +
        `${CREDITS_PER_1000_ROWS} credits per 1,000 rows, so 350,000 rows would be about ` +
        `${Math.round(350 * CREDITS_PER_1000_ROWS)} credits.`,
      `Credit ceiling: ${args.maxCredits === null ? 'not set (required with --confirm)' : args.maxCredits}. ` +
        `A page is not requested when the credits left are below the last page's cost (or ${FIRST_PAGE_HEADROOM} for the first).`,
    );
    if (sqlExists) {
      try {
        const names = templatePlaceholders(fs.readFileSync(args.sql, 'utf8'));
        if (names.length > 0)
          lines.push(`The SQL has placeholders (${names.join(', ')}); it must have none.`);
      } catch (err) {
        lines.push(`SQL problem: ${err instanceof Error ? err.message : 'error'}`);
      }
    }
  }
  return { csvExists, sqlExists, resumable, text: lines.join('\n') };
}

// Run ------------------------------------------------------------------

export type RunStatus = 'complete' | 'stopped_budget' | 'failed';

export interface RunSummary {
  status: RunStatus;
  pages: number;
  rows: number;
  /** Credits recorded in the budget by this run. */
  totalCredits: number;
  message: string | null;
}

export interface RunOptions {
  args: RunnerArgs;
  client: DuneClient;
  log?: (line: string) => void;
}

/**
 * Executes (or reuses an execution), waits, and downloads the pages. `client.budget` is the
 * budget: its ceiling is `--max-credits`. Never throws for a Dune or budget problem: it stops and
 * says why in the summary.
 */
export async function runDiscovery(opts: RunOptions): Promise<RunSummary> {
  const { args, client } = opts;
  const log = opts.log ?? ((l: string) => console.log(l));
  const budget = client.budget;
  const total = () => budget.summary(DUNE_PROVIDER).units;
  let pages = 0;
  let rows = 0;
  const done = (status: RunStatus, message: string | null): RunSummary => ({
    status,
    pages,
    rows,
    totalCredits: total(),
    message,
  });
  const remaining = () => budget.summary(DUNE_PROVIDER).remaining ?? Number.POSITIVE_INFINITY;

  if (fs.existsSync(discoveryFile(args.out))) return done('complete', null);
  if (!fs.existsSync(args.sql)) return done('failed', `SQL file not found: ${args.sql}`);
  let sql: string;
  try {
    const template = fs.readFileSync(args.sql, 'utf8');
    const names = templatePlaceholders(template);
    if (names.length > 0) {
      return done('failed', `The SQL has placeholders (${names.join(', ')}); it must have none.`);
    }
    sql = renderSql(template, {});
  } catch (err) {
    return done('failed', err instanceof Error ? err.message : 'SQL template error');
  }
  fs.mkdirSync(args.out, { recursive: true });

  let state: RunState | null;
  try {
    state = readState(stateFile(args.out));
  } catch (err) {
    return done('failed', err instanceof Error ? err.message : 'state file unreadable');
  }
  if (state && args.executionId && state.executionId !== args.executionId) {
    return done(
      'failed',
      'The saved state is for a different execution than --execution-id. Delete the state and .part file, or drop --execution-id.',
    );
  }
  if (
    state &&
    (JSON.stringify(state.columns) !== JSON.stringify(args.columns) || state.filter !== args.filter)
  ) {
    return done(
      'failed',
      'The saved state used other --columns or --filter. Use the same ones, or delete the state and .part file.',
    );
  }

  // Usage is free; it is read before and after to compare with the ledger.
  const usedNow = async (): Promise<number | null> => {
    try {
      return (await client.usage())?.current?.creditsUsed ?? null;
    } catch {
      return null;
    }
  };
  const usageStart = await usedNow();
  if (usageStart !== null) log(`Credits used this billing period before the run: ${usageStart}`);

  let executionId = args.executionId ?? state?.executionId ?? null;
  try {
    if (executionId === null) {
      const started = await client.executeSql(sql, {
        maxCredits: remaining(),
        performance: args.performance,
      });
      if (started.status !== 'started') return done('failed', 'client is in dry-run mode');
      executionId = started.executionId;
      writeState(stateFile(args.out), {
        executionId,
        nextOffset: 0,
        partBytes: 0,
        rows: 0,
        pages: 0,
        lastPageCredits: null,
        columns: args.columns,
        filter: args.filter,
      });
      log('Execution started.');
    } else {
      log('Reusing a finished execution; the SQL is not run again.');
    }
    const waited = await client.waitForExecution(executionId, {
      timeLimitMs: args.timeLimitMinutes * 60_000,
    });
    if (waited.outcome !== 'completed') {
      if (waited.outcome !== 'dry_run' && waited.outcome !== 'partial') {
        fs.rmSync(stateFile(args.out), { force: true });
      }
      const why =
        waited.outcome === 'failed'
          ? `failed: ${waited.error}`
          : waited.outcome === 'timed_out'
            ? `timed out after ${args.timeLimitMinutes} minutes and was cancelled (cost ${waited.chargedCredits ?? 'unknown'} credits)`
            : waited.outcome;
      return done('failed', `The execution ${why}`);
    }
    log(
      `Execution complete: ${waited.rowCount ?? '?'} rows, ${waited.resultBytes ?? '?'} bytes of result, ` +
        `cost ${waited.reportedCredits ?? 'not reported'} credits.`,
    );
  } catch (err) {
    return done('failed', duneErrorMessage(err));
  }

  // Download, page by page.
  const part = partFile(args.out);
  let offset = state?.nextOffset ?? 0;
  let lastCost = state?.lastPageCredits ?? null;
  rows = state?.rows ?? 0;
  pages = state?.pages ?? 0;
  if (offset === 0) fs.rmSync(part, { force: true });
  else {
    const size = fs.existsSync(part) ? fs.statSync(part).size : -1;
    if (size < (state?.partBytes ?? 0)) {
      return done(
        'failed',
        `The part file is missing or shorter than the state says. Delete the state and .part file to start over.`,
      );
    }
    fs.truncateSync(part, state?.partBytes ?? 0); // drop anything a crashed page left behind
  }
  for (;;) {
    const need = lastCost ?? FIRST_PAGE_HEADROOM;
    if (remaining() < need) {
      return done(
        'stopped_budget',
        `Stopped before offset ${offset}: ${Math.round(remaining() * 100) / 100} credits left, below ${need} ` +
          `(${lastCost === null ? 'the first-page headroom' : 'the cost of the previous page'}). Run again with a higher --max-credits to continue from here.`,
      );
    }
    try {
      const before = await usedNow();
      const page = await client.downloadCsv(executionId, part, {
        limit: args.pageRows,
        offset,
        ...(args.columns ? { columns: args.columns } : {}),
        ...(args.filter !== null ? { filters: args.filter } : {}),
        measureCredits: async () => {
          const after = await usedNow();
          return before !== null && after !== null
            ? Math.round((after - before) * 1000) / 1000
            : null;
        },
      });
      if (page.status !== 'downloaded') return done('failed', 'client is in dry-run mode');
      pages++;
      rows += page.rows;
      lastCost = page.credits;
      log(
        `page ${pages}: offset ${offset}, rows ${page.rows}, bytes ${page.bytes}, credits ${page.credits} ` +
          `(${page.estimated ? 'estimated' : 'measured'}), running total ${total()}`,
      );
      if (page.nextOffset === null) {
        fs.renameSync(part, discoveryFile(args.out));
        fs.rmSync(stateFile(args.out), { force: true });
        break;
      }
      offset = page.nextOffset;
      writeState(stateFile(args.out), {
        executionId,
        nextOffset: offset,
        partBytes: fs.statSync(part).size,
        rows,
        pages,
        lastPageCredits: lastCost,
        columns: args.columns,
        filter: args.filter,
      });
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        return done('stopped_budget', `Stopped before offset ${offset}: ${err.message}`);
      }
      return done('failed', `Download stopped before offset ${offset}: ${duneErrorMessage(err)}`);
    }
  }
  const usageEnd = await usedNow();
  if (usageStart !== null && usageEnd !== null) {
    log(
      `Usage endpoint: ${Math.round((usageEnd - usageStart) * 1000) / 1000} credits used during the run. ` +
        `Ledger: ${total()}.`,
    );
  }
  return done('complete', null);
}

/** Sizing table and sample, from `discovery.csv`. */
export async function sizeAndSample(
  args: RunnerArgs,
  log: (line: string) => void = (l) => console.log(l),
): Promise<void> {
  const { rows, records, bad } = await readGraduatesFile(discoveryFile(args.out));
  log(`Read ${records} rows: ${rows.length} kept, ${bad.count} rejected.`);
  for (const b of bad.stored.slice(0, 10)) log(`  rejected, line ${b.line}: ${b.reason}`);
  if (bad.count > 10) log(`  ...and ${bad.count - 10} more rejected rows`);
  log(formatSizingTable(sizeTargetSet(rows), sizeTotals(rows)));

  const probeList = JSON.parse(fs.readFileSync(args.probes, 'utf8')) as Array<{ mint?: unknown }>;
  const probes = probeList.flatMap((p) => (typeof p.mint === 'string' ? [p.mint] : []));
  const sample = drawSample(rows, { probes });
  const out = path.join(args.out, 'sample.csv');
  fs.writeFileSync(out, sampleToCsv(sample));
  const counts = new Map<string, number>();
  for (const s of sample) {
    const key = s.probe ? 'probe' : `${s.halfYear} ${s.cell}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const [k, n] of [...counts].sort()) log(`  ${k}: ${n}`);
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

  if (!plan.csvExists) {
    let client: DuneClient;
    try {
      client = new DuneClient({
        apiKey: duneApiKeyFromEnv(env),
        budget: new UnitBudget({ ceilingUnits: args.maxCredits as number }),
      });
    } catch (err) {
      console.error(err instanceof Error ? err.message : 'cannot build the client');
      return 2;
    }
    const summary = await runDiscovery({ args, client });
    console.log(
      `Pages ${summary.pages}, rows ${summary.rows}, credits recorded ${summary.totalCredits}.`,
    );
    if (summary.status !== 'complete') {
      console.error(summary.message ?? summary.status);
      return summary.status === 'stopped_budget' ? 3 : 1;
    }
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
