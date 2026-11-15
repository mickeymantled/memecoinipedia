/**
 * The graduation pool is the pool created at the migration (issue 81), checked against six real
 * answers from Codex.io (launch info and pool list, 2026-11-15, every pool kept) and small cases.
 * No test asks a provider anything.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { selectPools } from '../../src/candles/poolSelection.js';
import {
  OTHER_POOL_QUOTE,
  pickGraduationPool,
  type PoolInfo,
  type PoolsResult,
} from '../../src/sources/codex/index.js';

interface Answer {
  cls: string;
  id: number;
  mint: string;
  graduatedAt: number;
  launch: {
    migrated: boolean | null;
    migratedAt: number | null;
    migratedPoolAddress: string | null;
  };
  pools: PoolsResult;
}
const answers: Answer[] = JSON.parse(
  readFileSync(new URL('./fixtures/graduation-pool-answers.json', import.meta.url), 'utf8'),
) as Answer[];
const answer = (id: number): Answer => answers.find((a) => a.id === id)!;

/** The selection the fetcher makes: migration time is Codex.io's, else the stored graduation time. */
function selectFor(a: Answer, over: { maxGraduationPoolDelaySeconds?: number } = {}) {
  return selectPools({
    pools: a.pools,
    migratedPoolAddress: a.launch.migratedPoolAddress,
    migratedAt: a.launch.migratedAt ?? a.graduatedAt,
    migrated: a.launch.migrated,
    minSecondaryPoolLiquidityUsd: 5_000,
    maxSecondaryPools: 8,
    ...over,
  });
}
const byAddress = (a: Answer, address: string): PoolInfo =>
  a.pools.pools.find((p) => p.address === address)!;
/** What the selection did before this issue: the named pool always stands, and no distance. */
function selectBefore(a: Answer) {
  return selectPools({
    pools: a.pools,
    migratedPoolAddress: a.launch.migratedPoolAddress,
    migratedAt: a.launch.migratedAt,
    migrated: a.launch.migrated,
    minSecondaryPoolLiquidityUsd: 5_000,
    maxSecondaryPools: 8,
    maxGraduationPoolDelaySeconds: Number.POSITIVE_INFINITY,
  });
}

