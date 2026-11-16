import { sql, type ExpressionBuilder, type Kysely } from 'kysely';
import { reopenStages } from './stages.js';
import type { Database } from './types.js';

/**
 * What the live process needs from the database (issue #73).
 *
 * `live_state` holds named JSON values: the discovery cursor, the last sweep, counters per UTC
 * day. Everything the status view prints is read from here and from the tables the pipeline
 * already writes (`coins`, `coin_stages`, `provider_usage_samples`).
 *
 * Which coins are watched is one predicate, `isWatched`, used by every query below that talks
 * about the watched set: the watch loop, the sweep and the status counts all go through it.
 */

// ------------------------------------------------------------------ live_state

export async function getLiveState<T = unknown>(
  db: Kysely<Database>,
  key: string,
): Promise<T | null> {
  const row = await db
    .selectFrom('live_state')
    .select('value')
    .where('key', '=', key)
    .executeTakeFirst();
  return row ? (row.value as T) : null;
}

export async function setLiveState(
  db: Kysely<Database>,
  key: string,
  value: unknown,
  now: Date,
): Promise<void> {
  const json = JSON.stringify(value);
  await db
    .insertInto('live_state')
    .values({ key, value: json, updated_at: now })
    .onConflict((oc) => oc.column('key').doUpdateSet({ value: json, updated_at: now }))
    .execute();
}

/** Adds to numeric fields of a state value (creating the row and the fields as needed). */
export async function bumpLiveCounters(
  db: Kysely<Database>,
  key: string,
  deltas: Record<string, number>,
  now: Date,
): Promise<void> {
  const entries = Object.entries(deltas).filter(([, d]) => d !== 0);
  if (entries.length === 0) return;
  const initial = Object.fromEntries(entries);
  const bumped = sql.join(
    entries.map(
      ([k, d]) =>
        sql`${k}::text, coalesce((live_state.value ->> ${k}::text)::bigint, 0) + ${d}::bigint`,
    ),
  );
  await sql`
    insert into live_state (key, value, updated_at)
    values (${key}, ${JSON.stringify(initial)}::jsonb, ${now})
    on conflict (key) do update set
      value = live_state.value || jsonb_build_object(${bumped}),
      updated_at = ${now}
  `.execute(db);
}

// ---------------------------------------------------------------- the watched set

export interface WatchSpec {
  now: Date;
  /** A coin is watched while it graduated less than this long ago. */
  windowSeconds: number;
}

/**
 * The watched coins: every coin that graduated within `windowSeconds` of `now`, whether its
 * candles were fetched or not and whether it is listed or not. A fetched coin can still reach a
 * new high, so it is polled like the rest.
 */
export function isWatched(eb: ExpressionBuilder<Database, 'coins'>, w: WatchSpec) {
  const since = new Date(w.now.getTime() - w.windowSeconds * 1000);
  return eb('coins.graduated_at', '>', since);
}

/**
 * True for a coin with no `candles` stage row that was ever attempted (no row, or a fresh
 * `pending` one that no worker has claimed): the coins the sweep queues for a first fetch.
 */
export function candlesNeverAttempted(eb: ExpressionBuilder<Database, 'coins'>) {
  return eb.not(
    eb.exists(
      eb
        .selectFrom('coin_stages as cs')
        .select(sql.lit(1).as('one'))
        .whereRef('cs.coin_id', '=', 'coins.id')
        .where('cs.stage', '=', 'candles')
        .where((e) =>
          e.or([
            e('cs.status', '<>', 'pending'),
            e('cs.attempts', '>', 0),
            e('cs.started_at', 'is not', null),
          ]),
        ),
    ),
  );
}

/** Seconds since graduation, as SQL. */
const ageSeconds = (now: Date) =>
  sql<number>`extract(epoch from (${now}::timestamptz - coins.graduated_at))::float8`;

export interface AgeBounds {
  /** Younger than this: the first tier. */
  freshUnderSeconds: number;
  /** Younger than this (and not fresh): the second tier. Older: the third. */
  midUnderSeconds: number;
}

export interface WatchedCounts {
  fresh: number;
  mid: number;
  older: number;
  total: number;
  /** Watched coins with a `pending` candles row: queued, no worker has finished it yet. */
  triggeredWaiting: number;
}

