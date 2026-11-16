import { sql, type Kysely } from 'kysely';
import type { Database } from './types.js';

/**
 * Seeding and selection for a backfill over a large candidate list.
 *
 * Seeding (`seedBackfillChunk`) writes what the candidate file knows about a coin and marks its
 * `discovered` stage done. It never overwrites what a stage wrote: a field already set on a coin
 * is kept, and only the rough ATH (the file's number is the newer figure) is replaced. A coin
 * that exists keeps its stage rows and metrics, and loading the same rows again changes nothing,
 * not even `updated_at`.
 *
 * Selection (`SelectionSpec`) says which coins a run is about: a floor on the rough ATH, an
 * optional limit and one of two fixed orders. Both orders are walked with a key (`SelectionKey`)
 * and an index, so a page costs the same at coin 300,000 as at coin 1.
 *
 *   peak: largest rough ATH first (coins with none last), ties by id.
 *   hash: by `coins.hash_order`, a stored pseudo-random number of the address, so a run limited
 *         to N coins is the same N coins every time and a fair sample of the selection.
 *
 * The limit counts selected coins whether or not they are done; done coins are skipped by the
 * stages. So stopping and running the same command again carries on with the same coins.
 */

export interface BackfillSeedRow {
  address: string;
  launchpad: string | null;
  launchedAt: Date | null;
  creatorWallet: string | null;
  graduatedAt: Date | null;
  roughAthMarketCapUsd: number | null;
  /**
   * The creation event's mayhem flag; null or absent when the file does not carry it. A true
   * (from the file or already stored) is never turned back; otherwise a stored value is kept and
   * a null stored value takes the file's.
   */
  isMayhemMode?: boolean | null;
}

export interface BackfillSeedResult {
  /** Rows given, after removing repeated addresses. */
  total: number;
  inserted: number;
  /** Existing coins that gained a value or got a new rough ATH. */
  updated: number;
  unchanged: number;
  /** Coins whose `discovered` stage this call marked done. */
  stagesMarked: number;
}

export const SEED_CHUNK = 5000;

/** Seeds one chunk (`SEED_CHUNK` rows is a good size) in one transaction. */
export async function seedBackfillChunk(
  db: Kysely<Database>,
  rows: readonly BackfillSeedRow[],
  opts: { chain: string; discoverySource: string; now: Date; runId?: number | null },
): Promise<BackfillSeedResult> {
  const byAddress = new Map<string, BackfillSeedRow>();
  for (const r of rows) if (!byAddress.has(r.address)) byAddress.set(r.address, r);
  const unique = [...byAddress.values()];
  const result: BackfillSeedResult = {
    total: unique.length,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    stagesMarked: 0,
  };
  if (unique.length === 0) return result;

  const addresses = unique.map((r) => r.address);
  await db.transaction().execute(async (trx) => {
    const touched = await sql<{ inserted: boolean }>`
      insert into coins (chain, address, launchpad, launched_at, creator_wallet, graduated_at,
                         discovery_source, rough_ath_market_cap_usd, is_mayhem_mode)
      select ${opts.chain}, t.address, t.launchpad, t.launched_at, t.creator_wallet, t.graduated_at,
             ${opts.discoverySource}, t.rough, t.mayhem
      from unnest(
        ${addresses}::text[],
        ${unique.map((r) => r.launchpad)}::text[],
        ${unique.map((r) => r.launchedAt)}::timestamptz[],
        ${unique.map((r) => r.creatorWallet)}::text[],
        ${unique.map((r) => r.graduatedAt)}::timestamptz[],
        ${unique.map((r) => r.roughAthMarketCapUsd)}::float8[],
        ${unique.map((r) => r.isMayhemMode ?? null)}::boolean[]
      ) as t(address, launchpad, launched_at, creator_wallet, graduated_at, rough, mayhem)
      on conflict (chain, address) do update set
        is_mayhem_mode = case when coins.is_mayhem_mode is true or excluded.is_mayhem_mode is true then true
                              else coalesce(coins.is_mayhem_mode, excluded.is_mayhem_mode) end,
        launchpad = coalesce(coins.launchpad, excluded.launchpad),
        launched_at = coalesce(coins.launched_at, excluded.launched_at),
        creator_wallet = coalesce(coins.creator_wallet, excluded.creator_wallet),
        graduated_at = coalesce(coins.graduated_at, excluded.graduated_at),
        discovery_source = coalesce(coins.discovery_source, excluded.discovery_source),
        rough_ath_market_cap_usd = coalesce(excluded.rough_ath_market_cap_usd, coins.rough_ath_market_cap_usd),
        updated_at = ${opts.now}
      where (coins.launchpad is null and excluded.launchpad is not null)
         or (coins.launched_at is null and excluded.launched_at is not null)
         or (coins.creator_wallet is null and excluded.creator_wallet is not null)
         or (coins.graduated_at is null and excluded.graduated_at is not null)
         or (coins.discovery_source is null and excluded.discovery_source is not null)
         or (excluded.rough_ath_market_cap_usd is not null
             and coins.rough_ath_market_cap_usd is distinct from excluded.rough_ath_market_cap_usd)
         or (excluded.is_mayhem_mode is not null
             and coins.is_mayhem_mode is distinct from
                 (case when coins.is_mayhem_mode is true or excluded.is_mayhem_mode is true then true
                       else coalesce(coins.is_mayhem_mode, excluded.is_mayhem_mode) end))
      returning (xmax = 0) as inserted
    `.execute(trx);
    const inserted = touched.rows.filter((r) => r.inserted).length;
    result.inserted = inserted;
    result.updated = touched.rows.length - inserted;
    result.unchanged = unique.length - touched.rows.length;

    // A stage row that is already done or skipped is left exactly as it is.
    const marked = await sql<{ coin_id: number }>`
      insert into coin_stages (coin_id, stage, status, attempts, version, run_id, started_at, finished_at, updated_at)
      select c.id, 'discovered', 'done', 1, 1, ${opts.runId ?? null}, ${opts.now}, ${opts.now}, ${opts.now}
      from coins c
      where c.chain = ${opts.chain} and c.address = any(${addresses}::text[])
      on conflict (coin_id, stage) do update set
        status = 'done', last_error = null, run_id = excluded.run_id,
        started_at = excluded.started_at, finished_at = excluded.finished_at,
        updated_at = excluded.updated_at
      where coin_stages.status not in ('done', 'skipped')
      returning coin_id
    `.execute(trx);
    result.stagesMarked = marked.rows.length;
  });
  return result;
}

