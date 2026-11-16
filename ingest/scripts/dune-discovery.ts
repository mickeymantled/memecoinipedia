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
 * Money. A page is recorded at its rows times the known rate (`DUNE_CREDITS_PER_ROW`), marked
 * estimated, and nothing is added to it later. Dune's usage figure lags, so it is not read page by
 * page. It is read once the download has ended or the run has stopped: the run waits until two
 * reads in a row agree (or `USAGE_SETTLE_LIMIT_MS` passes) and then replaces the estimates with the
 * difference since the run began. See `reconcileUsage` for the cases where it does not.
 *
 * If `discovery.csv` exists, Dune is skipped (no key, no `--confirm`, no `--max-credits` needed) and the
 * script goes straight to the sizing table and `sample.csv`. `--max-credits` is for the whole download:
 * credits recorded by earlier runs of it (kept in the state file) count against it.
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
  DUNE_CREDITS_PER_ROW,
  DUNE_MAX_PAGE_ROWS,
  DUNE_PROVIDER,
  DuneClient,
  duneApiKeyFromEnv,
  duneErrorMessage,
  estimatePageCredits,
  renderSql,
  templatePlaceholders,
  type DunePerformance,
} from '../src/sources/dune/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

/** The known rate per 1,000 rows (see `DUNE_CREDITS_PER_ROW`: 49.1 credits for a 32,000-row page). */
export const CREDITS_PER_1000_ROWS = DUNE_CREDITS_PER_ROW * 1000;

/**
 * How long between two reads of the usage figure while waiting for it to settle. Dune's figure
 * lagged by about two 32,000-row pages in the run that found this (each page takes tens of
 * seconds to download), so two reads that agree must be further apart than a lag of that size.
 * Reads are free, so a long interval costs time, not credits.
 */
export const USAGE_SETTLE_INTERVAL_MS = 30_000;
/**
 * The longest the run waits for the figure to settle, in all. Ten intervals. If the figure has
 * not settled by then the estimates stay and the ledger says so; the run does not wait longer.
 */
export const USAGE_SETTLE_LIMIT_MS = 300_000;
/**
 * How far above the recorded total the settled usage difference may be and still be taken as
 * this run's own spending: the larger of `RECONCILE_MARGIN_MIN` credits and
 * `RECONCILE_MARGIN_FRACTION` of the recorded total. The known rate is itself measured: the two
 * pages measured differ by 7% in credits per row, and the execution's cost is read from Dune
 * rounded, so the estimates can be several percent low without anyone else spending. A larger
 * gap is another job's spending or a figure that has not settled.
 */
export const RECONCILE_MARGIN_MIN = 5;
export const RECONCILE_MARGIN_FRACTION = 0.1;

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
  columns: string[] | null;
  filter: string | null;
  /** Credits recorded for this download so far, across runs. Loaded into the budget on resume. */
  creditsSpent: number;
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
        columns: Array.isArray(s.columns) ? (s.columns as string[]) : null,
        filter: typeof s.filter === 'string' ? s.filter : null,
        creditsSpent: typeof s.creditsSpent === 'number' && s.creditsSpent > 0 ? s.creditsSpent : 0,
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
      `${discoveryFile(args.out)} exists: Dune is skipped, and the sizing table and sample.csv are written from it (no --confirm or --max-credits needed).`,
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
        `${CREDITS_PER_1000_ROWS.toFixed(3)} credits per 1,000 rows, so 350,000 rows would be about ` +
        `${Math.round(350 * CREDITS_PER_1000_ROWS)} credits.`,
      `Credit ceiling: ${args.maxCredits === null ? 'not set (required with --confirm)' : args.maxCredits}, for the whole download (credits recorded by earlier runs of it count too). ` +
        `A page is not requested when the credits left are below the estimate for it (its rows times ${CREDITS_PER_1000_ROWS.toFixed(3)} credits per 1,000 rows). ` +
        "When the download ends or the run stops, Dune's usage figure is read until it settles and replaces the estimates.",
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

