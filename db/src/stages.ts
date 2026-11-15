import { sql, type Kysely, type Selectable } from 'kysely';
import { selectionCondition, type ResolvedSelection } from './backfill.js';
import type { CoinStagesTable, Database } from './types.js';

/**
 * Per-coin stage tracking (table `coin_stages`) and the data-issue queue
 * (table `data_issues`).
 *
 * Rules, all enforced here and not in callers:
 * - A stage row is `pending`, `running`, `done`, `failed` or `skipped`. `done`
 *   and `skipped` are final at the version they were finished at.
 * - `claimStage` is the only way to start work. It moves pending or failed to
 *   running and adds one to `attempts`, in a single UPDATE, so two workers can
 *   never both claim the same row.
 * - A row stuck in `running` (its worker was killed) is claimable again once
 *   it started more than `staleAfterMs` ago.
 * - A stage that is `done` or `skipped` at a version at least as high as the
 *   current one is never claimed again. A higher current version (the stage's
 *   code changed) makes it claimable.
 * - `finishStage` only works for the claim that is still current: it needs the
 *   `attempt` number `claimStage` returned. A worker whose claim was taken over
 *   after a timeout cannot overwrite the newer result.
 */

export type StageName = CoinStagesTable['stage'];
export type StageStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';
export type CoinStageRow = Selectable<CoinStagesTable>;

export type ClaimResult =
  /** The caller owns the stage now and must finish it. `attempt` is the number to pass back. */
  | { status: 'claimed'; attempt: number }
  /** Final at this version already. Nothing to do. */
  | { status: 'final'; stageStatus: 'done' | 'skipped' }
  /** Another worker holds it and has not timed out. */
  | { status: 'busy' }
  /** No such coin. */
  | { status: 'no_coin' };

export interface ClaimOptions {
  coinId: number;
  stage: StageName;
  /** The stage's current version. Rows finished at a lower version are claimable again. Default 1. */
  version?: number;
  runId?: number | null;
  now: Date;
  /** A `running` row that started at or before `now - staleAfterMs` is taken over. */
  staleAfterMs: number;
}

/** Creates `pending` rows for the given coins and stages. Existing rows are left alone. */
export async function ensureStages(
  db: Kysely<Database>,
  coinIds: readonly number[],
  stages: readonly StageName[],
): Promise<void> {
  const rows = coinIds.flatMap((coin_id) => stages.map((stage) => ({ coin_id, stage })));
  for (let i = 0; i < rows.length; i += 2000) {
    await db
      .insertInto('coin_stages')
      .values(rows.slice(i, i + 2000))
      .onConflict((oc) => oc.columns(['coin_id', 'stage']).doNothing())
      .execute();
  }
}

export async function claimStage(db: Kysely<Database>, opts: ClaimOptions): Promise<ClaimResult> {
  const version = opts.version ?? 1;
  const staleBefore = new Date(opts.now.getTime() - opts.staleAfterMs);

  const coin = await db
    .selectFrom('coins')
    .select('id')
    .where('id', '=', opts.coinId)
    .executeTakeFirst();
  if (!coin) return { status: 'no_coin' };

  // The row may not exist yet; make it, then claim with one conditional UPDATE.
  await db
    .insertInto('coin_stages')
    .values({ coin_id: opts.coinId, stage: opts.stage })
    .onConflict((oc) => oc.columns(['coin_id', 'stage']).doNothing())
    .execute();

  const claimed = await db
    .updateTable('coin_stages')
    .set({
      status: 'running',
      attempts: sql<number>`attempts + 1`,
      version,
      run_id: opts.runId ?? null,
      started_at: opts.now,
      finished_at: null,
      detail: null,
      updated_at: opts.now,
    })
    .where('coin_id', '=', opts.coinId)
    .where('stage', '=', opts.stage)
    .where((eb) =>
      eb.or([
        eb('status', 'in', ['pending', 'failed']),
        eb.and([eb('status', '=', 'running'), eb('started_at', '<=', staleBefore)]),
        eb.and([eb('status', 'in', ['done', 'skipped']), eb('version', '<', version)]),
      ]),
    )
    .returning('attempts')
    .executeTakeFirst();
  if (claimed) return { status: 'claimed', attempt: claimed.attempts };

  const row = await db
    .selectFrom('coin_stages')
    .select('status')
    .where('coin_id', '=', opts.coinId)
    .where('stage', '=', opts.stage)
    .executeTakeFirst();
  if (row && (row.status === 'done' || row.status === 'skipped')) {
    return { status: 'final', stageStatus: row.status };
  }
  return { status: 'busy' };
}