// ------------------------------------------------------------------ selection

export type SelectionOrder = 'peak' | 'hash';

/**
 * `coins.discovery_source` of the coins that reached the rough-peak floor without graduating
 * (issue #102). A selection leaves them out unless it names this source.
 */
export const CURVE_ONLY_DISCOVERY_SOURCE = 'dune-curve-only';

export interface SelectionSpec {
  chain: string;
  /** Coins with a rough ATH at or above this. */
  minRoughPeakUsd: number;
  /** Also select coins with no rough ATH (graduates with no hourly price). */
  includeNoPrice: boolean;
  order: SelectionOrder;
  /** The first N coins in the order, done or not. Null or absent: all of them. */
  limit?: number | null;
  /**
   * Exactly these coins (by id) instead of the ones above the rough-peak floor: the floor is not
   * applied. Set `includeNoPrice` with it so the order walks coins with no rough ATH too.
   */
  coinIds?: readonly number[] | null;
  /**
   * Only coins whose `discovery_source` is this. Absent or null: every coin except those of
   * `CURVE_ONLY_DISCOVERY_SOURCE`, so a command that does not ask for them selects what it
   * selected before they existed. Not applied to `coinIds` unless given.
   */
  source?: string | null;
}

/** Where a coin stands in a selection's order. */
export interface SelectionKey {
  id: number;
  rough: number | null;
  hash: number;
}

export interface SelectionRow extends SelectionKey {
  address: string;
}

/** A spec plus the key of its last coin when it has a limit smaller than the selection. */
export interface ResolvedSelection {
  spec: SelectionSpec;
  /** Inclusive upper bound in the order. Null: no bound. */
  last: SelectionKey | null;
  /** Coins selected, counting done ones. */
  size: number;
}

const colsOf = (alias: string) => ({
  chain: sql.ref(`${alias}.chain`),
  rough: sql.ref(`${alias}.rough_ath_market_cap_usd`),
  id: sql.ref(`${alias}.id`),
  hash: sql.ref(`${alias}.hash_order`),
});

/** The source part of a selection: the named source, or everything but the curve-only list. */
function sourceCondition(source: string | null | undefined, alias: string) {
  const ref = sql.ref(`${alias}.discovery_source`);
  return source
    ? sql`${ref} = ${source}`
    : sql`${ref} is distinct from ${CURVE_ONLY_DISCOVERY_SOURCE}`;
}