export async function countWatchedByAge(
  db: Kysely<Database>,
  w: WatchSpec,
  bounds: AgeBounds,
): Promise<WatchedCounts> {
  const age = ageSeconds(w.now);
  const r = await db
    .selectFrom('coins')
    .select([
      sql<string>`count(*) filter (where ${age} < ${bounds.freshUnderSeconds}::float8)`.as('fresh'),
      sql<string>`count(*) filter (where ${age} >= ${bounds.freshUnderSeconds}::float8 and ${age} < ${bounds.midUnderSeconds}::float8)`.as(
        'mid',
      ),
      sql<string>`count(*) filter (where ${age} >= ${bounds.midUnderSeconds}::float8)`.as('older'),
      sql<string>`count(*)`.as('total'),
      sql<string>`count(*) filter (where exists (
        select 1 from coin_stages t where t.coin_id = coins.id and t.stage = 'candles' and t.status = 'pending'))`.as(
        'waiting',
      ),
    ])
    .where((eb) => isWatched(eb, w))
    .executeTakeFirstOrThrow();
  return {
    fresh: Number(r.fresh),
    mid: Number(r.mid),
    older: Number(r.older),
    total: Number(r.total),
    triggeredWaiting: Number(r.waiting),
  };
}

export interface WatchIntervals {
  /** A coin younger than `freshUnderSeconds` is looked at every `freshEverySeconds`... */
  freshUnderSeconds: number;
  freshEverySeconds: number;
  /** ...younger than `midUnderSeconds`, every `midEverySeconds`... */
  midUnderSeconds: number;
  midEverySeconds: number;
  /** ...otherwise every `olderEverySeconds`. */
  olderEverySeconds: number;
}

export interface WatchedCoin {
  id: number;
  address: string;
  /** The coin's stored total supply, whole tokens. */
  totalSupply: number;
  graduatedAt: Date;
  currentRefreshedAt: Date | null;
  /** Stored ATH market cap (from the metrics stage), null when never computed. */
  athMarketCapUsd: number | null;
  /** Market cap at the coin's last trigger, null when it was never triggered by the watch. */
  lastTriggerMarketCapUsd: number | null;
  /** The `candles` stage row, null when there is none. */
  candles: WatchedStage | null;
  /** The `metrics` stage row, null when there is none. */
  metrics: WatchedStage | null;
}

export interface WatchedStage {
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  attempts: number;
  startedAt: Date | null;
  finishedAt: Date | null;
}

interface StageJson {
  status: WatchedStage['status'];
  attempts: number;
  started_at: string | null;
  finished_at: string | null;
}

const stageJson = (stage: string) =>
  sql<StageJson | null>`(select json_build_object('status', cs.status, 'attempts', cs.attempts,
    'started_at', cs.started_at, 'finished_at', cs.finished_at)
  from coin_stages cs where cs.coin_id = coins.id and cs.stage = ${stage})`;

function toStage(j: StageJson | null): WatchedStage | null {
  return j
    ? {
        status: j.status,
        attempts: Number(j.attempts),
        startedAt: j.started_at ? new Date(j.started_at) : null,
        finishedAt: j.finished_at ? new Date(j.finished_at) : null,
      }
    : null;
}

/**
 * Watched coins whose price is due, most overdue first: never polled coins, then the ones polled
 * longest ago. A coin whose candle or metric stage is waiting or running is polled like the
 * rest (the caller does not queue it again until both stages have finished), with the stage rows
 * and ATH the trigger decision needs. `excludeIds` are coins to leave out (those Jupiter did not answer for lately).
 */
