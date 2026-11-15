import { sql, type Kysely } from 'kysely';
import type { Database } from './types.js';

export interface PoolInput {
  chain: string;
  address: string;
  coinId: number;
  dex: string;
  isPrimary: boolean;
  isGraduationPool: boolean;
  quoteToken?: string | null;
  /** Unix seconds as the provider reports it, which is not always right. */
  createdAtChain?: number | null;
  sourcePairId?: string | null;
}

export interface StoredPool {
  id: number;
  chain: string;
  address: string;
  coinId: number;
  dex: string;
  isPrimary: boolean;
  isGraduationPool: boolean;
  quoteToken: string | null;
  createdAtChain: number | null;
  sourcePairId: string | null;
}

/** A pool address belongs to one coin; `upsertPool` throws this for another coin's pool. */
export class PoolOwnedByOtherCoinError extends Error {
  constructor(
    readonly address: string,
    readonly ownerCoinId: number,
  ) {
    super(`Pool ${address} already belongs to coin ${ownerCoinId}`);
    this.name = 'PoolOwnedByOtherCoinError';
  }
}

const toDate = (s: number | null | undefined): Date | null =>
  s === null || s === undefined ? null : new Date(s * 1000);

/**
 * Inserts a pool, or, when `(chain, address)` exists, updates the fields that
 * differ. Returns the pool id. Calling it again with the same values writes
 * nothing (updated_at stays). A pool address belongs to one coin: passing a
 * different `coinId` for an existing address throws `PoolOwnedByOtherCoinError`.
 */
export async function upsertPool(db: Kysely<Database>, pool: PoolInput): Promise<number> {
  const values = {
    dex: pool.dex,
    is_primary: pool.isPrimary,
    is_graduation_pool: pool.isGraduationPool,
    quote_token: pool.quoteToken ?? null,
    created_at_chain: toDate(pool.createdAtChain),
    source_pair_id: pool.sourcePairId ?? null,
  };
  return db.transaction().execute(async (trx) => {
    await trx
      .insertInto('pools')
      .values({ chain: pool.chain, address: pool.address, coin_id: pool.coinId, ...values })
      .onConflict((oc) => oc.columns(['chain', 'address']).doNothing())
      .execute();
    const row = await trx
      .selectFrom('pools')
      .selectAll()
      .where('chain', '=', pool.chain)
      .where('address', '=', pool.address)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (row.coin_id !== pool.coinId) {
      throw new PoolOwnedByOtherCoinError(pool.address, row.coin_id);
    }
    const same =
      row.dex === values.dex &&
      row.is_primary === values.is_primary &&
      row.is_graduation_pool === values.is_graduation_pool &&
      row.quote_token === values.quote_token &&
      (row.created_at_chain?.getTime() ?? null) === (values.created_at_chain?.getTime() ?? null) &&
      row.source_pair_id === values.source_pair_id;
    if (!same) {
      await trx
        .updateTable('pools')
        .set({ ...values, updated_at: sql`now()` })
        .where('id', '=', row.id)
        .execute();
    }
    return row.id;
  });
}

export type TakeOverResult =
  /** The pool now belongs to the coin (it did not before). `previousOwnerCoinId` held it as an ordinary other pool. */
  | { status: 'taken'; previousOwnerCoinId: number }
  /** The coin already owned it. Nothing changed. */
  | { status: 'own' }
  /** The present owner holds it as its own curve or graduation pool: it is not taken. */
  | { status: 'claimed_by_two'; ownerCoinId: number };

/**
 * Moves a pool to `pool.coinId` when its present owner holds it only as an ordinary other pool
 * (not its curve, not its graduation pool, not primary). One transaction, the row locked. Bars and
 * coverage are keyed by the pool's id (`candle_chunks.pool_id`, `candle_coverage.pool_id`), so they
 * move with it and nothing has to be fetched again. The previous owner's metrics stage goes back to
 * `pending` (zero attempts) in the same transaction, because its inputs changed. The pool's role,
 * dex, quote and times are set to what `pool` says. A pool that does not exist yet is an error.
 */
