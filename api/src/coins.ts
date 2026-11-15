import { sql, type Kysely, type SelectQueryBuilder } from 'kysely';
import type { Database } from '@memecoinipedia/db';
import { decodeCursor, encodeCursor, RELEVANCE_OFFSET_CAP, type CursorPosition } from './cursor.js';
import { notFound } from './errors.js';
import { ADDRESS_PATTERN, creatorText, isoSecond } from './format.js';
import { paramsHash, type ListParams } from './params.js';

/**
 * A coin is listed when its ATH market cap is at least this many dollars. The
 * partial indexes in db/migrations/0020_api_search.sql carry the same number.
 */
export const LISTED_MIN_ATH_USD = 100_000;

/** pg_trgm's default similarity threshold, set explicitly for every search. */
const SIMILARITY_THRESHOLD = 0.3;

type Db = Kysely<Database>;
type Coins = SelectQueryBuilder<Database, 'coins', object>;

export interface CoinSummary {
  chain: string;
  address: string;
  ticker: string | null;
  name: string | null;
  image_url: string | null;
  sensitive: boolean;
  launched_at: string | null;
  ath_market_cap_usd: number;
  ath_at: string;
  seconds_to_ath: number | null;
  current_market_cap_usd: number | null;
  status: 'alive' | 'dead' | 'rugged' | 'unknown';
  primary_narrative: string | null;
  secondary_narratives: string[];
}

export interface CoinPage {
  data: CoinSummary[];
  page: { limit: number; next_cursor: string | null; total: number };
}

const SUMMARY_COLUMNS = [
  'id',
  'chain',
  'address',
  'ticker',
  'name',
  'image_storage_key',
  'sensitive',
  'launched_at',
  'ath_market_cap_usd',
  'ath_at',
  'seconds_to_ath',
  'current_market_cap_usd',
  'status',
  'primary_narrative',
  'secondary_narratives',
] as const;

/** Microsecond-exact text form of launched_at, used to build cursors. */
const launchedKey = sql<
  string | null
