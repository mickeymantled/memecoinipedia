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