export async function listWatchedDue(
  db: Kysely<Database>,
  w: WatchSpec,
  intervals: WatchIntervals,
  o: { limit: number; excludeIds?: readonly number[] },
): Promise<WatchedCoin[]> {
  const age = ageSeconds(w.now);
  const every = sql<number>`case
    when ${age} < ${intervals.freshUnderSeconds}::float8 then ${intervals.freshEverySeconds}::float8
    when ${age} < ${intervals.midUnderSeconds}::float8 then ${intervals.midEverySeconds}::float8
    else ${intervals.olderEverySeconds}::float8 end`;
  const rows = await db
    .selectFrom('coins')
    .select([
      'id',
      'address',
      'total_supply',
      'graduated_at',
      'current_refreshed_at',
      'ath_market_cap_usd',
      'last_trigger_market_cap_usd',
      stageJson('candles').as('candles'),
      stageJson('metrics').as('metrics'),
    ])
    .where((eb) => isWatched(eb, w))
    .where(
      sql<boolean>`(coins.current_refreshed_at is null
        or extract(epoch from (${w.now}::timestamptz - coins.current_refreshed_at)) >= ${every})`,
    )
    .$if((o.excludeIds?.length ?? 0) > 0, (q) =>
      q.where(sql<boolean>`coins.id <> all(${[...(o.excludeIds ?? [])]}::bigint[])`),
    )
    .orderBy(sql`coins.current_refreshed_at asc nulls first`)
    .orderBy('id')
    .limit(o.limit)
    .execute();
  return rows.map((r) => ({
    id: r.id,
    address: r.address,
    totalSupply: Number(r.total_supply),
    graduatedAt: r.graduated_at!,
    currentRefreshedAt: r.current_refreshed_at,
    athMarketCapUsd: r.ath_market_cap_usd,
    lastTriggerMarketCapUsd: r.last_trigger_market_cap_usd,
    candles: toStage(r.candles),
    metrics: toStage(r.metrics),
  }));
}

export interface CurrentFigures {
  id: number;
  priceUsd: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
}

/** Stores the `current_*` columns of many coins in one statement. */
export async function storeCurrentFigures(
  db: Kysely<Database>,
  rows: readonly CurrentFigures[],
  now: Date,
): Promise<void> {
  if (rows.length === 0) return;
  await sql`
    update coins set
      current_price_usd = t.price,
      current_market_cap_usd = t.mcap,
      current_liquidity_usd = t.liq,
      current_volume_24h_usd = t.vol,
      current_refreshed_at = ${now},
      updated_at = ${now}
    from unnest(
      ${rows.map((r) => r.id)}::bigint[],
      ${rows.map((r) => r.priceUsd)}::float8[],
      ${rows.map((r) => r.marketCapUsd)}::float8[],
      ${rows.map((r) => r.liquidityUsd)}::float8[],
      ${rows.map((r) => r.volume24hUsd)}::float8[]
    ) as t(id, price, mcap, liq, vol)
    where coins.id = t.id
  `.execute(db);
}

// ------------------------------------------------------------------ discovery

export interface LiveGraduate {
  address: string;
  ticker: string | null;
  name: string | null;
  launchpad: string | null;
  launchedAt: Date | null;
  creatorWallet: string | null;
  graduatedAt: Date;
}

/** Postgres text cannot hold a NUL character; everything else a provider sends is kept as it came. */
export const withoutNul = (s: string | null): string | null =>
  s === null ? null : s.replaceAll('\u0000', '');

/**
 * Inserts the graduates that are not in `coins` yet, with their launch facts and a discovery
 * source of their own, and marks their `discovered` stage done. A coin that exists is left
 * exactly as it is, so a window read twice stores nothing the second time. Returns how many
 * were new. The day's `found` counter moves in the same transaction as the insert.
 */