export type FinishOutcome =
  /** `detail` is a small per-coin JSON object (under 1 KB) kept on the stage row. */
  | { status: 'done'; detail?: Record<string, unknown> | null }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; error: string };

export interface FinishOptions {
  coinId: number;
  stage: StageName;
  /** The number `claimStage` returned. */
  attempt: number;
  outcome: FinishOutcome;
  now: Date;
  /**
   * For a failed outcome whose cause was the run and not the coin (a spend ceiling): give the
   * attempt back, so the failure does not count toward the coin's retry limit.
   */
  refundAttempt?: boolean;
}

const MAX_TEXT = 2000;
/** `coin_stages.detail` is for a few counters, not for data: larger objects are refused. */
export const MAX_DETAIL_BYTES = 1024;
const clip = (s: string): string => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s);

/**
 * Records the result of a claimed stage. Returns false (and changes nothing)
 * when the claim is no longer current: the row is not running, or a later
 * attempt has taken it over. `last_error` holds the failure text, or the skip
 * reason for `skipped`, or null for `done`. `detail` is stored for `done` only
 * and is cleared (set to null) for `failed` and `skipped`.
 */
export async function finishStage(db: Kysely<Database>, opts: FinishOptions): Promise<boolean> {
  const o = opts.outcome;
  const lastError =
    o.status === 'failed' ? clip(o.error) : o.status === 'skipped' ? clip(o.reason) : null;
  const detail = o.status === 'done' && o.detail ? JSON.stringify(o.detail) : null;
  if (detail !== null && Buffer.byteLength(detail) > MAX_DETAIL_BYTES) {
    throw new RangeError(
      `Stage detail is ${Buffer.byteLength(detail)} bytes; the limit is ${MAX_DETAIL_BYTES}`,
    );
  }
  const res = await db
    .updateTable('coin_stages')
    .set({
      status: o.status,
      last_error: lastError,
      detail,
      ...(opts.refundAttempt && o.status === 'failed'
        ? { attempts: sql<number>`attempts - 1` }
        : {}),
      finished_at: opts.now,
      updated_at: opts.now,
    })
    .where('coin_id', '=', opts.coinId)
    .where('stage', '=', opts.stage)
    .where('status', '=', 'running')
    .where('attempts', '=', opts.attempt)
    .executeTakeFirst();
  return Number(res.numUpdatedRows) === 1;
}

export interface ListNotDoneOptions {
  /** Current version of the stage. Default 1. */
  version?: number;
  /** Only coins whose stage `requires` is done or skipped. */
  requires?: StageName;
  /** Only these addresses (chain `solana` unless `chain` is given). */
  addresses?: readonly string[];
  chain?: string;
  /** Leave out stages that are `running` and started after this time (another worker is on them). */
  runningSince?: Date;
  /** Keep failed rows out. Default false: failed rows are listed so a re-run retries them. */
  excludeFailed?: boolean;
  /**
   * Leave out failed rows that have used this many attempts: the stage was tried that often and
   * is left failed. A re-run does not touch them; `requeueFailed` makes them eligible again.
   */
  maxAttempts?: number;
  /** Return coins with an id above this one. For paging. */
  afterId?: number;
  /** Only these coin ids. */
  ids?: readonly number[];
  /** Only coins in this backfill selection. */
  selection?: ResolvedSelection;
  /**
   * The stage only runs for coins whose ATH is at or above this (a backfill's rule for
   * `metadata`). A coin with no ATH yet does not qualify, so it is never listed.
   */
  minAthMarketCapUsd?: number;
  limit?: number;
}