/** The selection without its source part. */
const baseWithoutSource = (spec: SelectionSpec, alias = 'c') => {
  const c = colsOf(alias);
  if (spec.coinIds) {
    return sql`${c.chain} = ${spec.chain} and ${c.id} = any(${[...spec.coinIds]}::bigint[])`;
  }
  return spec.includeNoPrice
    ? sql`${c.chain} = ${spec.chain} and (${c.rough} >= ${spec.minRoughPeakUsd} or ${c.rough} is null)`
    : sql`${c.chain} = ${spec.chain} and ${c.rough} >= ${spec.minRoughPeakUsd}`;
};

const base = (spec: SelectionSpec, alias = 'c') => {
  const b = baseWithoutSource(spec, alias);
  if (spec.coinIds && !spec.source) return b;
  return sql`${b} and ${sourceCondition(spec.source, alias)}`;
};

/**
 * Coins the selection's rule would take but its source leaves out: with no source, the coins of
 * `CURVE_ONLY_DISCOVERY_SOURCE` that pass the rest of the rule (the limit is not applied). With a
 * source named, zero.
 */
export async function countLeftOutBySource(
  db: Kysely<Database>,
  spec: SelectionSpec,
): Promise<number> {
  if (spec.source || spec.coinIds) return 0;
  const r = await sql<{ n: string }>`
    select count(*)::text as n from coins c
    where ${baseWithoutSource(spec)} and c.discovery_source = ${CURVE_ONLY_DISCOVERY_SOURCE}`.execute(
    db,
  );
  return Number(r.rows[0]?.n ?? 0);
}

/** True for coins strictly after `k` in the order. */
function after(spec: SelectionSpec, k: SelectionKey, alias = 'c') {
  const c = colsOf(alias);
  if (spec.order === 'hash') return sql`(${c.hash}, ${c.id}) > (${k.hash}, ${k.id})`;
  if (k.rough === null) return sql`(${c.rough} is null and ${c.id} > ${k.id})`;
  return spec.includeNoPrice
    ? sql`(${c.rough} is null or ${c.rough} < ${k.rough} or (${c.rough} = ${k.rough} and ${c.id} > ${k.id}))`
    : // The extra `<=` lets the planner start the index walk at the key.
      sql`(${c.rough} <= ${k.rough} and (${c.rough} < ${k.rough} or (${c.rough} = ${k.rough} and ${c.id} > ${k.id})))`;
}

const orderBy = (spec: SelectionSpec) =>
  spec.order === 'hash'
    ? sql`c.hash_order, c.id`
    : sql`c.rough_ath_market_cap_usd desc nulls last, c.id`;

/**
 * The SQL condition "this `coins` row (aliased `c`) is in the selection". For other queries to
 * join against; `alias` is the name of the `coins` table in that query (default `c`).
 */
export function selectionCondition(sel: ResolvedSelection, alias = 'c') {
  const b = base(sel.spec, alias);
  return sel.last ? sql`${b} and not ${after(sel.spec, sel.last, alias)}` : b;
}

/**
 * Coin ids for a list of references, each a coin id (digits) or a mint address. Returns the ids
 * found, in the order given and without repeats, and the references that match no coin.
 */
export async function resolveCoinRefs(
  db: Kysely<Database>,
  refs: readonly string[],
  chain = 'solana',
): Promise<{ ids: number[]; unknown: string[] }> {
  const ids = new Map<string, number | null>();
  const wantedIds = refs.filter((r) => /^\d+$/.test(r)).map(Number);
  const wantedAddresses = refs.filter((r) => !/^\d+$/.test(r));
  const found = new Map<string, number>();
  for (let i = 0; i < wantedIds.length; i += 5000) {
    const rows = await db
      .selectFrom('coins')
      .select('id')
      .where('chain', '=', chain)
      .where('id', 'in', wantedIds.slice(i, i + 5000))
      .execute();
    for (const r of rows) found.set(String(r.id), r.id);
  }
  for (let i = 0; i < wantedAddresses.length; i += 5000) {
    const rows = await db
      .selectFrom('coins')
      .select(['id', 'address'])
      .where('chain', '=', chain)
      .where('address', 'in', wantedAddresses.slice(i, i + 5000))
      .execute();
    for (const r of rows) found.set(r.address, r.id);
  }
  const unknown: string[] = [];
  for (const ref of refs) {
    const id = found.get(ref);
    if (id === undefined) unknown.push(ref);
    else if (!ids.has(String(id))) ids.set(String(id), id);
  }
  return { ids: [...ids.values()].filter((x): x is number => x !== null), unknown };
}

