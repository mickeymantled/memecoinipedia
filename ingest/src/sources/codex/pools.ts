import { SOLANA_NETWORK_ID } from './queries.js';

export interface PoolInfo {
  /** Pool (pair) address. */
  address: string;
  /** Codex pair id, `address:networkId`. This is the `symbol` getBars takes. */
  pairId: string;
  /** Exchange name as Codex reports it, for example "Raydium" or "PumpSwap". */
  exchange: string | null;
  /** Codex protocol label, for example "PumpAmm". Not verified for every venue. */
  protocol: string | null;
  /** Unix seconds, or null when Codex has none. */
  createdAt: number | null;
  liquidityUsd: number | null;
  /** Address or symbol of the quote (backing) token. */
  quoteToken: string | null;
  /** Mint address of the quote (backing) token, or null when Codex gives none. */
  quoteTokenAddress: string | null;
}

/**
 * The quote tokens an "other" pool (not the bonding curve, not the graduation pool) may have to
 * be stored and fetched: wrapped SOL, USDC and USDT, by mint address. Matching the address and
 * not the symbol, so a token that merely calls itself "SOL" does not pass. The constant lives in
 * /db (the metric loader applies the same rule there) and is re-exported from here.
 */
export { OTHER_POOL_QUOTE, OTHER_POOL_QUOTE_MINTS } from '@memecoinipedia/db';

export interface PoolsResult {
  pools: PoolInfo[];
  /** True when Codex returned its maximum of 250 pairs, so more may exist. */
  truncated: boolean;
}

export function pairIdFor(address: string): string {
  return `${address}:${SOLANA_NETWORK_ID}`;
}

/**
 * True for the pump.fun bonding curve. Same rule the probe used: a protocol
 * that mentions pump but not amm, on an exchange whose name is not an AMM,
 * swap or Raydium venue.
 */
export function isBondingCurvePool(pool: Pick<PoolInfo, 'protocol' | 'exchange'>): boolean {
  const protocol = pool.protocol ?? '';
  const exchange = pool.exchange ?? '';
  return /pump/i.test(protocol) && !/amm/i.test(protocol) && !/amm|swap|raydium/i.test(exchange);
}

export type GraduationPoolSource = 'migrated_pool_address' | 'closest_to_migration';

export interface GraduationPick {
  address: string;
  source: GraduationPoolSource;
  /** The matching entry from `pools`, or null when Codex named a pool it did not list. */
  pool: PoolInfo | null;
  /** Pool creation minus migration time, in seconds, when both are known. */
  deltaToMigrationSec: number | null;
  /**
   * True when the pick was made by closest creation time from a pairs list that
   * hit Codex's 250-pair cap, so the real graduation pool may be missing. Treat
   * the pick as unverified. Always false for a migrated pool address.
   */
  truncated: boolean;
}

/**
 * Chooses the pool the coin graduated into.
 *
 * 1. When Codex gives a migrated pool address (it does for coins from about
 *    March 2025), use it, even if the pairs list does not contain it.
 * 2. Otherwise (the address is null for most earlier coins) take the pool that
 *    is not the bonding curve and whose creation time is closest to the
 *    migration time. Ties go to the earlier pool. When the migration time is
 *    unknown, the earliest non-curve pool wins. Pools without a creation time
 *    are only used when nothing else exists.
 * 3. Returns null when no candidate exists.
 */
export function pickGraduationPool(args: {
  pools: readonly PoolInfo[];
  migratedPoolAddress: string | null | undefined;
  migratedAt: number | null | undefined;
  /** `PoolsResult.truncated` of the list passed in. */
  truncated?: boolean;
}): GraduationPick | null {
  const { pools, migratedPoolAddress, migratedAt } = args;
  const migrationTime = migratedAt ?? null;
  const deltaOf = (p: PoolInfo | null): number | null =>
    p && p.createdAt !== null && migrationTime !== null ? p.createdAt - migrationTime : null;

  if (migratedPoolAddress) {
    const pool = pools.find((p) => p.address === migratedPoolAddress) ?? null;
    return {
      address: migratedPoolAddress,
      source: 'migrated_pool_address',
      pool,
      deltaToMigrationSec: deltaOf(pool),
      truncated: false,
    };
  }

  const candidates = pools.filter((p) => !isBondingCurvePool(p));
  const dated = candidates.filter((p) => p.createdAt !== null);
  const pool = (dated.length > 0 ? dated : candidates).slice().sort((a, b) => {
    const da = a.createdAt === null ? Infinity : distance(a.createdAt, migrationTime);
    const db = b.createdAt === null ? Infinity : distance(b.createdAt, migrationTime);
    if (da !== db) return da - db;
    return (a.createdAt ?? Infinity) - (b.createdAt ?? Infinity);
  })[0];
  if (!pool) return null;
  return {
    address: pool.address,
    source: 'closest_to_migration',
    pool,
    deltaToMigrationSec: deltaOf(pool),
    truncated: args.truncated ?? false,
  };
}

/** With no migration time every pool is equally far, so the creation-time tie-break picks the earliest. */
function distance(createdAt: number, migrationTime: number | null): number {
  return migrationTime === null ? 0 : Math.abs(createdAt - migrationTime);
}
