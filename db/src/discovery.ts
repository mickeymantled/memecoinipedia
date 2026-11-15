import { sql, type Kysely } from 'kysely';
import type { Database } from './types.js';

/**
 * Bulk entry of coins found by a discovery source (a Dune result file, a feed)
 * and completion of their `discovered` stage.
 *
 * Idempotent: a coin that exists keeps every value it has. Only fields that are
 * null on the stored row are filled in from the new row, so a second source can
 * add what the first lacked but never overwrite it, and loading the same rows
 * twice changes nothing (not even `updated_at`).
 */

export interface DiscoveredCoin {
  chain: string;
  address: string;
  launchpad: string | null;
  /** Creation time. Not the graduation time. */
  launchedAt: Date | null;
  creatorWallet: string | null;
  /** Graduation time. Not the creation time. */
  graduatedAt: Date | null;
  discoverySource: string;
  roughAthMarketCapUsd: number | null;
}

export interface DiscoverResult {
  /** Rows given, after removing repeats of the same chain and address. */
  total: number;
  inserted: number;
  /** Existing coins that gained a value for a field that was null. */
  updated: number;
  unchanged: number;
  /** Coins whose `discovered` stage this call marked done. */
  stagesMarked: number;
}

const CHUNK = 500;

export async function discoverCoins(
  db: Kysely<Database>,
  coins: readonly DiscoveredCoin[],
  opts: { now: Date; runId?: number | null },
): Promise<DiscoverResult> {
  const seen = new Set<string>();
  const unique = coins.filter((c) => {
    const key = `${c.chain}\u0000${c.address}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const result: DiscoverResult = {
    total: unique.length,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    stagesMarked: 0,
  };

  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    await db.transaction().execute(async (trx) => {
      const touched = await trx
        .insertInto('coins')
        .values(
          chunk.map((c) => ({
            chain: c.chain,
            address: c.address,
            launchpad: c.launchpad,
            launched_at: c.launchedAt,
            creator_wallet: c.creatorWallet,
            graduated_at: c.graduatedAt,
            discovery_source: c.discoverySource,
            rough_ath_market_cap_usd: c.roughAthMarketCapUsd,
          })),
        )
        .onConflict((oc) =>
          oc
            .columns(['chain', 'address'])
            .doUpdateSet({
              launchpad: sql`coalesce(coins.launchpad, excluded.launchpad)`,
              launched_at: sql`coalesce(coins.launched_at, excluded.launched_at)`,
              creator_wallet: sql`coalesce(coins.creator_wallet, excluded.creator_wallet)`,
              graduated_at: sql`coalesce(coins.graduated_at, excluded.graduated_at)`,
              discovery_source: sql`coalesce(coins.discovery_source, excluded.discovery_source)`,
              rough_ath_market_cap_usd: sql`coalesce(coins.rough_ath_market_cap_usd, excluded.rough_ath_market_cap_usd)`,
              updated_at: opts.now,
            })
            .where(
              sql<boolean>`(coins.launchpad is null and excluded.launchpad is not null)
                or (coins.launched_at is null and excluded.launched_at is not null)
                or (coins.creator_wallet is null and excluded.creator_wallet is not null)
                or (coins.graduated_at is null and excluded.graduated_at is not null)
                or (coins.discovery_source is null and excluded.discovery_source is not null)
                or (coins.rough_ath_market_cap_usd is null and excluded.rough_ath_market_cap_usd is not null)`,
            ),
        )
        .returning(sql<boolean>`(xmax = 0)`.as('inserted'))
        .execute();
      const inserted = touched.filter((r) => r.inserted).length;
      result.inserted += inserted;
      result.updated += touched.length - inserted;
      result.unchanged += chunk.length - touched.length;

      const ids = await trx
        .selectFrom('coins')
        .select(['id', 'chain', 'address'])
        .where(
          'address',
          'in',
          chunk.map((c) => c.address),
        )
        .execute();
      const wanted = new Set(chunk.map((c) => `${c.chain}\u0000${c.address}`));
      const coinIds = ids
        .filter((r) => wanted.has(`${r.chain}\u0000${r.address}`))
        .map((r) => r.id);
      if (coinIds.length === 0) return;

      const marked = await trx
        .insertInto('coin_stages')
        .values(
          coinIds.map((coin_id) => ({
            coin_id,
            stage: 'discovered' as const,
            status: 'done' as const,
            attempts: 1,
            version: 1,
            run_id: opts.runId ?? null,
            started_at: opts.now,
            finished_at: opts.now,
            updated_at: opts.now,
          })),
        )
        .onConflict((oc) =>
          oc
            .columns(['coin_id', 'stage'])
            .doUpdateSet({
              status: 'done',
              last_error: null,
              run_id: opts.runId ?? null,
              started_at: opts.now,
              finished_at: opts.now,
              updated_at: opts.now,
            })
            .where('coin_stages.status', 'not in', ['done', 'skipped']),
        )
        .returning('coin_id')
        .execute();
      result.stagesMarked += marked.length;
    });
  }
  return result;
}
