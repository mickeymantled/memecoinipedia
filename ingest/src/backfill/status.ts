/**
 * The backfill status view: what is selected, where each stage stands, what the providers have
 * been asked for, how fast coins are finishing, what is failing, and how big the database is.
 *
 * It only reads. The script opens its connection with `createReadOnlyDb`, which makes the database
 * refuse every write, and nothing here would write anyway. Which coins are "selected" comes from
 * the most recent backfill run's recorded options unless the caller gives them.
 */
import {
  countFinishedSince,
  countListed,
  databaseSizeBytes,
  openIssuesByKind,
  resolveSelection,
  stageBreakdown,
  topFailureReasons,
  usageWindow,
  type BreakdownStage,
  type Database,
  type ResolvedSelection,
  type SelectionSpec,
  type StageBreakdown,
  type UsageWindow,
} from '@memecoinipedia/db';
import { sql, type Kysely } from 'kysely';
import { METRICS_VERSION } from '../candles/index.js';
import { DEFAULT_STAGE_TIMEOUT_SECONDS } from '../worker/execute.js';
import { LISTED_ATH_USD } from '../worker/stage.js';
import { CANDLES_STAGE_VERSION, CANDLES_TIMEOUT_SECONDS } from '../worker/stages/candles.js';
import { METADATA_STAGE_VERSION } from '../worker/stages/metadata.js';
import { DEFAULT_MIN_ROUGH_PEAK_USD } from './defaults.js';

export const BACKFILL_RUN_KIND = 'backfill';
const METADATA_TIMEOUT_SECONDS = DEFAULT_STAGE_TIMEOUT_SECONDS;
const METRICS_TIMEOUT_SECONDS = DEFAULT_STAGE_TIMEOUT_SECONDS;

