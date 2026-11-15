import { sql, type ExpressionBuilder, type Kysely } from 'kysely';
import { STATUS_RULES, statusFromEvidence, type CoinStatus } from './coinMetrics.js';
import type { Database } from './types.js';

/**
 * What the daily refresh (issue #74) needs from the database: the listed coins in id order, the
 * write of Jupiter's figures with the status they imply, and the one predicate that picks the
 * coins to top up.
 */

const DAY_SECONDS = 86_400;

// ------------------------------------------------------------------ the listed coins

export interface ListedCoin {
  id: number;
  address: string;
  /** The coin's stored total supply, whole tokens (0 when unknown). */
  totalSupply: number;
}

/** Listed coins (ATH of `listedUsd` or more) in id order, `limit` of them after `afterId`. */
export async function listListedCoins(
  db: Kysely<Database>,
  o: { listedUsd: number; afterId: number; limit: number },
): Promise<ListedCoin[]> {
  const rows = await db
    .selectFrom('coins')
    .select(['id', 'address', 'total_supply'])
    .where('ath_market_cap_usd', '>=', o.listedUsd)
    .where('id', '>', o.afterId)
    .orderBy('id')
    .limit(o.limit)
    .execute();
  return rows.map((r) => ({ id: r.id, address: r.address, totalSupply: Number(r.total_supply) }));
}

export async function countListedCoins(db: Kysely<Database>, listedUsd: number): Promise<number> {
  const r = await db
    .selectFrom('coins')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('ath_market_cap_usd', '>=', listedUsd)
    .executeTakeFirstOrThrow();
  return Number(r.n);
}

// ------------------------------------------------------------------ storing a refresh

export interface RefreshFigure {
  id: number;
  /** Jupiter's figures, null for a mint it does not know or answered without them. */
  priceUsd: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
}

export interface RefreshOutcome {
  coins: number;
  /** Coins whose figures met the alive line at the refresh time. */
  metLine: number;
  /** Coins whose status changed, and what they changed to. */
  changed: number;
  toStatus: Record<CoinStatus, number>;
}

/** Jupiter's figures meet the alive line (the status rule's own thresholds). */
export function meetsAliveLine(f: Pick<RefreshFigure, 'liquidityUsd' | 'volume24hUsd'>): boolean {
  return (
    f.liquidityUsd !== null &&
    f.volume24hUsd !== null &&
    f.liquidityUsd >= STATUS_RULES.minLiquidityUsd &&
    f.volume24hUsd >= STATUS_RULES.minVolume24hUsd
  );
}

/**
 * Stores the `current_*` columns of many coins at `now`, sets `last_alive_at` forward to `now`
 * for the coins whose figures meet the alive line, and re-decides each coin's status with
 * `statusFromEvidence` (stored rug pattern, `last_alive_at`, history). `status_changed_at` moves
 * only when the status changes. A coin with no figures is stored with no price and no liquidity.
 * One read and one update for all the coins.
 */
export async function storeRefresh(
  db: Kysely<Database>,
  figures: readonly RefreshFigure[],
  now: Date,
): Promise<RefreshOutcome> {
  const out: RefreshOutcome = {
    coins: figures.length,
    metLine: 0,
    changed: 0,
    toStatus: { alive: 0, dead: 0, rugged: 0, unknown: 0 },
  };
  if (figures.length === 0) return out;
  const nowSec = Math.floor(now.getTime() / 1000);
  const rows = await db
    .selectFrom('coins')
    .select([
      'id',
      'rug_pattern',
      'last_alive_at',
      'status',
      'graduated_at',
      'launched_at',
      'ath_at',
    ])
    .where(
      'id',
      'in',
      figures.map((f) => f.id),
    )
    .execute();
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ids: number[] = [];
  const lastAlive: (Date | null)[] = [];
  const statuses: string[] = [];
  const kept: RefreshFigure[] = [];
  for (const f of figures) {
    const c = byId.get(f.id);
    if (!c) continue;
    const met = meetsAliveLine(f);
    if (met) out.metLine++;
    const storedSec = c.last_alive_at ? Math.floor(c.last_alive_at.getTime() / 1000) : null;
    // Only forwards.
    const newSec = met ? Math.max(storedSec ?? 0, nowSec) : storedSec;
    const historyStart = c.graduated_at ?? c.launched_at ?? c.ath_at;
    const status = statusFromEvidence({
      rugPattern: c.rug_pattern,
      lastAliveAt: newSec,
      hasWeekOfHistory:
        historyStart !== null &&
        nowSec - Math.floor(historyStart.getTime() / 1000) >=
          STATUS_RULES.deadAfterDays * DAY_SECONDS,
      now: nowSec,
    });
    out.toStatus[status]++;
    if (status !== c.status) out.changed++;
    ids.push(f.id);
    lastAlive.push(newSec === null ? null : new Date(newSec * 1000));
    statuses.push(status);
    kept.push(f);
  }
  if (ids.length === 0) return out;
  await sql`
    update coins set
      current_price_usd = t.price,
      current_market_cap_usd = t.mcap,
      current_liquidity_usd = t.liq,
      current_volume_24h_usd = t.vol,
      current_refreshed_at = ${now},
      last_alive_at = t.alive,
      status = t.status,
      status_changed_at = case when coins.status <> t.status then ${now} else coins.status_changed_at end,
      updated_at = ${now}
    from unnest(
      ${ids}::bigint[],
      ${kept.map((f) => f.priceUsd)}::float8[],
      ${kept.map((f) => f.marketCapUsd)}::float8[],
      ${kept.map((f) => f.liquidityUsd)}::float8[],
      ${kept.map((f) => f.volume24hUsd)}::float8[],
      ${lastAlive}::timestamptz[],
      ${statuses}::text[]
    ) as t(id, price, mcap, liq, vol, alive, status)
    where coins.id = t.id
  `.execute(db);
  return out;
}

