import { describe, expect, it } from 'vitest';
import {
  isBondingCurvePool,
  pairIdFor,
  pickGraduationPool,
  type PoolInfo,
} from '../../../src/sources/codex/pools.js';

const pool = (address: string, over: Partial<PoolInfo> = {}): PoolInfo => ({
  address,
  pairId: pairIdFor(address),
  exchange: 'Raydium',
  protocol: 'RaydiumV4',
  createdAt: 1000,
  liquidityUsd: 100,
  quoteToken: 'SOL',
  ...over,
});

const curve = (address: string, createdAt = 900) =>
  pool(address, { exchange: 'Pump', protocol: 'Pump', createdAt });

describe('isBondingCurvePool', () => {
  it('recognises the pump.fun curve but not PumpSwap or other venues', () => {
    expect(isBondingCurvePool({ exchange: 'Pump', protocol: 'Pump' })).toBe(true);
    expect(isBondingCurvePool({ exchange: 'PumpSwap', protocol: 'PumpAmm' })).toBe(false);
    expect(isBondingCurvePool({ exchange: 'Raydium', protocol: 'RaydiumV4' })).toBe(false);
    expect(isBondingCurvePool({ exchange: null, protocol: null })).toBe(false);
  });
});

describe('pickGraduationPool', () => {
  it('uses the migrated pool address when Codex gives one', () => {
    const pools = [curve('C'), pool('A', { createdAt: 1000 }), pool('M', { createdAt: 5000 })];
    const pick = pickGraduationPool({ pools, migratedPoolAddress: 'M', migratedAt: 1000 });
    expect(pick).toMatchObject({ address: 'M', source: 'migrated_pool_address' });
    expect(pick?.pool?.address).toBe('M');
    expect(pick?.deltaToMigrationSec).toBe(4000);
  });

  it('trusts the migrated pool address even when the pairs list lacks it', () => {
    const pick = pickGraduationPool({
      pools: [pool('A')],
      migratedPoolAddress: 'Z',
      migratedAt: 1000,
    });
    expect(pick).toEqual({
      address: 'Z',
      source: 'migrated_pool_address',
      pool: null,
      deltaToMigrationSec: null,
    });
  });

  it('with a null address picks the non-curve pool created closest to the migration time', () => {
    const pools = [
      curve('C', 400),
      pool('LATE', { createdAt: 1_900 }),
      pool('NEAR', { createdAt: 1_012 }),
      pool('EARLY', { createdAt: 100 }),
    ];
    const pick = pickGraduationPool({ pools, migratedPoolAddress: null, migratedAt: 1_000 });
    expect(pick).toMatchObject({ address: 'NEAR', source: 'closest_to_migration' });
    expect(pick?.deltaToMigrationSec).toBe(12);
  });

  it('never picks the bonding curve, even when it is created at the migration time', () => {
    const pools = [curve('C', 1_000), pool('R', { createdAt: 1_500 })];
    expect(
      pickGraduationPool({ pools, migratedPoolAddress: null, migratedAt: 1_000 })?.address,
    ).toBe('R');
  });

  it('breaks distance ties toward the earlier pool', () => {
    const pools = [pool('AFTER', { createdAt: 1_050 }), pool('BEFORE', { createdAt: 950 })];
    expect(
      pickGraduationPool({ pools, migratedPoolAddress: undefined, migratedAt: 1_000 })?.address,
    ).toBe('BEFORE');
  });

  it('with no migration time takes the earliest non-curve pool', () => {
    const pools = [pool('B', { createdAt: 3_000 }), pool('A', { createdAt: 2_000 }), curve('C', 1)];
    expect(
      pickGraduationPool({ pools, migratedPoolAddress: null, migratedAt: null })?.address,
    ).toBe('A');
  });

  it('prefers dated pools, falls back to undated ones, and returns null when none qualify', () => {
    const undated = pool('U', { createdAt: null });
    const dated = pool('D', { createdAt: 9_999_999 });
    expect(
      pickGraduationPool({ pools: [undated, dated], migratedPoolAddress: null, migratedAt: 5 })
        ?.address,
    ).toBe('D');
    expect(
      pickGraduationPool({ pools: [undated], migratedPoolAddress: null, migratedAt: 5 })?.address,
    ).toBe('U');
    expect(
      pickGraduationPool({ pools: [curve('C')], migratedPoolAddress: null, migratedAt: 5 }),
    ).toBeNull();
    expect(pickGraduationPool({ pools: [], migratedPoolAddress: null, migratedAt: 5 })).toBeNull();
  });
});