export interface NotDoneCoin {
  id: number;
  chain: string;
  address: string;
  status: StageStatus | null;
  attempts: number;
}

/**
 * Coins whose `stage` is not final at `version`, in id order. A coin with no
 * row for the stage counts as not done (status null). Never lists a coin whose
 * stage is done or skipped at this version or later.
 */
function notDoneQuery(db: Kysely<Database>, stage: StageName, opts: ListNotDoneOptions) {
  const version = opts.version ?? 1;
  let q = db
    .selectFrom('coins')
    .leftJoin('coin_stages as s', (join) =>
      join.onRef('s.coin_id', '=', 'coins.id').on('s.stage', '=', stage),
    )
    .where((eb) =>
      eb.or([
        eb('s.status', 'is', null),
        eb('s.status', 'in', ['pending', 'failed', 'running']),
        eb.and([eb('s.status', 'in', ['done', 'skipped']), eb('s.version', '<', version)]),
      ]),
    );
  if (opts.minAthMarketCapUsd !== undefined) {
    q = q.where('coins.ath_market_cap_usd', '>=', opts.minAthMarketCapUsd);
  }
  if (opts.selection) q = q.where(sql<boolean>`${selectionCondition(opts.selection, 'coins')}`);
  if (opts.ids) {
    if (opts.ids.length === 0) return null;
    q = q.where('coins.id', 'in', [...opts.ids]);
  }
  if (opts.runningSince) {
    const since = opts.runningSince;
    q = q.where((eb) =>
      eb.or([eb('s.status', 'is distinct from', 'running'), eb('s.started_at', '<=', since)]),
    );
  }
  if (opts.excludeFailed) q = q.where((eb) => eb('s.status', 'is distinct from', 'failed'));
  if (opts.maxAttempts !== undefined) {
    const max = opts.maxAttempts;
    q = q.where((eb) =>
      eb.or([eb('s.status', 'is distinct from', 'failed'), eb('s.attempts', '<', max)]),
    );
  }
  if (opts.requires) {
    const requires = opts.requires;
    q = q.where((eb) =>
      eb.exists(
        eb
          .selectFrom('coin_stages as r')
          .select(sql.lit(1).as('one'))
          .whereRef('r.coin_id', '=', 'coins.id')
          .where('r.stage', '=', requires)
          .where('r.status', 'in', ['done', 'skipped']),
      ),
    );
  }
  if (opts.addresses) {
    if (opts.addresses.length === 0) return null;
    q = q
      .where('coins.chain', '=', opts.chain ?? 'solana')
      .where('coins.address', 'in', [...opts.addresses]);
  }
  if (opts.afterId !== undefined) q = q.where('coins.id', '>', opts.afterId);
  return q;
}

export async function listCoinsNotDone(
  db: Kysely<Database>,
  stage: StageName,
  opts: ListNotDoneOptions = {},
): Promise<NotDoneCoin[]> {
  const base = notDoneQuery(db, stage, opts);
  if (!base) return [];
  let q = base
    .select(['coins.id', 'coins.chain', 'coins.address', 's.status', 's.attempts'])
    .orderBy('coins.id');
  if (opts.limit !== undefined) q = q.limit(opts.limit);
  const rows = await q.execute();
  return rows.map((r) => ({
    id: r.id,
    chain: r.chain,
    address: r.address,
    status: r.status ?? null,
    attempts: r.attempts ?? 0,
  }));
}

/** How many coins `listCoinsNotDone` would list (`limit` and `afterId` are ignored). */
export async function countCoinsNotDone(
  db: Kysely<Database>,
  stage: StageName,
  opts: ListNotDoneOptions = {},
): Promise<number> {
  const base = notDoneQuery(db, stage, { ...opts, afterId: undefined });
  if (!base) return 0;
  const r = await base.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow();
  return Number(r.n);
}

/**
 * Puts failed stages back to `pending` with zero attempts, so the next run
 * gives each a full set of retries. Returns how many rows changed.
 */