describe('the six answers from Codex.io', () => {
  it('has six answers with every pool kept', () => {
    expect(answers.map((a) => a.id)).toEqual([324443, 144073, 171437, 4339, 142812, 248937]);
    expect(answers.map((a) => a.pools.pools.length)).toEqual([10, 57, 2, 5, 8, 2]);
    expect(answers.every((a) => !a.pools.truncated)).toBe(true);
  });

  it.each([324443, 144073, 142812])(
    'coin %i: the named pool is weeks late, the pool created at migratedAt is the graduation pool',
    (id) => {
      const a = answer(id);
      const named = byAddress(a, a.launch.migratedPoolAddress!);
      expect(named.createdAt! - a.launch.migratedAt!).toBeGreaterThan(20 * 86_400);

      const before = selectBefore(a);
      expect(before.graduation).toMatchObject({
        address: named.address,
        source: 'migrated_pool_address',
      });

      const r = selectFor(a);
      expect(r.graduation).toMatchObject({ source: 'created_at_migration', unverified: false });
      const real = r.graduation!.pool!;
      expect(real.address).not.toBe(named.address);
      expect(real.exchange).toBe('Raydium');
      expect(real.quoteTokenAddress).toBe(OTHER_POOL_QUOTE.SOL);
      expect(real.createdAt! - a.launch.migratedAt!).toBeLessThanOrEqual(60);
      // The named pool is an ordinary other pool now: it is not the graduation pool, and it is
      // kept or left out by the other-pool rules (quoted in USDT or another coin: left out).
      expect(r.others.map((p) => p.address)).not.toContain(real.address);
      expect(r.issues).toEqual([]);
    },
  );

  it('coin 142812: the real pool is under $5,000 today and is still in the fetch list as the graduation pool', () => {
    const a = answer(142812);
    const r = selectFor(a);
    expect(r.graduation!.pool!.liquidityUsd!).toBeLessThan(5_000);
    expect(r.graduation!.pool!.exchange).toBe('Raydium');
    // Before: the real pool fell under the other-pool rule and was dropped.
    const before = selectBefore(a);
    expect(before.others.map((p) => p.address)).not.toContain(r.graduation!.address);
  });

  it('coin 324443: the real pool was kept as an other pool before, and now carries the role', () => {
    const a = answer(324443);
    const before = selectBefore(a);
    const r = selectFor(a);
    expect(before.others.map((p) => p.address)).toContain(r.graduation!.address);
    expect(r.others.map((p) => p.address)).not.toContain(r.graduation!.address);
  });

  it('coin 171437 (2024-05-16): Codex.io names a pool created at its own migratedAt: as today, no issue', () => {
    const a = answer(171437);
    expect(selectFor(a).graduation).toEqual(selectBefore(a).graduation);
    expect(selectFor(a).graduation!.source).toBe('migrated_pool_address');
    expect(selectFor(a).issues).toEqual([]);
    // From the stored graduation time (2024-05-16) alone the named pool is two years away.
    const stored = selectPools({
      pools: a.pools,
      migratedPoolAddress: a.launch.migratedPoolAddress,
      migratedAt: a.graduatedAt,
      migrated: true,
      minSecondaryPoolLiquidityUsd: 5_000,
      maxSecondaryPools: 8,
    });
    expect(stored.graduation!.address).toBe(a.launch.migratedPoolAddress);
    expect(stored.issues.map((i) => i.kind)).toEqual(['graduation_pool_late']);
  });

  it.each([4339, 248937])(
    'coin %i (no named pool): the choice is as today, with graduation_pool_late',
    (id) => {
      const a = answer(id);
      const r = selectFor(a);
      expect(r.graduation).toEqual(
        // Before, the migration time was unknown (null) and the earliest dated pool won; with the
        // stored graduation time the closest does. The two agree on these answers.
        selectPools({
          pools: a.pools,
          migratedPoolAddress: null,
          migratedAt: a.graduatedAt,
          migrated: null,
          minSecondaryPoolLiquidityUsd: 5_000,
          maxSecondaryPools: 8,
          maxGraduationPoolDelaySeconds: Number.POSITIVE_INFINITY,
        }).graduation,
      );
      expect(r.graduation!.source).toBe('closest_to_migration');
      const gap = Math.abs(r.graduation!.pool!.createdAt! - a.graduatedAt);
      expect(gap).toBeGreaterThan(3_600);
      expect(r.issues).toEqual([
        {
          kind: 'graduation_pool_late',
          detail: {
            distanceSec: gap,
            maxDelaySec: 3_600,
            venue: r.graduation!.pool!.exchange,
            source: 'closest_to_migration',
          },
        },
      ]);
    },
  );

  it('the distance is a parameter: a wide one keeps the named pool and records nothing', () => {
    const a = answer(324443);
    const r = selectFor(a, { maxGraduationPoolDelaySeconds: 365 * 86_400 });
    expect(r.graduation).toMatchObject({
      address: a.launch.migratedPoolAddress,
      source: 'migrated_pool_address',
    });
    expect(r.issues).toEqual([]);
  });
});

