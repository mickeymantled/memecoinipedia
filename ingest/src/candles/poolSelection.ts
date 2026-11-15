import {
  isBondingCurvePool,
  OTHER_POOL_QUOTE_MINTS,
  pickGraduationPool,
  type GraduationPoolSource,
  type PoolInfo,
  type PoolsResult,
} from '../sources/codex/index.js';

export interface PoolSelection {
  /** The pump.fun bonding-curve pool, or null (the four largest 2024 coins have none listed). */
  curve: PoolInfo | null;
  graduation: {
    address: string;
    /** The listing entry, or null when Codex.io named a pool it did not list. */
    pool: PoolInfo | null;
    source: GraduationPoolSource;
    /** Chosen by creation time from a list cut off at 250: the real pool may be missing. */
    unverified: boolean;
  } | null;
  /** Other pools worth fetching, most liquid first. */
  others: PoolInfo[];
  /** Other pools left out: listed liquidity under the minimum, unknown, or over the cap. */
  skippedOthers: number;
  /**
   * Other pools left out because their quote token is not SOL, USDC or USDT (by mint address).
   * Counted apart from `skippedOthers`; the curve and the graduation pool are never counted here.
   */
  otherQuotePools: number;
  /** Data issues the caller should record. */
  issues: {
    kind: 'graduation_pool_not_found' | 'graduation_pool_late';
    detail: Record<string, unknown>;
  }[];
}

const DEFAULT_GRADUATION_DELAY_SEC = 3_600;

export interface SelectPoolsArgs {
  pools: PoolsResult;
  migratedPoolAddress: string | null;
  /** The migration time: Codex.io's `migratedAt`, else the coin's stored graduation time. */
  migratedAt: number | null;
  /** Codex.io's `launchpad.migrated`. */
  migrated: boolean | null;
  /** Other pools need at least this much listed liquidity, USD. */
  minSecondaryPoolLiquidityUsd: number;
  /** At most this many other pools. */
  maxSecondaryPools: number;
  /** `maxGraduationPoolDelaySeconds` of the plan limits. Default 3,600. */
  maxGraduationPoolDelaySeconds?: number;
}

/**
 * Splits the pool list into the bonding curve, the graduation pool and the
 * other pools worth fetching.
 *
 * Graduation pool: the pool created at the migration (`pickGraduationPool`). Codex.io's migrated
 * pool address when that pool was created within `maxGraduationPoolDelaySeconds` of the migration;
 * else the non-curve pool created within that distance and closest to the migration time; else (no
 * pool within the distance) the named pool or the closest one as before, with a
 * `graduation_pool_late` issue. A named pool passed over is an ordinary other pool below.
 *
 * The curve and the graduation pool are kept whatever their quote token: since September 2026
 * pump.fun coins launch against many quote tokens.
 *
 * Other pools: only those quoted in SOL, USDC or USDT (`OTHER_POOL_QUOTE_MINTS`). A pool between
 * two tracked coins prices each in the other, which is no market for our purpose. A coin can have up to 250 listed pools, mostly dust, and each one
 * costs a request for daily bars. Only pools whose listed liquidity is at least
 * the secondary minimum are kept, the most liquid first, up to the cap. A pool
 * that held liquidity once and is drained now is left out; that is the price of
 * bounding the cost.
 *
 * When the coin is known to have graduated (`migrated` true; the caller passes true for a coin
 * whose graduation time is stored) or the list was cut off at 250, and no graduation pool is
 * found, an issue of kind `graduation_pool_not_found` is returned, cut off or not, and the rest of
 * the selection carries on with what there is.
 */
export function selectPools(args: SelectPoolsArgs): PoolSelection {
  const { pools: result } = args;
  const curve =
    result.pools
      .filter((p) => isBondingCurvePool(p))
      .sort((a, b) => (a.createdAt ?? Infinity) - (b.createdAt ?? Infinity))[0] ?? null;

  const pick = pickGraduationPool({
    pools: result.pools.filter((p) => p.address !== curve?.address),
    migratedPoolAddress: args.migratedPoolAddress,
    migratedAt: args.migratedAt,
    truncated: result.truncated,
    maxGraduationPoolDelaySeconds:
      args.maxGraduationPoolDelaySeconds ?? DEFAULT_GRADUATION_DELAY_SEC,
  });
  const graduation = pick
    ? {
        address: pick.address,
        pool: pick.pool,
        source: pick.source,
        unverified: pick.truncated,
      }
    : null;

  const candidates = result.pools.filter(
    (p) => p.address !== curve?.address && p.address !== graduation?.address,
  );
  const quoted = candidates.filter(
    (p) => p.quoteTokenAddress !== null && OTHER_POOL_QUOTE_MINTS.includes(p.quoteTokenAddress),
  );
  const liquid = quoted
    .filter((p) => p.liquidityUsd !== null && p.liquidityUsd >= args.minSecondaryPoolLiquidityUsd)
    .sort(
      (a, b) =>
        (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0) ||
        (a.address < b.address ? -1 : a.address > b.address ? 1 : 0),
    );
  const others = liquid.slice(0, args.maxSecondaryPools);

  const issues: PoolSelection['issues'] = [];
  if (pick?.late) {
    issues.push({
      kind: 'graduation_pool_late',
      detail: {
        distanceSec: pick.late.distanceSec,
        maxDelaySec: pick.late.maxDelaySec,
        venue: pick.late.venue,
        source: pick.late.source,
      },
    });
  }
  if (!graduation && (result.truncated || args.migrated === true)) {
    issues.push({
      kind: 'graduation_pool_not_found',
      detail: {
        poolsListed: result.pools.length,
        listTruncated: result.truncated,
        migrated: args.migrated,
        migratedAt: args.migratedAt,
      },
    });
  }
  return {
    curve,
    graduation,
    others,
    skippedOthers: quoted.length - others.length,
    otherQuotePools: candidates.length - quoted.length,
    issues,
  };
}