export async function requeueFailed(
  db: Kysely<Database>,
  stages: readonly StageName[],
  opts: { addresses?: readonly string[]; now: Date },
): Promise<number> {
  if (stages.length === 0 || (opts.addresses && opts.addresses.length === 0)) return 0;
  let q = db
    .updateTable('coin_stages')
    .set({ status: 'pending', attempts: 0, updated_at: opts.now })
    .where('status', '=', 'failed')
    .where('stage', 'in', [...stages]);
  if (opts.addresses) {
    q = q.where(
      'coin_id',
      'in',
      db
        .selectFrom('coins')
        .select('id')
        .where('chain', '=', 'solana')
        .where('address', 'in', [...opts.addresses]),
    );
  }
  const res = await q.executeTakeFirst();
  return Number(res.numUpdatedRows);
}

export interface StageCount {
  stage: StageName;
  /** `missing` when the coin has no row for the stage. */
  status: StageStatus | 'missing';
  coins: number;
}

/** Coins per stage and status, for the given addresses (or all coins). */
export async function countStages(
  db: Kysely<Database>,
  stages: readonly StageName[],
  addresses?: readonly string[],
): Promise<StageCount[]> {
  const out: StageCount[] = [];
  if (addresses && addresses.length === 0) return out;
  for (const stage of stages) {
    let q = db
      .selectFrom('coins')
      .leftJoin('coin_stages as s', (join) =>
        join.onRef('s.coin_id', '=', 'coins.id').on('s.stage', '=', stage),
      )
      .select(['s.status', (eb) => eb.fn.countAll<string>().as('n')])
      .groupBy('s.status');
    if (addresses) q = q.where('coins.address', 'in', [...addresses]);
    for (const r of await q.execute()) {
      out.push({ stage, status: r.status ?? 'missing', coins: Number(r.n) });
    }
  }
  return out;
}

export interface FailureGroup {
  stage: StageName;
  status: 'failed' | 'skipped';
  /** `last_error` up to its first colon, so details that differ per coin group together. */
  reason: string;
  coins: number;
}

/** Failed and skipped stages grouped by reason code. */
export async function groupStageFailures(
  db: Kysely<Database>,
  stages: readonly StageName[],
  addresses?: readonly string[],
): Promise<FailureGroup[]> {
  if (addresses && addresses.length === 0) return [];
  const reason = sql<string>`coalesce(nullif(split_part(s.last_error, ':', 1), ''), '(no reason recorded)')`;
  let q = db
    .selectFrom('coin_stages as s')
    .innerJoin('coins', 'coins.id', 's.coin_id')
    .select(['s.stage', 's.status', reason.as('reason'), (eb) => eb.fn.countAll<string>().as('n')])
    .where('s.stage', 'in', [...stages])
    .where('s.status', 'in', ['failed', 'skipped'])
    .groupBy(['s.stage', 's.status', reason])
    .orderBy('n', 'desc');
  if (addresses) q = q.where('coins.address', 'in', [...addresses]);
  return (await q.execute()).map((r) => ({
    stage: r.stage,
    status: r.status as 'failed' | 'skipped',
    reason: r.reason,
    coins: Number(r.n),
  }));
}

// ------------------------------------------------------------------ data issues

/** Open issues per kind, for the given addresses (or all coins). */
export async function countOpenIssues(
  db: Kysely<Database>,
  addresses?: readonly string[],
): Promise<Array<{ kind: string; coins: number; issues: number }>> {
  if (addresses && addresses.length === 0) return [];
  let q = db
    .selectFrom('data_issues as d')
    .innerJoin('coins', 'coins.id', 'd.coin_id')
    .select([
      'd.kind',
      (eb) => eb.fn.count<string>('d.coin_id').distinct().as('coins'),
      (eb) => eb.fn.countAll<string>().as('issues'),
    ])
    .where('d.resolved_at', 'is', null)
    .groupBy('d.kind')
    .orderBy('d.kind');
  if (addresses) q = q.where('coins.address', 'in', [...addresses]);
  return (await q.execute()).map((r) => ({
    kind: r.kind,
    coins: Number(r.coins),
    issues: Number(r.issues),
  }));
}