describe('pickGraduationPool with a distance', () => {
  const M = 1_740_000_000;
  const p = (
    address: string,
    createdAt: number | null,
    over: Partial<PoolInfo> = {},
  ): PoolInfo => ({
    address,
    pairId: `${address}:1`,
    exchange: 'Raydium',
    protocol: 'RaydiumV4',
    createdAt,
    liquidityUsd: 10_000,
    quoteToken: 'SOL',
    quoteTokenAddress: OTHER_POOL_QUOTE.SOL,
    ...over,
  });
  const curve = p('CURVE', M - 600, { exchange: 'Pump.fun', protocol: 'Pump' });
  const pick = (
    pools: PoolInfo[],
    named: string | null,
    over: { migratedAt?: number | null; truncated?: boolean } = {},
  ) =>
    pickGraduationPool({
      pools,
      migratedPoolAddress: named,
      migratedAt: over.migratedAt === undefined ? M : over.migratedAt,
      truncated: over.truncated ?? false,
      maxGraduationPoolDelaySeconds: 3_600,
    });

  it('a named pool within the distance stands, even if another one is closer', () => {
    const r = pick([curve, p('NAMED', M + 3_600), p('CLOSER', M + 5)], 'NAMED');
    expect(r).toMatchObject({ address: 'NAMED', source: 'migrated_pool_address' });
    expect(r!.late).toBeUndefined();
  });

  it('a named pool with no creation time, or not in the list, is never called late', () => {
    const undated = pick([curve, p('NAMED', null), p('NEAR', M)], 'NAMED');
    expect(undated).toMatchObject({ address: 'NAMED' });
    expect(undated!.late).toBeUndefined();
    const gone = pick([curve, p('NEAR', M)], 'GONE');
    expect(gone).toMatchObject({ address: 'GONE' });
    expect(gone!.late).toBeUndefined();
  });

  it('a pool with no creation time is never late on the fallback either', () => {
    const r = pick([p('UNDATED', null)], null);
    expect(r).toMatchObject({ address: 'UNDATED' });
    expect(r!.late).toBeUndefined();
  });

  it('a far named pool gives way to the closest pool within the distance (ties to the earlier), never the curve', () => {
    const r = pick(
      [curve, p('NAMED', M + 90 * 86_400), p('B', M + 30), p('A', M - 30), p('FAR', M + 7_200)],
      'NAMED',
    );
    expect(r).toMatchObject({ address: 'A', source: 'created_at_migration' });
    expect(r!.late).toBeUndefined();
    // The curve is not a candidate even when it is the closest.
    const onlyCurve = pick([{ ...curve, createdAt: M }, p('NAMED', M + 90 * 86_400)], 'NAMED');
    expect(onlyCurve).toMatchObject({ address: 'NAMED', source: 'migrated_pool_address' });
    expect(onlyCurve!.late).toMatchObject({ distanceSec: 90 * 86_400, venue: 'Raydium' });
  });

  it('no pool within the distance: the named pool stands, late with the distance, venue and source', () => {
    const r = pick([curve, p('NAMED', M + 5 * 3_600), p('OTHER', M + 9 * 3_600)], 'NAMED');
    expect(r).toMatchObject({ address: 'NAMED', source: 'migrated_pool_address' });
    expect(r!.late).toEqual({
      distanceSec: 5 * 3_600,
      maxDelaySec: 3_600,
      venue: 'Raydium',
      source: 'migrated_pool_address',
    });
  });

  it('without a migration time nothing is late', () => {
    const r = pick([curve, p('NAMED', M + 90 * 86_400), p('X', M)], 'NAMED', { migratedAt: null });
    expect(r).toMatchObject({ address: 'NAMED' });
    expect(r!.late).toBeUndefined();
  });
});

describe('data issues of the selection', () => {
  const M = 1_740_000_000;
  const pools = (list: Partial<PoolInfo>[]): PoolsResult => ({
    truncated: false,
    pools: list.map((x, i) => ({
      address: `P${i}`,
      pairId: `P${i}:1`,
      exchange: 'Raydium',
      protocol: 'RaydiumV4',
      createdAt: M,
      liquidityUsd: 1_000,
      quoteToken: 'SOL',
      quoteTokenAddress: OTHER_POOL_QUOTE.SOL,
      ...x,
    })),
  });
  const select = (
    list: PoolsResult,
    over: { migrated: boolean | null; migratedAt: number | null },
  ) =>
    selectPools({
      pools: list,
      migratedPoolAddress: null,
      minSecondaryPoolLiquidityUsd: 5_000,
      maxSecondaryPools: 8,
      ...over,
    });

  it('a graduated coin with no graduation pool records graduation_pool_not_found, list cut off or not', () => {
    const onlyCurve = pools([{ exchange: 'Pump.fun', protocol: 'Pump' }]);
    for (const over of [
      { migrated: true, migratedAt: M },
      { migrated: true, migratedAt: null },
    ]) {
      const r = select(onlyCurve, over);
      expect(r.graduation).toBeNull();
      expect(r.issues.map((i) => i.kind)).toEqual(['graduation_pool_not_found']);
    }
    // A coin not known to have graduated, with the list not cut off: nothing to record.
    expect(select(onlyCurve, { migrated: null, migratedAt: null }).issues).toEqual([]);
    expect(select(onlyCurve, { migrated: false, migratedAt: null }).issues).toEqual([]);
  });
});