/** Rules that pick coins from the database alone (`selectCoinsByRule`). */
export const COIN_RULES = ['late-graduation-pool'] as const;
export type CoinRule = (typeof COIN_RULES)[number];

/** Default for `late-graduation-pool`: `maxGraduationPoolDelaySeconds` of the candle plan. */
export const DEFAULT_GRADUATION_POOL_DELAY_SEC = 3_600;

/**
 * Coin ids picked by a rule, from stored data only (no provider is asked), ascending.
 *
 * `late-graduation-pool`: a coin that
 *   1. has a graduation pool created more than `maxDelaySeconds` before or after the coin's
 *      graduation time (both known), or
 *   2. has a graduation pool with no creation time (named by launch info, never listed) whose first
 *      stored bar starts more than a day after the graduation time, or that holds no bar on a coin
 *      whose candles are done, or
 *   3. has a graduation time, no graduation pool and its candles stage is done. A coin with no
 *      graduation time (a never-graduated curve, issue #102) is never picked by this branch: it
 *      has no graduation pool to be missing.
 * A pool or a coin with no time is never late by (1).
 *
 * A coin with an open `graduation_pool_late` or `graduation_pool_not_found` issue whose detail
 * says `maxDelaySec` equal to `maxDelaySeconds` was examined by a run under this rule (its pool
 * list was read and holds no pool created at the migration): it is left out, so a rule run is not
 * repeated at one list request a coin.
 */
export async function selectCoinsByRule(
  db: Kysely<Database>,
  rule: CoinRule,
  options: { chain?: string; maxDelaySeconds?: number; source?: string | null } = {},
): Promise<number[]> {
  const chain = options.chain ?? 'solana';
  const maxDelay = options.maxDelaySeconds ?? DEFAULT_GRADUATION_POOL_DELAY_SEC;
  if (rule !== 'late-graduation-pool') throw new Error(`Unknown rule "${String(rule)}"`);
  const candlesDone = sql`exists (
    select 1 from coin_stages s
    where s.coin_id = c.id and s.stage = 'candles' and s.status = 'done')`;
  const r = await sql<{ id: string }>`
    select c.id::text as id
    from coins c
    where c.chain = ${chain}
      and ${sourceCondition(options.source, 'c')}
      and (
        exists (
          select 1 from pools p
          where p.coin_id = c.id and p.is_graduation_pool
            and p.created_at_chain is not null and c.graduated_at is not null
            and abs(extract(epoch from (p.created_at_chain - c.graduated_at))) > ${maxDelay}
        )
        or exists (
          select 1 from pools p
          where p.coin_id = c.id and p.is_graduation_pool and p.created_at_chain is null
            and (
              (c.graduated_at is not null and p.first_bar_at is not null
                and p.first_bar_at > c.graduated_at + interval '1 day')
              or (p.first_bar_at is null and ${candlesDone})
            )
        )
        or (
          c.graduated_at is not null
          and ${candlesDone}
          and not exists (
            select 1 from pools p where p.coin_id = c.id and p.is_graduation_pool
          )
        )
      )
      and not exists (
        select 1 from data_issues i
        where i.coin_id = c.id and i.resolved_at is null
          and i.kind in ('graduation_pool_late', 'graduation_pool_not_found')
          and i.detail @> jsonb_build_object('maxDelaySec', ${maxDelay}::numeric)
      )
    order by c.id`.execute(db);
  return r.rows.map((x) => Number(x.id));
}

/**
 * Puts the failed rows of `stages` for coins inside the selection back to pending with zero
 * attempts (a full set of retries). Rows of coins outside the selection are left alone. Returns the
 * number of rows changed.
 */
export async function requeueFailedInSelection(
  db: Kysely<Database>,
  sel: ResolvedSelection,
  stages: readonly string[],
  now: Date,
): Promise<number> {
  if (stages.length === 0) return 0;
  const r = await sql`
    update coin_stages s set status = 'pending', attempts = 0, updated_at = ${now}
    from coins c
    where c.id = s.coin_id and s.status = 'failed' and s.stage = any(${[...stages]}::text[])
      and ${selectionCondition(sel)}`.execute(db);
  return Number(r.numAffectedRows ?? 0);
}