// ----------------------------------------------------------------------- the top-up

export interface TopUpSpec {
  now: Date;
  /** Midnight UTC of the day: a coin whose candles finished today is not selected again. */
  dayStart: Date;
  /** ATH market cap at or above which a coin is listed. */
  listedUsd: number;
  /** Rule 1: the current market cap is at least this share of the stored ATH. */
  athShare: number;
  /** Rule 2: the newest stored bar is older than this many seconds. */
  staleBarSeconds: number;
}

const stageFinished = (stage: string, before?: Date) =>
  sql<boolean>`exists (select 1 from coin_stages s where s.coin_id = coins.id and s.stage = ${stage}
    and s.status in ('done', 'skipped')${before ? sql` and s.finished_at < ${before}` : sql``})`;

const newestBar = sql<Date | null>`(select max(p.last_bar_at) from pools p where p.coin_id = coins.id)`;

/**
 * The coins the top-up may reopen: listed, status alive, refreshed today, candles and metrics both
 * finished (so a coin being topped up is not selected again until its candles finish) with the
 * candles finished before today, and either rule 1 (current market cap at least `athShare` of the
 * ATH) or rule 2 (newest stored bar older than `staleBarSeconds`). One predicate, used to list,
 * to count and to count by rule.
 */
export function topUpWhere(eb: ExpressionBuilder<Database, 'coins'>, s: TopUpSpec) {
  return eb.and([
    eb('coins.ath_market_cap_usd', '>=', s.listedUsd),
    eb('coins.status', '=', 'alive'),
    eb('coins.current_refreshed_at', '>=', s.dayStart),
    sql<boolean>`${stageFinished('candles', s.dayStart)}`,
    sql<boolean>`${stageFinished('metrics')}`,
    eb.or([rule1(s), rule2(s)]),
  ]);
}

const rule1 = (s: TopUpSpec) =>
  sql<boolean>`coins.current_market_cap_usd >= coins.ath_market_cap_usd * ${s.athShare}::float8`;
const rule2 = (s: TopUpSpec) =>
  sql<boolean>`${newestBar} < ${s.now}::timestamptz - make_interval(secs => ${s.staleBarSeconds}::float8)`;

export async function listTopUp(
  db: Kysely<Database>,
  s: TopUpSpec,
  o: { afterId: number; limit: number },
): Promise<number[]> {
  const rows = await db
    .selectFrom('coins')
    .select('id')
    .where((eb) => topUpWhere(eb, s))
    .where('id', '>', o.afterId)
    .orderBy('id')
    .limit(o.limit)
    .execute();
  return rows.map((r) => r.id);
}

export interface TopUpCounts {
  /** Selected by either rule. */
  total: number;
  /** Selected by rule 1 (current market cap at least the share of the ATH). */
  byMarketCap: number;
  /** Selected by rule 2 (newest bar older than the limit). */
  byStaleBars: number;
}

/** How many coins the top-up would select now: in all, and by each rule (a coin can be in both). */
export async function countTopUp(db: Kysely<Database>, s: TopUpSpec): Promise<TopUpCounts> {
  const base = (eb: ExpressionBuilder<Database, 'coins'>) =>
    eb.and([
      eb('coins.ath_market_cap_usd', '>=', s.listedUsd),
      eb('coins.status', '=', 'alive'),
      eb('coins.current_refreshed_at', '>=', s.dayStart),
      sql<boolean>`${stageFinished('candles', s.dayStart)}`,
      sql<boolean>`${stageFinished('metrics')}`,
    ]);
  const r = await db
    .selectFrom('coins')
    .select([
      sql<string>`count(*) filter (where ${rule1(s)} or ${rule2(s)})`.as('total'),
      sql<string>`count(*) filter (where ${rule1(s)})`.as('m'),
      sql<string>`count(*) filter (where ${rule2(s)})`.as('b'),
    ])
    .where((eb) => base(eb))
    .executeTakeFirstOrThrow();
  return { total: Number(r.total), byMarketCap: Number(r.m), byStaleBars: Number(r.b) };
}

/** Listed coins whose candles are waiting or running: what a top-up adds to. */
export async function countListedInFlight(
  db: Kysely<Database>,
  listedUsd: number,
): Promise<number> {
  const r = await sql<{ n: string }>`
    select count(*)::text as n from coin_stages s join coins c on c.id = s.coin_id
    where s.stage = 'candles' and s.status in ('pending', 'running')
      and c.ath_market_cap_usd >= ${listedUsd}::float8`.execute(db);
  return Number(r.rows[0]?.n ?? 0);
}
