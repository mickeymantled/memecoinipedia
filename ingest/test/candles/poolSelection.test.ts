import { describe, expect, it } from 'vitest';
import { selectPools, type SelectPoolsArgs } from '../../src/candles/poolSelection.js';
import { OTHER_POOL_QUOTE, type PoolInfo } from '../../src/sources/codex/index.js';

const MIGRATED_AT = 1_731_701_291;

const pool = (address: string, over: Partial<PoolInfo> = {}): PoolInfo => ({
  address,
  pairId: `${address}:1399811149`,
  exchange: 'Raydium',
  protocol: 'Raydium',
  createdAt: MIGRATED_AT + 12,
  liquidityUsd: 10_000,
  quoteToken: 'SOL',
  quoteTokenAddress: OTHER_POOL_QUOTE.SOL,
  ...over,
});
const curve = (address = 'CURVE', over: Partial<PoolInfo> = {}): PoolInfo =>
  pool(address, {
    exchange: 'Pump.fun',
    protocol: 'Pump',
    createdAt: MIGRATED_AT - 3_600,
    liquidityUsd: 0,
    ...over,
  });

function select(pools: PoolInfo[], over: Partial<SelectPoolsArgs> = {}, truncated = false) {
  return selectPools({
    pools: { pools, truncated },
    migratedPoolAddress: null,
    migratedAt: MIGRATED_AT,
    migrated: true,
    minSecondaryPoolLiquidityUsd: 5_000,
    maxSecondaryPools: 8,
    ...over,
  });
}

describe('selectPools', () => {
  it('splits curve, graduation pool and others', () => {
    const r = select([
      curve(),
      pool('GRAD'),
      pool('DUST', { createdAt: MIGRATED_AT + 5_000_000, liquidityUsd: 12 }),
      pool('SIDE', { createdAt: MIGRATED_AT + 90, liquidityUsd: 50_000 }),
    ]);
    expect(r.curve?.address).toBe('CURVE');
    expect(r.graduation).toMatchObject({
      address: 'GRAD',
      source: 'closest_to_migration',
      unverified: false,
    });
    expect(r.others.map((p) => p.address)).toEqual(['SIDE']);
    expect(r.skippedOthers).toBe(1);
    expect(r.issues).toEqual([]);
  });

  it("takes Codex.io's migrated pool address even when the list does not hold it", () => {
    const r = select([curve(), pool('OTHER')], { migratedPoolAddress: 'NOTLISTED' });
    expect(r.graduation).toMatchObject({
      address: 'NOTLISTED',
      pool: null,
      source: 'migrated_pool_address',
    });
    expect(r.others.map((p) => p.address)).toEqual(['OTHER']);
  });

  it('never lists the curve or the graduation pool among the others', () => {
    const r = select([curve(), pool('GRAD')]);
    expect(r.others).toEqual([]);
    expect(r.skippedOthers).toBe(0);
  });

  it('keeps the most liquid other pools up to the cap, and counts the rest as skipped', () => {
    const others = Array.from({ length: 12 }, (_, i) =>
      pool(`P${String(i).padStart(2, '0')}`, {
        createdAt: MIGRATED_AT + 1_000 + i,
        liquidityUsd: 5_000 + i * 100,
      }),
    );
    const r = select([curve(), pool('GRAD', { createdAt: MIGRATED_AT }), ...others], {
      maxSecondaryPools: 3,
    });
    expect(r.others.map((p) => p.address)).toEqual(['P11', 'P10', 'P09']);
    expect(r.skippedOthers).toBe(9);
  });

  it('applies the liquidity minimum inclusively and drops unknown liquidity', () => {
    const r = select([
      curve(),
      pool('GRAD', { createdAt: MIGRATED_AT }),
      pool('EXACT', { createdAt: MIGRATED_AT + 1_000, liquidityUsd: 5_000 }),
      pool('JUSTUNDER', { createdAt: MIGRATED_AT + 1_000, liquidityUsd: 4_999.99 }),
      pool('UNKNOWN', { createdAt: MIGRATED_AT + 1_000, liquidityUsd: null }),
    ]);
    expect(r.others.map((p) => p.address)).toEqual(['EXACT']);
  });

  describe('quote tokens', () => {
    const WEIRD = {
      quoteToken: 'WEIRD',
      quoteTokenAddress: 'WeirdQuoteMint1111111111111111111111111111',
    };

    it('keeps the curve and the graduation pool whatever their quote token', () => {
      const r = select([curve('CURVE', WEIRD), pool('GRAD', { createdAt: MIGRATED_AT, ...WEIRD })]);
      expect(r.curve?.address).toBe('CURVE');
      expect(r.graduation?.address).toBe('GRAD');
      expect(r.otherQuotePools).toBe(0);
    });

    it('keeps another pool only when its other side is SOL, USDC or USDT, by mint address', () => {
      const r = select([
        curve(),
        pool('GRAD', { createdAt: MIGRATED_AT }),
        pool('SOLP', { createdAt: MIGRATED_AT + 1, quoteTokenAddress: OTHER_POOL_QUOTE.SOL }),
        pool('USDCP', { createdAt: MIGRATED_AT + 2, quoteTokenAddress: OTHER_POOL_QUOTE.USDC }),
        pool('USDTP', { createdAt: MIGRATED_AT + 3, quoteTokenAddress: OTHER_POOL_QUOTE.USDT }),
        pool('COINP', { createdAt: MIGRATED_AT + 4, ...WEIRD }),
        // A token that only calls itself SOL does not pass.
        pool('FAKESOL', {
          createdAt: MIGRATED_AT + 5,
          quoteToken: 'SOL',
          quoteTokenAddress: 'Fake',
        }),
        pool('NOADDR', { createdAt: MIGRATED_AT + 6, quoteTokenAddress: null }),
      ]);
      expect(r.others.map((p) => p.address).sort()).toEqual(['SOLP', 'USDCP', 'USDTP']);
      expect(r.otherQuotePools).toBe(3);
      expect(r.skippedOthers).toBe(0);
    });

    it('counts left-out quotes apart from pools left out for liquidity or the cap', () => {
      const r = select([
        curve(),
        pool('GRAD', { createdAt: MIGRATED_AT }),
        pool('DUST', { createdAt: MIGRATED_AT + 1, liquidityUsd: 3 }),
        pool('COINP', { createdAt: MIGRATED_AT + 2, liquidityUsd: 90_000, ...WEIRD }),
      ]);
      expect(r.others).toEqual([]);
      expect(r.skippedOthers).toBe(1);
      expect(r.otherQuotePools).toBe(1);
    });
  });

  describe('a pool list cut off at 250', () => {
    const dust = Array.from({ length: 249 }, (_, i) =>
      pool(`D${i}`, { createdAt: MIGRATED_AT + 10 * 86_400 + i, liquidityUsd: 1 }),
    );

    it('marks the pick unverified when it chose by creation time', () => {
      const r = select([...dust, pool('GRAD', { createdAt: MIGRATED_AT + 12 })], {}, true);
      expect(r.graduation).toMatchObject({ address: 'GRAD', unverified: true });
      expect(r.issues).toEqual([]);
    });

    it('records graduation_pool_not_found when no graduation pool is in the list', () => {
      // Only curve-like pools: nothing can be the graduation pool.
      const curves = Array.from({ length: 250 }, (_, i) =>
        curve(`C${i}`, { createdAt: MIGRATED_AT - i }),
      );
      const r = select(curves, {}, true);
      expect(r.graduation).toBeNull();
      expect(r.issues).toEqual([
        {
          kind: 'graduation_pool_not_found',
          detail: {
            poolsListed: 250,
            listTruncated: true,
            migrated: true,
            migratedAt: MIGRATED_AT,
            maxDelaySec: 3_600, // the distance the list was read under (issue 86)
          },
        },
      ]);
      // It carries on with what there is.
      expect(r.curve?.address).toBe('C249');
      expect(r.others).toEqual([]);
    });

    it('does not count a migrated pool address as unverified', () => {
      const r = select([...dust], { migratedPoolAddress: 'REAL' }, true);
      expect(r.graduation).toMatchObject({ address: 'REAL', unverified: false });
    });
  });

  it('records the issue for a graduated coin with no graduation pool even when the list is complete', () => {
    expect(select([curve()]).issues).toHaveLength(1);
    expect(select([curve()], { migrated: false }).issues).toEqual([]);
    expect(select([curve()], { migrated: null }).issues).toEqual([]);
  });

  it('has no curve for the largest 2024 coins, and still finds the graduation pool', () => {
    const r = select([pool('GRAD')]);
    expect(r.curve).toBeNull();
    expect(r.graduation?.address).toBe('GRAD');
  });
});