export async function insertLiveGraduates(
  db: Kysely<Database>,
  rows: readonly LiveGraduate[],
  opts: { chain: string; discoverySource: string; now: Date; dayKey: string },
): Promise<{ inserted: number; seen: number }> {
  const byAddress = new Map<string, LiveGraduate>();
  for (const r of rows) if (!byAddress.has(r.address)) byAddress.set(r.address, r);
  const unique = [...byAddress.values()];
  if (unique.length === 0) return { inserted: 0, seen: 0 };
  let inserted = 0;
  await db.transaction().execute(async (trx) => {
    const added = await sql<{ id: number }>`
      insert into coins (chain, address, ticker, name, launchpad, launched_at, creator_wallet,
                         graduated_at, discovery_source)
      select ${opts.chain}, t.address, t.ticker, t.name, t.launchpad, t.launched_at,
             t.creator_wallet, t.graduated_at, ${opts.discoverySource}
      from unnest(
        ${unique.map((r) => r.address)}::text[],
        ${unique.map((r) => withoutNul(r.ticker))}::text[],
        ${unique.map((r) => withoutNul(r.name))}::text[],
        ${unique.map((r) => r.launchpad)}::text[],
        ${unique.map((r) => r.launchedAt)}::timestamptz[],
        ${unique.map((r) => r.creatorWallet)}::text[],
        ${unique.map((r) => r.graduatedAt)}::timestamptz[]
      ) as t(address, ticker, name, launchpad, launched_at, creator_wallet, graduated_at)
      on conflict (chain, address) do nothing
      returning id
    `.execute(trx);
    inserted = added.rows.length;
    if (inserted === 0) return;
    await sql`
      insert into coin_stages (coin_id, stage, status, attempts, version, started_at, finished_at, updated_at)
      select id, 'discovered', 'done', 1, 1, ${opts.now}, ${opts.now}, ${opts.now}
      from unnest(${added.rows.map((r) => r.id)}::bigint[]) as t(id)
      on conflict (coin_id, stage) do nothing
    `.execute(trx);
    await bumpLiveCounters(trx, opts.dayKey, { found: inserted }, opts.now);
  });
  return { inserted, seen: unique.length };
}

/** The latest graduation time among all coins, or null when there is none. */
export async function latestGraduatedAt(db: Kysely<Database>): Promise<Date | null> {
  const r = await db
    .selectFrom('coins')
    .select((eb) => eb.fn.max('graduated_at').as('latest'))
    .executeTakeFirst();
  return r?.latest ?? null;
}

// --------------------------------------------------------- triggering and sweeping

/**
 * Marks coins as triggered: a `pending` candles row, which a worker then claims. A coin that
 * already has any candles row is left alone. Returns the ids that were new, and adds them to the
 * day's `triggered` counter in the same transaction.
 */
export async function triggerCandles(
  db: Kysely<Database>,
  coinIds: readonly number[],
  opts: { now: Date; dayKey: string; counter: 'triggered' | 'swept' },
): Promise<number[]> {
  if (coinIds.length === 0) return [];
  let fresh: number[] = [];
  await db.transaction().execute(async (trx) => {
    const r = await sql<{ coin_id: number }>`
      insert into coin_stages (coin_id, stage, status, updated_at)
      select id, 'candles', 'pending', ${opts.now}
      from unnest(${[...coinIds]}::bigint[]) as t(id)
      on conflict (coin_id, stage) do nothing
      returning coin_id
    `.execute(trx);
    fresh = r.rows.map((x) => x.coin_id);
    await bumpLiveCounters(trx, opts.dayKey, { [opts.counter]: fresh.length }, opts.now);
  });
  return fresh;
}

/**
 * Watched coins at least `minAgeSeconds` old whose candles were never attempted, by id, for the
 * sweep (paged by `afterId`).
 */
export async function listWatchedOlderThan(
  db: Kysely<Database>,
  w: WatchSpec,
  minAgeSeconds: number,
  o: { afterId: number; limit: number },
): Promise<number[]> {
  const rows = await db
    .selectFrom('coins')
    .select('id')
    .where((eb) => isWatched(eb, w))
    .where((eb) => candlesNeverAttempted(eb))
    .where(sql<boolean>`${ageSeconds(w.now)} >= ${minAgeSeconds}::float8`)
    .where('id', '>', o.afterId)
    .orderBy('id')
    .limit(o.limit)
    .execute();
  return rows.map((r) => r.id);
}

/**
 * Writes the market cap a coin had when the watch queued its fetch (`last_trigger_market_cap_usd`).
 * The figure never goes down: the larger of the stored value and the new one is kept.
 */
export async function recordTriggerMarketCaps(
  db: Kysely<Database>,
  rows: readonly { id: number; marketCapUsd: number }[],
  now: Date,
): Promise<void> {
  if (rows.length === 0) return;
  await sql`
    update coins set last_trigger_market_cap_usd = greatest(coins.last_trigger_market_cap_usd, t.mcap),
      updated_at = ${now}
    from unnest(${rows.map((r) => r.id)}::bigint[], ${rows.map((r) => r.marketCapUsd)}::float8[])
      as t(id, mcap)
    where coins.id = t.id
  `.execute(db);
}