/**
 * When the refresh this run belongs to first started, or null when it is a new refresh.
 *
 * The run record already stores what is needed: `params.refreshPools` and the resolved coin ids
 * (`params.selection.coinIds`). A run is the continuation of earlier runs when they are refreshes
 * of exactly the same coin list, back to the last one that ended `done` (a refresh that ended `done`
 * is over: the same list asked again later is a new refresh). The answer is the earliest start
 * among those earlier runs that is not itself before such a finished one. Runs left `running` by a
 * crash and runs that were `stopped` or `failed` count as unfinished.
 */
export async function refreshFirstStart(
  db: Kysely<Database>,
  opts: { kind: string; coinIds: readonly number[]; beforeRunId: number },
): Promise<Date | null> {
  const r = await sql<{ status: string; started_at: Date | null }>`
    select status, started_at from ingest_runs
    where kind = ${opts.kind} and id < ${opts.beforeRunId}
      and params ->> 'refreshPools' = 'true'
      and params -> 'selection' -> 'coinIds' = ${JSON.stringify([...opts.coinIds])}::jsonb
    order by id desc`.execute(db);
  let first: Date | null = null;
  for (const run of r.rows) {
    if (run.status === 'done') break;
    if (run.started_at && (first === null || run.started_at < first)) first = run.started_at;
  }
  return first;
}

/** Resolves the limit into a key (an index walk of `limit` rows) and counts the selection. */
export async function resolveSelection(
  db: Kysely<Database>,
  spec: SelectionSpec,
): Promise<ResolvedSelection> {
  const limit = spec.limit ?? null;
  let last: SelectionKey | null = null;
  if (limit !== null) {
    const r = await sql<SelectionKey>`
      select c.id, c.rough_ath_market_cap_usd as rough, c.hash_order as hash
      from coins c where ${base(spec)} order by ${orderBy(spec)} offset ${limit - 1} limit 1
    `.execute(db);
    last = r.rows[0] ?? null;
  }
  const n = await sql<{ n: string }>`
    select count(*)::text as n from coins c
    where ${selectionCondition({ spec, last, size: 0 })}
  `.execute(db);
  return { spec, last, size: Number(n.rows[0]!.n) };
}

/** The next `size` selected coins after `cursor` (or from the start), in order. */
export async function selectionPage(
  db: Kysely<Database>,
  sel: ResolvedSelection,
  cursor: SelectionKey | null,
  size: number,
): Promise<SelectionRow[]> {
  const cond = cursor
    ? sql`${selectionCondition(sel)} and ${after(sel.spec, cursor)}`
    : selectionCondition(sel);
  const r = await sql<SelectionRow>`
    select c.id, c.address, c.rough_ath_market_cap_usd as rough, c.hash_order as hash
    from coins c where ${cond} order by ${orderBy(sel.spec)} limit ${size}
  `.execute(db);
  return r.rows;
}

export const keyOf = (row: SelectionRow): SelectionKey => ({
  id: row.id,
  rough: row.rough,
  hash: row.hash,
});

// ------------------------------------------------------------ stage breakdown

export interface BreakdownStage {
  stage: string;
  /** The stage's current version: a row done at a lower one counts as waiting. */
  version: number;
  /** The stage that must be done first, if any. */
  requires: string | null;
  /** The stage only runs for coins with an ATH at or above this. */
  minAthMarketCapUsd: number | null;
  /** A `running` row that started before this is presumed dead and counts as waiting. */
  runningSince: Date;
}

export interface StageBreakdown {
  stage: string;
  done: number;
  failed: number;
  running: number;
  /** Eligible, or not known yet, and not done, failed or running. */
  waiting: number;
  /**
   * Will not run: known to be outside the stage's rule (an ATH under the floor), or blocked
   * because the stage it requires failed for good. Not done, not waiting.
   */
  notApplicable: number;
}