export async function takeOverPool(
  db: Kysely<Database>,
  pool: PoolInput,
  now: Date,
): Promise<TakeOverResult> {
  return db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom('pools')
      .selectAll()
      .where('chain', '=', pool.chain)
      .where('address', '=', pool.address)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (row.coin_id === pool.coinId) return { status: 'own' } as const;
    if (row.is_primary || row.is_graduation_pool) {
      return { status: 'claimed_by_two', ownerCoinId: row.coin_id } as const;
    }
    await trx
      .updateTable('pools')
      .set({
        coin_id: pool.coinId,
        dex: pool.dex,
        is_primary: pool.isPrimary,
        is_graduation_pool: pool.isGraduationPool,
        quote_token: pool.quoteToken ?? null,
        created_at_chain: toDate(pool.createdAtChain),
        source_pair_id: pool.sourcePairId ?? null,
        updated_at: sql`now()`,
      })
      .where('id', '=', row.id)
      .execute();
    await trx
      .updateTable('coin_stages')
      .set({ status: 'pending', attempts: 0, updated_at: now })
      .where('coin_id', '=', row.coin_id)
      .where('stage', '=', 'metrics')
      .where('status', 'in', ['done', 'skipped'])
      .execute();
    return { status: 'taken', previousOwnerCoinId: row.coin_id } as const;
  });
}

/** Two coins hold the same pool as their own curve or graduation pool. */
export class PoolClaimedByTwoCoinsError extends Error {
  constructor(
    readonly address: string,
    readonly coinId: number,
    readonly ownerCoinId: number,
  ) {
    super(
      `Pool ${address} is the curve or graduation pool of both coin ${coinId} and coin ${ownerCoinId}`,
    );
    this.name = 'PoolClaimedByTwoCoinsError';
  }
}

export interface MoveGraduationPoolResult {
  /** False when the pool already was the coin's one graduation pool: nothing changed. */
  moved: boolean;
  /** The pool that held the role before and no longer does, or null. */
  previousAddress: string | null;
  /** The pool was stored by this call (it was not held by any coin). */
  inserted: boolean;
  /** The pool was moved here from a coin that held it as an ordinary other pool. */
  previousOwnerCoinId: number | null;
}

/**
 * Makes `pool` the coin's graduation pool, in one transaction. Before and after, the coin has at
 * most one graduation pool. Rows are locked: the coin's pools, then the target.
 *
 * - The pool is not stored: it is inserted for the coin.
 * - Another coin holds it as an ordinary other pool (not primary, not graduation): it is taken over
 *   as `takeOverPool` does, its bars and coverage moving with it, and that coin's metrics stage goes
 *   back to pending. Another coin holding it as its own curve or graduation pool:
 *   `PoolClaimedByTwoCoinsError`, nothing written.
 * - The coin's pool that held the role loses it and `is_primary` and stays stored (an ordinary
 *   other pool; `poolCountsForMetrics` decides whether its bars count). Nothing is deleted.
 * - The coin's metrics stage goes back to pending (zero attempts) when it is done or skipped,
 *   because its inputs changed.
 *
 * The pool's dex, quote token, creation time and pair id are set to what `pool` says.
 * `pool.isPrimary` and `pool.isGraduationPool` are ignored: the role is the point.
 */