/**
 * Puts the candles and metrics stages of coins back to `pending` (`reopenStages`, one coin at a
 * time: it only changes rows that are `done` or `skipped`) and adds the number of coins reopened
 * to the named counter of the day. Returns the ids that were reopened.
 */
export async function reopenForFetch(
  db: Kysely<Database>,
  coinIds: readonly number[],
  opts: { now: Date; dayKey: string; counter: string },
): Promise<number[]> {
  const reopened: number[] = [];
  for (const id of coinIds) {
    const n = await reopenStages(db, id, ['candles', 'metrics'], opts.now);
    if (n > 0) reopened.push(id);
  }
  await bumpLiveCounters(db, opts.dayKey, { [opts.counter]: reopened.length }, opts.now);
  return reopened;
}

export interface LastLookSpec extends WatchSpec {
  /** A coin this old or older gets its last look. */
  minAgeSeconds: number;
}

/**
 * Watched coins due a last look: at least `minAgeSeconds` old, listed or not (a listed coin can
 * run and fall back between two hourly polls too), with candles and
 * metrics both finished (`done` or `skipped`) and the candles last finished before the coin was
 * `minAgeSeconds` old. Once the look has been fetched the candles finish after that age, so the
 * coin is not found again. By id, paged by `afterId`.
 */
export async function listLastLook(
  db: Kysely<Database>,
  w: LastLookSpec,
  o: { afterId: number; limit: number },
): Promise<number[]> {
  const rows = await db
    .selectFrom('coins')
    .select('id')
    .where((eb) => isWatched(eb, w))
    .where(sql<boolean>`${ageSeconds(w.now)} >= ${w.minAgeSeconds}::float8`)
    .where(
      sql<boolean>`exists (select 1 from coin_stages c where c.coin_id = coins.id and c.stage = 'candles'
        and c.status in ('done', 'skipped')
        and c.finished_at < coins.graduated_at + make_interval(secs => ${w.minAgeSeconds}::float8))`,
    )
    .where(
      sql<boolean>`exists (select 1 from coin_stages m where m.coin_id = coins.id and m.stage = 'metrics'
        and m.status in ('done', 'skipped'))`,
    )
    .where('id', '>', o.afterId)
    .orderBy('id')
    .limit(o.limit)
    .execute();
  return rows.map((r) => r.id);
}

export interface WatchedFailure {
  id: number;
  address: string;
  /** The candles stage is `failed`. */
  candlesFailed: boolean;
  /** The metrics stage is `failed` and the candles stage is not (candles are retried first). */
  metricsFailed: boolean;
}

/**
 * Watched coins whose candles stage is `failed`, or whose metrics stage is `failed` while the
 * candles are not: paged by `afterId`.
 */
export async function listWatchedFailures(
  db: Kysely<Database>,
  w: WatchSpec,
  o: { afterId: number; limit: number },
): Promise<WatchedFailure[]> {
  const failed = (stage: string) =>
    sql<boolean>`exists (select 1 from coin_stages c where c.coin_id = coins.id and c.stage = ${stage} and c.status = 'failed')`;
  const rows = await db
    .selectFrom('coins')
    .select([
      'id',
      'address',
      failed('candles').as('candles_failed'),
      failed('metrics').as('metrics_failed'),
    ])
    .where((eb) => isWatched(eb, w))
    .where(sql<boolean>`(${failed('candles')} or ${failed('metrics')})`)
    .where('id', '>', o.afterId)
    .orderBy('id')
    .limit(o.limit)
    .execute();
  return rows.map((r) => ({
    id: r.id,
    address: r.address,
    candlesFailed: r.candles_failed,
    metricsFailed: r.metrics_failed && !r.candles_failed,
  }));
}