/**
 * How the ledger ended up after the usage figure was read at the end of the run.
 * - `replaced`: the settled difference was within the margin of the recorded total; the recorded
 *   figures were replaced by it.
 * - `other_spending`: the settled difference was above the recorded total by more than the margin.
 *   The estimates stay; the gap is spending by something else, or a figure that has not settled.
 * - `below_estimate`: the settled difference is below the recorded total by more than the margin.
 *   The estimates stay: a figure that far under is more likely one that has not caught up than a
 *   run that cost less, and a ledger that is too low is the unsafe direction for a ceiling.
 * - `unsettled`: two reads in a row never agreed before the time limit. The estimates stay.
 * - `unavailable`: the usage figure could not be read (before the run or after it). Estimates stay.
 * - `not_needed`: the run spent nothing, so there was nothing to reconcile.
 */
export type ReconciliationOutcome =
  'replaced' | 'other_spending' | 'below_estimate' | 'unsettled' | 'unavailable' | 'not_needed';

export interface Reconciliation {
  outcome: ReconciliationOutcome;
  /** Credits this run recorded before the reconciliation (the execution and the page estimates). */
  recorded: number;
  /** Usage figure at the end minus usage figure before the run, or null when not known. */
  usageDifference: number | null;
  /** Number of usage reads taken while waiting. */
  reads: number;
  /** The line that is logged. */
  message: string;
}

export interface RunSummary {
  status: RunStatus;
  pages: number;
  rows: number;
  /** Credits in the budget when the run ended, after the reconciliation. */
  totalCredits: number;
  message: string | null;
  reconciliation: Reconciliation;
}

export interface RunOptions {
  args: RunnerArgs;
  client: DuneClient;
  log?: (line: string) => void;
  /** Waits. Default a real timer. Tests pass a fake clock's. */
  sleep?: (ms: number) => Promise<void>;
  /** Milliseconds, monotonic. Default `performance.now()`. */
  now?: () => number;
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Two usage reads agree when they differ by less than the figure's own rounding. */
const agree = (a: number, b: number): boolean => Math.abs(a - b) < 0.0005;

/** How far above the recorded total a settled difference may be and still count as this run's own. */
export function reconcileMargin(recorded: number): number {
  return Math.max(RECONCILE_MARGIN_MIN, RECONCILE_MARGIN_FRACTION * recorded);
}

/**
 * Reads the usage figure with `read` until two reads in a row agree, or until waiting another
 * interval would pass `limitMs`. The first read is at once. Returns the last figure read and
 * whether it settled. A read that fails ends the wait as unsettled (value null when no read
 * worked at all).
 */
export async function settleUsage(
  read: () => Promise<number | null>,
  sleep: (ms: number) => Promise<void>,
  now: () => number,
  intervalMs: number = USAGE_SETTLE_INTERVAL_MS,
  limitMs: number = USAGE_SETTLE_LIMIT_MS,
): Promise<{ value: number | null; settled: boolean; reads: number }> {
  let last = await read();
  let reads = 1;
  if (last === null) return { value: null, settled: false, reads };
  const started = now();
  for (;;) {
    if (now() - started + intervalMs > limitMs) return { value: last, settled: false, reads };
    await sleep(intervalMs);
    const next = await read();
    reads++;
    if (next === null) return { value: last, settled: false, reads };
    if (agree(last, next)) return { value: next, settled: true, reads };
    last = next;
  }
}

/**
 * Executes (or reuses an execution), waits, and downloads the pages. `client.budget` is the
 * budget: its ceiling is `--max-credits`. Never throws for a Dune or budget problem: it stops and
 * says why in the summary.
 *
 * A page is recorded at its rows times the known rate, marked estimated, and never changed by a
 * usage reading taken page by page. When the download ends, or the run stops for any reason after
 * spending something, the usage figure is read until it settles (`settleUsage`) and compared with
 * what this run recorded:
 * - no more than the margin above it, and not more than the margin below it: the recorded figures
 *   are replaced by the difference;
 * - more than the margin below it: the estimates stay (the figure may not have caught up);
 * - more than the margin above it: the ledger keeps the estimates, and the final line says the
 *   difference is spending by something else or a figure that has not settled. It is not
 *   spread over the pages;
 * - never settled, or unreadable: the estimates stay, and the line says so.
 */
export async function runDiscovery(opts: RunOptions): Promise<RunSummary> {
  const { args, client } = opts;
  const log = opts.log ?? ((l: string) => console.log(l));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => performance.now());
  const budget = client.budget;
  const total = () => budget.summary(DUNE_PROVIDER).units;