export async function moveGraduationPool(
  db: Kysely<Database>,
  pool: PoolInput,
  now: Date,
): Promise<MoveGraduationPoolResult> {
  return db.transaction().execute(async (trx) => {
    const mine = await trx
      .selectFrom('pools')
      .selectAll()
      .where('coin_id', '=', pool.coinId)
      .orderBy('id')
      .forUpdate()
      .execute();
    const holders = mine.filter((p) => p.is_graduation_pool);
    if (
      holders.length === 1 &&
      holders[0]!.address === pool.address &&
      holders[0]!.chain === pool.chain
    ) {
      return { moved: false, previousAddress: null, inserted: false, previousOwnerCoinId: null };
    }
    await trx
      .insertInto('pools')
      .values({
        chain: pool.chain,
        address: pool.address,
        coin_id: pool.coinId,
        dex: pool.dex,
        is_primary: true,
        is_graduation_pool: true,
        quote_token: pool.quoteToken ?? null,
        created_at_chain: toDate(pool.createdAtChain),
        source_pair_id: pool.sourcePairId ?? null,
      })
      .onConflict((oc) => oc.columns(['chain', 'address']).doNothing())
      .execute();
    const target = await trx
      .selectFrom('pools')
      .selectAll()
      .where('chain', '=', pool.chain)
      .where('address', '=', pool.address)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const inserted = !mine.some((p) => p.id === target.id) && target.coin_id === pool.coinId;
    let previousOwnerCoinId: number | null = null;
    if (target.coin_id !== pool.coinId) {
      if (target.is_primary || target.is_graduation_pool) {
        throw new PoolClaimedByTwoCoinsError(pool.address, pool.coinId, target.coin_id);
      }
      previousOwnerCoinId = target.coin_id;
      await trx
        .updateTable('coin_stages')
        .set({ status: 'pending', attempts: 0, updated_at: now })
        .where('coin_id', '=', target.coin_id)
        .where('stage', '=', 'metrics')
        .where('status', 'in', ['done', 'skipped'])
        .execute();
    }
    const previous = holders.filter((p) => p.id !== target.id);
    if (previous.length > 0) {
      await trx
        .updateTable('pools')
        .set({ is_primary: false, is_graduation_pool: false, updated_at: sql`now()` })
        .where(
          'id',
          'in',
          previous.map((p) => p.id),
        )
        .execute();
    }
    await trx
      .updateTable('pools')
      .set({
        coin_id: pool.coinId,
        dex: pool.dex,
        is_primary: true,
        is_graduation_pool: true,
        quote_token: pool.quoteToken ?? null,
        created_at_chain: toDate(pool.createdAtChain),
        source_pair_id: pool.sourcePairId ?? null,
        updated_at: sql`now()`,
      })
      .where('id', '=', target.id)
      .execute();
    await trx
      .updateTable('coin_stages')
      .set({ status: 'pending', attempts: 0, updated_at: now })
      .where('coin_id', '=', pool.coinId)
      .where('stage', '=', 'metrics')
      .where('status', 'in', ['done', 'skipped'])
      .execute();
    return {
      moved: true,
      previousAddress: previous[0]?.address ?? null,
      inserted,
      previousOwnerCoinId,
    };
  });
}

/** Every pool of a coin, oldest id first. */
export async function getCoinPools(db: Kysely<Database>, coinId: number): Promise<StoredPool[]> {
  const rows = await db
    .selectFrom('pools')
    .selectAll()
    .where('coin_id', '=', coinId)
    .orderBy('id')
    .execute();
  return rows.map((r) => ({
    id: r.id,
    chain: r.chain,
    address: r.address,
    coinId: r.coin_id,
    dex: r.dex,
    isPrimary: r.is_primary,
    isGraduationPool: r.is_graduation_pool,
    quoteToken: r.quote_token,
    createdAtChain: r.created_at_chain ? r.created_at_chain.getTime() / 1000 : null,
    sourcePairId: r.source_pair_id,
  }));
}

/**
 * Sets first_bar_at, last_bar_at and peak_liquidity_usd from the stored
 * candles of a pool (all resolutions). Writes only when a value changed.
 */
export async function refreshPoolBarStats(db: Kysely<Database>, poolId: number): Promise<void> {
  await sql`
    with s as (
      select min(first_t) as first_t, max(last_t) as last_t
      from candle_chunks where pool_id = ${poolId}
    ), l as (
      select max(x) as peak
      from candle_chunks c, unnest(c.liquidity_usd) as x where c.pool_id = ${poolId}
    )
    update pools p set
      first_bar_at = to_timestamp(s.first_t),
      last_bar_at = to_timestamp(s.last_t),
      peak_liquidity_usd = l.peak,
      updated_at = now()
    from s, l
    where p.id = ${poolId} and s.first_t is not null
      and (p.first_bar_at is distinct from to_timestamp(s.first_t)
        or p.last_bar_at is distinct from to_timestamp(s.last_t)
        or p.peak_liquidity_usd is distinct from l.peak)`.execute(db);
}