/** Coins with a candles row that nobody has claimed yet (triggered, waiting), by id. */
export async function listWaitingCandles(
  db: Kysely<Database>,
  o: { afterId: number; limit: number },
): Promise<number[]> {
  const r = await sql<{ coin_id: number }>`
    select coin_id from coin_stages
    where stage = 'candles' and status = 'pending' and attempts = 0 and started_at is null
      and coin_id > ${o.afterId}
    order by coin_id limit ${o.limit}
  `.execute(db);
  return r.rows.map((x) => x.coin_id);
}

// ------------------------------------------------------------------- usage

export interface RunUsageSince {
  runId: number;
  /** Units at the last sample at or before `now`. */
  latest: number;
  /** Units at the last sample at or before `since`; 0 when the run had none then. */
  before: number;
}

/**
 * Per run, what a provider's units were at `now` and at `since`, from the usage samples every
 * run writes. A run's use in the period is `latest - before`. Only runs with a sample in the
 * period are listed (the others used nothing in it).
 */
export async function usageByRunSince(
  db: Kysely<Database>,
  provider: string,
  since: Date,
  now: Date,
): Promise<RunUsageSince[]> {
  const r = await sql<{ run_id: number; latest: number; before: number }>`
    with runs as (
      select distinct run_id from provider_usage_samples
      where provider = ${provider} and sampled_at > ${since} and sampled_at <= ${now}
    )
    select r.run_id,
      (select x.units from provider_usage_samples x
        where x.run_id = r.run_id and x.provider = ${provider} and x.sampled_at <= ${now}
        order by x.sampled_at desc limit 1) as latest,
      coalesce((select x.units from provider_usage_samples x
        where x.run_id = r.run_id and x.provider = ${provider} and x.sampled_at <= ${since}
        order by x.sampled_at desc limit 1), 0) as before
    from runs r
  `.execute(db);
  return r.rows.map((x) => ({
    runId: x.run_id,
    latest: Number(x.latest),
    before: Number(x.before),
  }));
}

/** Requests and units a provider used in the period, over all runs. */
export async function usageTotalSince(
  db: Kysely<Database>,
  provider: string,
  since: Date,
  now: Date,
): Promise<{ requests: number; units: number }> {
  const r = await sql<{ requests: string | null; units: number | null }>`
    with runs as (
      select distinct run_id from provider_usage_samples
      where provider = ${provider} and sampled_at > ${since} and sampled_at <= ${now}
    )
    select
      sum((select x.requests from provider_usage_samples x
        where x.run_id = r.run_id and x.provider = ${provider} and x.sampled_at <= ${now}
        order by x.sampled_at desc limit 1)
      - coalesce((select x.requests from provider_usage_samples x
        where x.run_id = r.run_id and x.provider = ${provider} and x.sampled_at <= ${since}
        order by x.sampled_at desc limit 1), 0))::text as requests,
      sum((select x.units from provider_usage_samples x
        where x.run_id = r.run_id and x.provider = ${provider} and x.sampled_at <= ${now}
        order by x.sampled_at desc limit 1)
      - coalesce((select x.units from provider_usage_samples x
        where x.run_id = r.run_id and x.provider = ${provider} and x.sampled_at <= ${since}
        order by x.sampled_at desc limit 1), 0)) as units
    from runs r
  `.execute(db);
  return { requests: Number(r.rows[0]?.requests ?? 0), units: Number(r.rows[0]?.units ?? 0) };
}

/**
 * Coins whose candles stage finished `done` in the period under a `live` run, and how many of
 * those have an ATH at or above `listedUsd` (known once the metrics stage has run).
 */
export async function liveFetchedSince(
  db: Kysely<Database>,
  since: Date,
  now: Date,
  listedUsd: number,
): Promise<{ fetched: number; listed: number }> {
  const r = await sql<{ fetched: string; listed: string }>`
    select count(*)::text as fetched,
           count(*) filter (where c.ath_market_cap_usd >= ${listedUsd})::text as listed
    from coin_stages s
    join ingest_runs r on r.id = s.run_id and r.kind = 'live'
    join coins c on c.id = s.coin_id
    where s.stage = 'candles' and s.status = 'done'
      and s.finished_at > ${since} and s.finished_at <= ${now}
  `.execute(db);
  return { fetched: Number(r.rows[0]?.fetched ?? 0), listed: Number(r.rows[0]?.listed ?? 0) };
}