export interface LastRun {
  id: number;
  status: string;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface BackfillStatus {
  now: Date;
  run: LastRun | null;
  selection: ResolvedSelection;
  /** The selection's options came from the last recorded run (true) or from the command line. */
  selectionFromRun: boolean;
  stages: StageBreakdown[];
  listed: number;
  usage: UsageWindow[];
  /** Coins whose metrics finished in the last ten minutes (or since the first of them), per minute. */
  coinsPerMinute: number;
  /** Coins that still need to pass through, and the minutes that takes at that rate. */
  coinsLeft: number;
  minutesLeft: number | null;
  failures: Array<{ stage: string; reason: string; coins: number }>;
  issues: Array<{ kind: string; coins: number }>;
  databaseBytes: number;
}

export interface StatusOptions {
  /** Options for the selection; when absent, the last backfill run's are used. */
  selection?: Partial<SelectionSpec> | undefined;
  now?: () => Date;
}

const DEFAULT_SPEC: SelectionSpec = {
  chain: 'solana',
  minRoughPeakUsd: DEFAULT_MIN_ROUGH_PEAK_USD,
  includeNoPrice: false,
  order: 'peak',
  limit: null,
};

export function breakdownStages(now: Date): BreakdownStage[] {
  const since = (seconds: number) => new Date(now.getTime() - seconds * 1000);
  return [
    {
      stage: 'candles',
      version: CANDLES_STAGE_VERSION,
      requires: 'discovered',
      minAthMarketCapUsd: null,
      runningSince: since(CANDLES_TIMEOUT_SECONDS),
    },
    {
      stage: 'metrics',
      version: METRICS_VERSION,
      requires: 'candles',
      minAthMarketCapUsd: null,
      runningSince: since(METRICS_TIMEOUT_SECONDS),
    },
    {
      stage: 'metadata',
      version: METADATA_STAGE_VERSION,
      requires: 'metrics',
      minAthMarketCapUsd: LISTED_ATH_USD,
      runningSince: since(METADATA_TIMEOUT_SECONDS),
    },
  ];
}

export async function lastBackfillRun(
  db: Kysely<Database>,
): Promise<(LastRun & { params: unknown }) | null> {
  const r = await db
    .selectFrom('ingest_runs')
    .selectAll()
    .where('kind', '=', BACKFILL_RUN_KIND)
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  return r
    ? {
        id: r.id,
        status: r.status,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
        params: r.params,
      }
    : null;
}

/** The selection options recorded in a run's params, or null if it recorded none. */
export function selectionFromParams(params: unknown): SelectionSpec | null {
  const p = params as { selection?: Partial<SelectionSpec> } | null;
  if (!p?.selection) return null;
  return { ...DEFAULT_SPEC, ...p.selection };
}

export async function collectStatus(
  db: Kysely<Database>,
  opts: StatusOptions = {},
): Promise<BackfillStatus> {
  const now = (opts.now ?? (() => new Date()))();
  const run = await lastBackfillRun(db);
  const recorded = run ? selectionFromParams(run.params) : null;
  const given = opts.selection ?? {};
  const spec: SelectionSpec = {
    ...(recorded ?? DEFAULT_SPEC),
    ...Object.fromEntries(Object.entries(given).filter(([, v]) => v !== undefined)),
  };
  const selection = await resolveSelection(db, spec);
  const stages = await stageBreakdown(db, selection, breakdownStages(now));
  const tenMinutesAgo = new Date(now.getTime() - 10 * 60_000);
  const finished = await countFinishedSince(db, selection, 'metrics', tenMinutesAgo);
  // Over the last ten minutes, or over the time since the first of them if that is shorter.
  const spanMinutes = finished.first
    ? Math.min(10, Math.max(1 / 6, (now.getTime() - finished.first.getTime()) / 60_000))
    : 10;
  const perMinute = finished.count / spanMinutes;
  const metrics = stages.find((s) => s.stage === 'metrics')!;
  const left = metrics.waiting + metrics.running;
  return {
    now,
    run: run
      ? { id: run.id, status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt }
      : null,
    selection,
    selectionFromRun: recorded !== null && opts.selection === undefined,
    stages,
    listed: await countListed(db, selection, LISTED_ATH_USD),
    usage: await usageWindow(db, now),
    coinsPerMinute: perMinute,
    coinsLeft: left,
    minutesLeft: perMinute > 0 ? left / perMinute : null,
    failures: await topFailureReasons(db, selection, 5),
    issues: await openIssuesByKind(db, selection),
    databaseBytes: await databaseSizeBytes(db),
  };
}

const n = (x: number) => Math.round(x).toLocaleString('en-US');
const usd = (x: number) => `$${n(x)}`;

export function formatDuration(minutes: number): string {
  if (minutes < 1) return 'under a minute';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h >= 48) return `${(h / 24).toFixed(1)} days`;
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

export function formatBytes(b: number): string {
  if (b >= 1e9) return `${(b / 1e9).toFixed(2)} GB`;
  return `${(b / 1e6).toFixed(0)} MB`;
}

export function formatStatus(s: BackfillStatus): string {
  const sp = s.selection.spec;
  const lines: string[] = [];
  const run = s.run
    ? `run ${s.run.id} ${s.run.status}${s.run.startedAt ? `, started ${s.run.startedAt.toISOString().slice(0, 19)}Z` : ''}`
    : 'no backfill run recorded';
  lines.push(`Backfill status at ${s.now.toISOString().slice(0, 19)}Z (${run})`);
  lines.push(
    `Selected: ${n(s.selection.size)} coins (rough peak ${usd(sp.minRoughPeakUsd)} or more` +
      `${sp.includeNoPrice ? ', and no price' : ''}, ${sp.order} order` +
      `${sp.limit ? `, limit ${n(sp.limit)}` : ''})` +
      `${s.selectionFromRun ? '' : ' [options from the command line]'}`,
  );
  lines.push(`Listed so far (ATH ${usd(LISTED_ATH_USD)} or more): ${n(s.listed)}`);
  lines.push('');
  lines.push('Stage       done   failed  running  waiting     not run');
  for (const st of s.stages) {
    lines.push(
      `${st.stage.padEnd(9)} ${n(st.done).padStart(7)} ${n(st.failed).padStart(8)} ` +
        `${n(st.running).padStart(8)} ${n(st.waiting).padStart(8)} ` +
        `${(st.notApplicable > 0 || st.stage === 'metadata' ? n(st.notApplicable) : '-').padStart(11)}`,
    );
  }
  lines.push('');
  lines.push('Provider         requests (last hour)            units (last hour)');
  if (s.usage.length === 0) lines.push('  none recorded');
  for (const u of s.usage) {
    lines.push(
      `${u.provider.padEnd(14)} ${`${n(u.requests)} (${n(u.lastHourRequests)})`.padStart(20)} ` +
        `${`${n(u.units)} (${n(u.lastHourUnits)})`.padStart(24)}`,
    );
  }
  lines.push('');
  const rate =
    s.coinsPerMinute > 0
      ? `${s.coinsPerMinute.toFixed(1)} coins a minute (last 10 minutes); ` +
        `${n(s.coinsLeft)} left, about ${formatDuration(s.minutesLeft!)} at that rate`
      : `no coin finished in the last 10 minutes; ${n(s.coinsLeft)} left`;
  lines.push(`Pace: ${rate}`);
  if (s.failures.length > 0) {
    lines.push('Commonest failures:');
    for (const f of s.failures) lines.push(`  ${f.stage} ${f.reason}: ${n(f.coins)} coins`);
  } else {
    lines.push('Commonest failures: none');
  }
  lines.push(
    s.issues.length > 0
      ? `Open data issues: ${s.issues.map((i) => `${i.kind} ${n(i.coins)}`).join(', ')}`
      : 'Open data issues: none',
  );
  lines.push(`Database size: ${formatBytes(s.databaseBytes)}`);
  return lines.join('\n');
}

/** For tests: row counts that a read-only status must leave alone. */
export async function countRows(db: Kysely<Database>, table: string): Promise<number> {
  const r = await sql<{ n: string }>`select count(*)::text as n from ${sql.table(table)}`.execute(
    db,
  );
  return Number(r.rows[0]!.n);
}