>`to_char(launched_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

interface SummaryRow {
  id: number;
  chain: string;
  address: string;
  ticker: string | null;
  name: string | null;
  image_storage_key: string | null;
  sensitive: boolean;
  launched_at: Date | null;
  ath_market_cap_usd: number | null;
  ath_at: Date | null;
  seconds_to_ath: number | null;
  current_market_cap_usd: number | null;
  status: CoinSummary['status'];
  primary_narrative: string | null;
  secondary_narratives: string[];
  launched_key: string | null;
}

export function toSummary(r: Omit<SummaryRow, 'id' | 'launched_key'>): CoinSummary {
  return {
    chain: r.chain,
    address: r.address,
    ticker: creatorText(r.ticker),
    name: creatorText(r.name),
    // No image storage yet (decision Q6): never expose a third-party URL.
    image_url: null,
    sensitive: r.sensitive,
    launched_at: isoSecond(r.launched_at),
    ath_market_cap_usd: r.ath_market_cap_usd as number,
    ath_at: isoSecond(r.ath_at) as string,
    seconds_to_ath: r.seconds_to_ath,
    current_market_cap_usd: r.current_market_cap_usd,
    status: r.status,
    primary_narrative: r.primary_narrative,
    secondary_narratives: r.secondary_narratives,
  };
}

/** Escapes LIKE metacharacters so `q` is matched literally. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

interface Keyword {
  q: string;
  /** LIKE pattern for "ticker starts with q". */
  prefix: string;
}

const lowerQ = (k: Keyword) => sql<string>`lower(${k.q})`;
const lowerPrefix = (k: Keyword) => sql<string>`lower(${k.prefix})`;

/** The rows a request can return, before sorting and paging. */
function filtered(db: Db, p: ListParams, keyword: Keyword | null, isAddress: boolean): Coins {
  let qb: Coins = db.selectFrom('coins').where('ath_market_cap_usd', '>=', LISTED_MIN_ATH_USD);

  if (p.q !== null) {
    if (isAddress) {
      qb = qb.where('address', '=', p.q);
    } else {
      const k = keyword!;
      // Prefix and exact ticker match, or trigram similarity on ticker or name.
      qb = qb.where(
        sql<boolean>`(lower(ticker) like ${lowerPrefix(k)} or lower(ticker) % ${lowerQ(k)} or lower(name) % ${lowerQ(k)})`,
      );
    }
  }
  if (p.narrative) {
    qb =
      p.narrativeScope === 'primary'
        ? qb.where('primary_narrative', 'in', p.narrative)
        : qb.where(
            sql<boolean>`(primary_narrative = any(${p.narrative}::text[]) or secondary_narratives && ${p.narrative}::text[])`,
          );
  }
  if (p.status) qb = qb.where('status', 'in', p.status);
  if (p.athMin !== null) qb = qb.where('ath_market_cap_usd', '>=', p.athMin);
  if (p.athMax !== null) qb = qb.where('ath_market_cap_usd', '<=', p.athMax);
  if (p.launchedFrom !== null) {
    qb = qb.where(sql<boolean>`launched_at >= ${p.launchedFrom}::timestamptz`);
  }
  if (p.launchedTo !== null) {
    qb = qb.where(sql<boolean>`launched_at < ${p.launchedTo}::timestamptz`);
  }
  return qb;
}

/** Runs `fn` in a transaction with the trigram threshold set, so `%` means what we say. */
function withTrigram<T>(db: Db, fn: (trx: Db) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`select set_config('pg_trgm.similarity_threshold', ${String(SIMILARITY_THRESHOLD)}, true)`.execute(
      trx,
    );
    return fn(trx);
  });
}

export async function searchCoins(db: Db, p: ListParams): Promise<CoinPage> {
  const hash = paramsHash(p);
  const position = p.cursor === null ? null : decodeCursor(p.cursor, hash, p.sort);

  const isAddress = p.q !== null && ADDRESS_PATTERN.test(p.q);
  const keyword: Keyword | null =
    p.q !== null && !isAddress ? { q: p.q, prefix: `${escapeLike(p.q)}%` } : null;

  // Relevance pages by offset and stops at the cap; the other sorts use keysets.
  const offset = position?.kind === 'offset' ? position.offset : 0;
  const size = p.sort === 'relevance' ? Math.min(p.limit, RELEVANCE_OFFSET_CAP - offset) : p.limit;

  const run = <T>(fn: (conn: Db) => Promise<T>) => (keyword ? withTrigram(db, fn) : fn(db));
  const [total, rows] = await Promise.all([
    run(async (conn) => {
      const r = await filtered(conn, p, keyword, isAddress)
        .select(sql<number>`count(*)`.as('n'))
        .executeTakeFirstOrThrow();
      return r.n;
    }),
    run((conn) => page(conn, p, keyword, isAddress, position, size + 1)),
  ]);

  const items = rows.slice(0, size);
  let nextCursor: string | null = null;
  if (rows.length > size) {
    const last = items[items.length - 1]!;
    if (p.sort === 'relevance') {
      if (offset + size < RELEVANCE_OFFSET_CAP) nextCursor = encodeCursor(hash, [offset + size]);
    } else if (p.sort === 'ath_desc' || p.sort === 'ath_asc') {
      nextCursor = encodeCursor(hash, [last.ath_market_cap_usd, last.id]);
    } else {
      nextCursor = encodeCursor(
        hash,
        last.launched_key === null ? [1, null, last.id] : [0, last.launched_key, last.id],
      );
    }
  }
  return {
    data: items.map(toSummary),
    page: { limit: p.limit, next_cursor: nextCursor, total },
  };
}

/** Fetches up to `want` rows (one more than a page, so the caller can tell whether another exists). */
async function page(
  db: Db,
  p: ListParams,
  keyword: Keyword | null,
  isAddress: boolean,
  position: CursorPosition | null,
  want: number,
): Promise<SummaryRow[]> {
  const base = () =>
    filtered(db, p, keyword, isAddress)
      .select(SUMMARY_COLUMNS)
      .select(launchedKey.as('launched_key'));

  if (p.sort === 'relevance') {
    // Only reachable with q. Order: exact ticker, ticker prefix, similarity, higher ATH.
    const offset = position?.kind === 'offset' ? position.offset : 0;
    if (isAddress) {
      return (await base().limit(want).execute()) as SummaryRow[];
    }
    const k = keyword!;
    const tier = sql`case when lower(ticker) = ${lowerQ(k)} then 0 when lower(ticker) like ${lowerPrefix(k)} then 1 else 2 end`;
    const similarity = sql`coalesce(greatest(similarity(lower(ticker), ${lowerQ(k)}), similarity(lower(name), ${lowerQ(k)})), 0)`;
    return (await base()
      .orderBy(tier, 'asc')
      .orderBy(similarity, 'desc')
      .orderBy('ath_market_cap_usd', 'desc')
      .orderBy('id', 'desc')
      .limit(want)
      .offset(offset)
      .execute()) as SummaryRow[];
  }

  if (p.sort === 'ath_desc' || p.sort === 'ath_asc') {
    const desc = p.sort === 'ath_desc';
    let qb = base();
    if (position?.kind === 'ath') {
      qb = qb.where(
        desc
          ? sql<boolean>`(ath_market_cap_usd, id) < (${position.ath}::double precision, ${position.id}::bigint)`
          : sql<boolean>`(ath_market_cap_usd, id) > (${position.ath}::double precision, ${position.id}::bigint)`,
      );
    }
    const dir = desc ? 'desc' : 'asc';
    return (await qb
      .orderBy('ath_market_cap_usd', dir)
      .orderBy('id', dir)
      .limit(want)
      .execute()) as SummaryRow[];
  }

  // launched_*: coins with a launch time first, then those without, in id order.
  const desc = p.sort === 'launched_desc';
  const dir = desc ? 'desc' : 'asc';
  const rows: SummaryRow[] = [];
  const inPhase0 = position === null || (position.kind === 'launched' && position.phase === 0);
  if (inPhase0) {
    let qb = base().where('launched_at', 'is not', null);
    if (position?.kind === 'launched' && position.phase === 0) {
      qb = qb.where(
        desc
          ? sql<boolean>`(launched_at, id) < (${position.at}::timestamptz, ${position.id}::bigint)`
          : sql<boolean>`(launched_at, id) > (${position.at}::timestamptz, ${position.id}::bigint)`,
      );
    }
    rows.push(
      ...((await qb
        .orderBy('launched_at', dir)
        .orderBy('id', dir)
        .limit(want)
        .execute()) as SummaryRow[]),
    );
  }
  if (rows.length < want) {
    let qb = base().where('launched_at', 'is', null);
    if (position?.kind === 'launched' && position.phase === 1) {
      qb = qb.where('id', desc ? '<' : '>', position.id);
    }
    rows.push(
      ...((await qb
        .orderBy('id', dir)
        .limit(want - rows.length)
        .execute()) as SummaryRow[]),
    );
  }
  return rows;
}

// ------------------------------------------------------------------- one coin

export interface PoolRef {
  address: string;
  dex: string;
}

export interface ParentRef {
  chain: string;
  address: string;
  ticker: string | null;
  name: string | null;
  listed: boolean;
}

export interface Coin extends CoinSummary {
  launchpad: string | null;
  creator_wallet: string | null;
  quote_token: string | null;
  graduated_at: string | null;
  description: string | null;
  socials: { website: string | null; twitter: string | null; telegram: string | null };
  ath_pool: PoolRef | null;
  primary_pool: PoolRef | null;
  ath_wick_market_cap_usd: number | null;
  ath_wick_at: string | null;
  seconds_above_100k: number | null;
  seconds_above_1m: number | null;
  seconds_above_10m: number | null;
  seconds_above_100m: number | null;
  max_drawdown_pct: number | null;
  rug_pattern: boolean | null;
  metric_flags: string[];
  metrics_as_of: string | null;
  current_price_usd: number | null;
  current_liquidity_usd: number | null;
  current_volume_24h_usd: number | null;
  current_refreshed_at: string | null;
  status_changed_at: string | null;
  narrative_confidence: number | null;
  narrative_reason: string | null;
  summary: string | null;
  classified_at: string | null;
  parent: ParentRef | null;
}

/** Only https:// links survive; anything else is null (the contract says ingestion drops them). */
function socialLink(v: unknown): string | null {
  return typeof v === 'string' && v.startsWith('https://') ? v : null;
}

const isListed = (ath: number | null) => ath !== null && ath >= LISTED_MIN_ATH_USD;

export async function getCoin(db: Db, chain: string, address: string): Promise<Coin> {
  const row = await db
    .selectFrom('coins')
    .select([
      ...SUMMARY_COLUMNS,
      'launchpad',
      'creator_wallet',
      'quote_token',
      'graduated_at',
      'description',
      'socials',
      'ath_pool_id',
      'ath_wick_market_cap_usd',
      'ath_wick_at',
      'seconds_above_100k',
      'seconds_above_1m',
      'seconds_above_10m',
      'seconds_above_100m',
      'max_drawdown_pct',
      'rug_pattern',
      'metric_flags',
      'metrics_as_of',
      'current_price_usd',
      'current_liquidity_usd',
      'current_volume_24h_usd',
      'current_refreshed_at',
      'status_changed_at',
      'narrative_confidence',
      'narrative_reason',
      'summary',
      'classified_at',
      'parent_coin_id',
      'parent_address',
    ])
    .where('chain', '=', chain)
    .where('address', '=', address)
    .executeTakeFirst();
  if (!row) throw notFound('unknown_coin', 'no coin is held for this chain and address');
  if (!isListed(row.ath_market_cap_usd)) {
    throw notFound(
      'not_listed',
      'the coin is held but its ATH is below $100,000 or not computed yet',
    );
  }

  const [athPool, primaryPool, parent] = await Promise.all([
    row.ath_pool_id === null
      ? null
      : db
          .selectFrom('pools')
          .select(['address', 'dex'])
          .where('id', '=', row.ath_pool_id)
          .executeTakeFirst(),
    db
      .selectFrom('pools')
      .select(['address', 'dex'])
      .where('coin_id', '=', row.id)
      .where('is_primary', '=', true)
      .orderBy('id')
      .limit(1)
      .executeTakeFirst(),
    row.parent_coin_id === null
      ? null
      : db
          .selectFrom('coins')
          .select(['chain', 'address', 'ticker', 'name', 'ath_market_cap_usd'])
          .where('id', '=', row.parent_coin_id)
          .executeTakeFirst(),
  ]);

  const socials = (row.socials ?? {}) as Record<string, unknown>;
  let parentRef: ParentRef | null = null;
  if (parent) {
    parentRef = {
      chain: parent.chain,
      address: parent.address,
      ticker: creatorText(parent.ticker),
      name: creatorText(parent.name),
      listed: isListed(parent.ath_market_cap_usd),
    };
  } else if (row.parent_address !== null) {
    // The parent is named but we hold nothing for it.
    parentRef = {
      chain: row.chain,
      address: row.parent_address,
      ticker: null,
      name: null,
      listed: false,
    };
  }

  return {
    ...toSummary(row),
    launchpad: row.launchpad,
    creator_wallet: row.creator_wallet,
    quote_token: row.quote_token,
    graduated_at: isoSecond(row.graduated_at),
    description: creatorText(row.description),
    socials: {
      website: socialLink(socials.website),
      twitter: socialLink(socials.twitter),
      telegram: socialLink(socials.telegram),
    },
    ath_pool: athPool ? { address: athPool.address, dex: athPool.dex } : null,
    primary_pool: primaryPool ? { address: primaryPool.address, dex: primaryPool.dex } : null,
    ath_wick_market_cap_usd: row.ath_wick_market_cap_usd,
    ath_wick_at: isoSecond(row.ath_wick_at),
    seconds_above_100k: row.seconds_above_100k,
    seconds_above_1m: row.seconds_above_1m,
    seconds_above_10m: row.seconds_above_10m,
    seconds_above_100m: row.seconds_above_100m,
    max_drawdown_pct: row.max_drawdown_pct,
    rug_pattern: row.rug_pattern,
    metric_flags: row.metric_flags,
    metrics_as_of: isoSecond(row.metrics_as_of),
    current_price_usd: row.current_price_usd,
    current_liquidity_usd: row.current_liquidity_usd,
    current_volume_24h_usd: row.current_volume_24h_usd,
    current_refreshed_at: isoSecond(row.current_refreshed_at),
    status_changed_at: isoSecond(row.status_changed_at),
    narrative_confidence: row.narrative_confidence,
    narrative_reason: row.narrative_reason,
    summary: row.summary,
    classified_at: isoSecond(row.classified_at),
    parent: parentRef,
  };
}
