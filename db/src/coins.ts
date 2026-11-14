import { sql, type Kysely } from 'kysely';
import type { Database } from './types.js';

export interface CoinIdentity {
  chain: string;
  address: string;
  ticker?: string | null;
  name?: string | null;
  launchpad?: string | null;
}

/**
 * Inserts a coin or, when `(chain, address)` exists, updates only the fields
 * that were passed (undefined fields are left alone). Returns the coin id.
 */
export async function upsertCoin(db: Kysely<Database>, coin: CoinIdentity): Promise<number> {
  const update: Record<string, unknown> = { updated_at: sql`now()` };
  for (const key of ['ticker', 'name', 'launchpad'] as const) {
    if (coin[key] !== undefined) update[key] = coin[key];
  }
  const row = await db
    .insertInto('coins')
    .values({
      chain: coin.chain,
      address: coin.address,
      ticker: coin.ticker ?? null,
      name: coin.name ?? null,
      launchpad: coin.launchpad ?? null,
    })
    .onConflict((oc) => oc.columns(['chain', 'address']).doUpdateSet(update))
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}