  // Usage is free. It is read once before anything is spent, and again, settled, at the end.
  const usedNow = async (): Promise<number | null> => {
    try {
      return (await client.usage())?.current?.creditsUsed ?? null;
    } catch {
      return null;
    }
  };
  let usageStart: number | null = null;
  /** The budget just before this run spent anything (earlier runs' credits already loaded). */
  let baseline: { units: number; estimatedUnits: number; requests: number } | null = null;

  const summary = await runBody(opts, log, usedNow, (start) => {
    usageStart = start;
    const b = budget.summary(DUNE_PROVIDER);
    baseline = { units: b.units, estimatedUnits: b.estimatedUnits, requests: b.requests };
  });

  async function reconcile(): Promise<Reconciliation> {
    const b = baseline as { units: number; estimatedUnits: number; requests: number } | null;
    const at = budget.summary(DUNE_PROVIDER);
    const recorded = b === null ? 0 : round3(at.units - b.units);
    const result = (
      outcome: ReconciliationOutcome,
      usageDifference: number | null,
      reads: number,
      message: string,
    ): Reconciliation => ({ outcome, recorded, usageDifference, reads, message });
    if (b === null || at.requests === b.requests) {
      return result(
        'not_needed',
        null,
        0,
        'Nothing was spent by this run, so there is nothing to reconcile.',
      );
    }
    if (usageStart === null) {
      return result(
        'unavailable',
        null,
        0,
        `Usage figure not read before the run, so the ledger cannot be checked: ${recorded} credits recorded, estimated.`,
      );
    }
    const settled = await settleUsage(usedNow, sleep, now);
    if (settled.value === null) {
      return result(
        'unavailable',
        null,
        settled.reads,
        `Usage figure not readable after the run: ${recorded} credits recorded, estimated.`,
      );
    }
    const difference = round3(settled.value - usageStart);
    if (!settled.settled) {
      return result(
        'unsettled',
        difference,
        settled.reads,
        `Usage figure had not settled after ${USAGE_SETTLE_LIMIT_MS / 1000} seconds (${settled.reads} reads; ` +
          `it rose by ${difference} during the run). The estimates stay: ${recorded} credits recorded.`,
      );
    }
    const margin = reconcileMargin(recorded);
    if (difference > recorded + margin) {
      return result(
        'other_spending',
        difference,
        settled.reads,
        `Usage rose by ${difference} credits during the run, ${round3(difference - recorded)} more than the ${recorded} recorded here ` +
          `(margin ${round3(margin)}). The pages stay at their estimates. The difference is spending by something else, ` +
          `or a figure that has not settled; it is not added to the ledger.`,
      );
    }
    if (difference < recorded - margin) {
      return result(
        'below_estimate',
        difference,
        settled.reads,
        `Usage rose by only ${difference} credits during the run, ${round3(recorded - difference)} fewer than the ${recorded} recorded here ` +
          `(margin ${round3(margin)}). The figure may not have caught up, so the estimates stay.`,
      );
    }
    budget.adjust(
      DUNE_PROVIDER,
      difference - recorded,
      round3(at.estimatedUnits - b.estimatedUnits),
    );
    return result(
      'replaced',
      difference,
      settled.reads,
      `Reconciled with Dune's usage figure (settled after ${settled.reads} reads): this run used ${difference} credits; ` +
        `the ${recorded} recorded were replaced by it.`,
    );
  }