/** Per stage, how the selected coins stand. */
export async function stageBreakdown(
  db: Kysely<Database>,
  sel: ResolvedSelection,
  stages: readonly BreakdownStage[],
): Promise<StageBreakdown[]> {
  const out: StageBreakdown[] = [];
  for (const st of stages) {
    const requirement = st.requires
      ? sql`left join coin_stages r on r.coin_id = c.id and r.stage = ${st.requires}`
      : sql``;
    // Not known yet whether the coin is listed: the required stage has not finished (it may
    // still). A required stage that failed for good means the stage will not run either way.
    const unknown = st.requires
      ? sql`(r.status is null or r.status in ('pending', 'running'))`
      : sql`false`;
    const rule =
      st.minAthMarketCapUsd === null
        ? sql`true`
        : sql`(c.ath_market_cap_usd >= ${st.minAthMarketCapUsd} or ${unknown})`;
    const isDone = sql`(s.status in ('done', 'skipped') and s.version >= ${st.version})`;
    const isFresh = sql`coalesce(s.status = 'running' and s.started_at > ${st.runningSince}, false)`;
    const open = sql`not coalesce(${isDone}, false) and coalesce(s.status, '') <> 'failed' and not ${isFresh}`;
    const r = await sql<{
      done: string;
      failed: string;
      running: string;
      waiting: string;
      na: string;
    }>`
      select
        count(*) filter (where coalesce(${isDone}, false))::text as done,
        count(*) filter (where s.status = 'failed')::text as failed,
        count(*) filter (where ${isFresh})::text as running,
        count(*) filter (where ${open} and ${rule})::text as waiting,
        count(*) filter (where ${open} and not ${rule})::text as na
      from coins c
      left join coin_stages s on s.coin_id = c.id and s.stage = ${st.stage}
      ${requirement}
      where ${selectionCondition(sel)}
    `.execute(db);
    const row = r.rows[0]!;
    out.push({
      stage: st.stage,
      done: Number(row.done),
      failed: Number(row.failed),
      running: Number(row.running),
      waiting: Number(row.waiting),
      notApplicable: Number(row.na),
    });
  }
  return out;
}

/** Selected coins whose metrics are done and whose ATH is at or above `minAth`. */
export async function countListed(
  db: Kysely<Database>,
  sel: ResolvedSelection,
  minAth: number,
): Promise<number> {
  const r = await sql<{ n: string }>`
    select count(*)::text as n from coins c
    inner join coin_stages m on m.coin_id = c.id and m.stage = 'metrics' and m.status in ('done', 'skipped')
    where ${selectionCondition(sel)} and c.ath_market_cap_usd >= ${minAth}
  `.execute(db);
  return Number(r.rows[0]!.n);
}

export interface RoughPeakCounts {
  /** `counts[i]`: coins with `edges[i-1] <= rough < edges[i]`; the first is under `edges[0]`, the last at or above the last edge. */
  counts: number[];
  /** Of those, coins whose given stage is already done. */
  done: number[];
  noPrice: number;
  doneNoPrice: number;
}

/** Selected coins by rough-peak cell (`edges` ascending, USD), and how many are done at `stage`. */
export async function countByRoughPeak(
  db: Kysely<Database>,
  sel: ResolvedSelection,
  edges: readonly number[],
  stage: { stage: string; version: number },
): Promise<RoughPeakCounts> {
  const r = await sql<{ b: number; n: string; d: string }>`
    select case when c.rough_ath_market_cap_usd is null then -1
                else (select count(*) from unnest(${[...edges]}::float8[]) e
                      where e <= c.rough_ath_market_cap_usd)::int end as b,
           count(*)::text as n,
           count(*) filter (where s.status in ('done', 'skipped') and s.version >= ${stage.version})::text as d
    from coins c
    left join coin_stages s on s.coin_id = c.id and s.stage = ${stage.stage}
    where ${selectionCondition(sel)}
    group by 1
  `.execute(db);
  const counts = new Array<number>(edges.length + 1).fill(0);
  const done = new Array<number>(edges.length + 1).fill(0);
  let noPrice = 0;
  let doneNoPrice = 0;
  for (const row of r.rows) {
    if (row.b === -1) {
      noPrice = Number(row.n);
      doneNoPrice = Number(row.d);
    } else {
      counts[row.b] = Number(row.n);
      done[row.b] = Number(row.d);
    }
  }
  return { counts, done, noPrice, doneNoPrice };
}

// ------------------------------------------------------------- usage history

/** Appends a sample of a run's running totals for a provider. */
export async function recordUsageSample(
  db: Kysely<Database>,
  runId: number,
  entry: { provider: string; requests: number; units: number },
  now: Date,
): Promise<void> {
  await db
    .insertInto('provider_usage_samples')
    .values({
      run_id: runId,
      provider: entry.provider,
      sampled_at: now,
      requests: entry.requests,
      units: entry.units,
    })
    .onConflict((oc) => oc.doNothing())
    .execute();
}