describe('selectPools for a coin with no sign of a graduation (issue #102)', () => {
  const never = { migratedAt: null, migrated: false as boolean | null };

  it('chooses no graduation pool: the curve is the curve, a stray pool is an ordinary other pool', () => {
    const r = select(
      [curve(), pool('STRAY', { createdAt: MIGRATED_AT + 90, liquidityUsd: 50_000 })],
      never,
    );
    expect(r.curve?.address).toBe('CURVE');
    expect(r.graduation).toBeNull();
    // The stray pool follows the quote and liquidity rules of any other pool.
    expect(r.others.map((p) => p.address)).toEqual(['STRAY']);
    expect(r.issues).toEqual([]);
  });

  it('applies the quote and liquidity rules to the stray pool', () => {
    const r = select(
      [
        curve(),
        pool('DUST', { liquidityUsd: 12 }),
        pool('OTHERQUOTE', { quoteTokenAddress: 'SomeOtherCoin', liquidityUsd: 90_000 }),
      ],
      never,
    );
    expect(r.graduation).toBeNull();
    expect(r.others).toEqual([]);
    expect(r.skippedOthers).toBe(1);
    expect(r.otherQuotePools).toBe(1);
  });

  it('records no graduation_pool_not_found when the list is cut off at 250', () => {
    const r = select([curve()], never, true);
    expect(r.graduation).toBeNull();
    expect(r.issues).toEqual([]);
  });

  it('a null migrated flag is the same as false', () => {
    const r = select([curve(), pool('STRAY')], { migratedAt: null, migrated: null });
    expect(r.graduation).toBeNull();
  });

  it('with any sign of a graduation the choice is exactly as before', () => {
    const pools = [curve(), pool('GRAD')];
    // The migration time alone.
    expect(select(pools, { migrated: null }).graduation?.address).toBe('GRAD');
    // `migrated` true alone, with no time: the earliest non-curve pool, as before.
    expect(select(pools, { migratedAt: null, migrated: true }).graduation?.address).toBe('GRAD');
    // A named pool alone.
    const named = select(pools, { migratedAt: null, migrated: null, migratedPoolAddress: 'GRAD' });
    expect(named.graduation).toMatchObject({ address: 'GRAD', source: 'migrated_pool_address' });
    // A graduate whose pool cannot be found still gets the issue.
    const none = select([curve()], { migratedAt: null, migrated: true });
    expect(none.issues.map((i) => i.kind)).toEqual(['graduation_pool_not_found']);
  });
});