  const reconciliation = await reconcile();
  log(reconciliation.message);
  if (reconciliation.outcome === 'replaced' && fs.existsSync(stateFile(args.out))) {
    // A stopped run resumes with what it really spent.
    try {
      const st = readState(stateFile(args.out));
      if (st) writeState(stateFile(args.out), { ...st, creditsSpent: total() });
    } catch {
      // The state file is left as it is.
    }
  }
  return { ...summary, totalCredits: total(), reconciliation };
}

type BodySummary = Omit<RunSummary, 'reconciliation'>;

async function runBody(
  opts: RunOptions,
  log: (line: string) => void,
  usedNow: () => Promise<number | null>,
  began: (usageStart: number | null) => void,
): Promise<BodySummary> {
  const { args, client } = opts;
  const budget = client.budget;
  const total = () => budget.summary(DUNE_PROVIDER).units;
  let pages = 0;
  let rows = 0;
  const done = (status: RunStatus, message: string | null): BodySummary => ({
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

  // The ceiling is for the whole download, not one process: count what earlier runs spent.
  const carried = state?.creditsSpent ?? 0;
  if (carried > 0) {
    budget.record(DUNE_PROVIDER, carried, true);
    log(
      `Earlier runs of this download recorded ${carried} credits; they count against --max-credits.`,
    );
  }

  const usageStart = await usedNow();
  began(usageStart);
  if (usageStart !== null) log(`Credits used this billing period before the run: ${usageStart}`);

  let executionId = args.executionId ?? state?.executionId ?? null;
  let resultRows: number | null | undefined;
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
        columns: args.columns,
        filter: args.filter,
        creditsSpent: total(),
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
    resultRows = waited.rowCount;
    // The execution's cost is now in the ledger: save it, so a resumed run counts it.
    writeState(stateFile(args.out), {
      executionId,
      nextOffset: state?.nextOffset ?? 0,
      partBytes: state?.partBytes ?? 0,
      rows: state?.rows ?? 0,
      pages: state?.pages ?? 0,
      columns: args.columns,
      filter: args.filter,
      creditsSpent: total(),
    });
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
    // The page asks for as many rows as are left when the result size is known, so a small
    // result is estimated as a small page, not as a full one.
    const pageLimit =
      resultRows != null && resultRows > offset
        ? Math.min(args.pageRows, resultRows - offset)
        : args.pageRows;
    const need = estimatePageCredits(pageLimit);
    if (remaining() < need) {
      return done(
        'stopped_budget',
        `Stopped before offset ${offset}: ${Math.round(remaining() * 100) / 100} credits left of the ceiling, below ${need} ` +
          `(the estimate for the next page of ${pageLimit} rows). The ceiling covers the whole download, earlier runs included; run again with a higher --max-credits to continue from here.`,
      );
    }
    try {
      const page = await client.downloadCsv(executionId, part, {
        limit: pageLimit,
        offset,
        ...(args.columns ? { columns: args.columns } : {}),
        ...(args.filter !== null ? { filters: args.filter } : {}),
      });
      if (page.status !== 'downloaded') return done('failed', 'client is in dry-run mode');
      pages++;
      rows += page.rows;
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
        columns: args.columns,
        filter: args.filter,
        creditsSpent: total(),
      });
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        return done('stopped_budget', `Stopped before offset ${offset}: ${err.message}`);
      }
      return done('failed', `Download stopped before offset ${offset}: ${duneErrorMessage(err)}`);
    }
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
  if (!args.confirm) {
    // Reading a file already on disk sends nothing and costs nothing.
    if (plan.csvExists) await sizeAndSample(args);
    return 0;
  }

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