export interface UsageWindow {
  provider: string;
  /** Over all runs, ever. */
  requests: number;
  units: number;
  /** Over the last hour: what each run's totals gained since an hour ago, summed. */
  lastHourRequests: number;
  lastHourUnits: number;
}

/** Provider usage in total and over the hour before `now`. */
export async function usageWindow(db: Kysely<Database>, now: Date): Promise<UsageWindow[]> {
  const since = new Date(now.getTime() - 3_600_000);
  const r = await sql<{
    provider: string;
    requests: string;
    units: number;
    h_requests: string;
    h_units: number;
  }>`
    with totals as (
      select provider, sum(requests) as requests, sum(units) as units
      from provider_usage group by provider
    ),
    latest as (
      select distinct on (run_id, provider) run_id, provider, requests, units
      from provider_usage_samples where sampled_at <= ${now}
      order by run_id, provider, sampled_at desc
    ),
    before as (
      select distinct on (run_id, provider) run_id, provider, requests, units
      from provider_usage_samples where sampled_at <= ${since}
      order by run_id, provider, sampled_at desc
    ),
    hour as (
      select l.provider,
             sum(l.requests - coalesce(b.requests, 0)) as requests,
             sum(l.units - coalesce(b.units, 0)) as units
      from latest l
      left join before b on b.run_id = l.run_id and b.provider = l.provider
      group by l.provider
    )
    select t.provider, t.requests::text as requests, t.units,
           coalesce(h.requests, 0)::text as h_requests, coalesce(h.units, 0) as h_units
    from totals t left join hour h on h.provider = t.provider
    order by t.provider
  `.execute(db);
  return r.rows.map((x) => ({
    provider: x.provider,
    requests: Number(x.requests),
    units: Number(x.units),
    lastHourRequests: Number(x.h_requests),
    lastHourUnits: Number(x.h_units),
  }));
}

/** Selected coins whose `stage` finished (done or skipped) after `since`, and when the first did. */
export async function countFinishedSince(
  db: Kysely<Database>,
  sel: ResolvedSelection,
  stage: string,
  since: Date,
): Promise<{ count: number; first: Date | null }> {
  const r = await sql<{ n: string; first: Date | null }>`
    select count(*)::text as n, min(s.finished_at) as first from coin_stages s
    inner join coins c on c.id = s.coin_id
    where s.stage = ${stage} and s.status in ('done', 'skipped') and s.finished_at > ${since}
      and ${selectionCondition(sel)}
  `.execute(db);
  return { count: Number(r.rows[0]!.n), first: r.rows[0]!.first };
}

/** The commonest failure reasons among the selected coins (text before the first colon). */
export async function topFailureReasons(
  db: Kysely<Database>,
  sel: ResolvedSelection,
  limit: number,
): Promise<Array<{ stage: string; reason: string; coins: number }>> {
  const r = await sql<{ stage: string; reason: string; n: string }>`
    select s.stage,
           coalesce(nullif(split_part(s.last_error, ':', 1), ''), '(no reason recorded)') as reason,
           count(*)::text as n
    from coin_stages s inner join coins c on c.id = s.coin_id
    where s.status = 'failed' and ${selectionCondition(sel)}
    group by 1, 2 order by count(*) desc limit ${limit}
  `.execute(db);
  return r.rows.map((x) => ({ stage: x.stage, reason: x.reason, coins: Number(x.n) }));
}

/** Open data issues by kind among the selected coins. */
export async function openIssuesByKind(
  db: Kysely<Database>,
  sel: ResolvedSelection,
): Promise<Array<{ kind: string; coins: number }>> {
  const r = await sql<{ kind: string; n: string }>`
    select d.kind, count(distinct d.coin_id)::text as n
    from data_issues d inner join coins c on c.id = d.coin_id
    where d.resolved_at is null and ${selectionCondition(sel)}
    group by d.kind order by count(distinct d.coin_id) desc, d.kind
  `.execute(db);
  return r.rows.map((x) => ({ kind: x.kind, coins: Number(x.n) }));
}

/** Size of the database being read, in bytes. */
export async function databaseSizeBytes(db: Kysely<Database>): Promise<number> {
  const r = await sql<{
    n: string;
  }>`select pg_database_size(current_database())::text as n`.execute(db);
  return Number(r.rows[0]!.n);
}
