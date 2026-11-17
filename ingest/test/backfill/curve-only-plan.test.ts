/**
 * The backfill dry run for the curve-only list (issue #102): the selection leaves it out unless
 * asked for, says so in one line, and the curve-only selection has its own estimate.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  CURVE_ONLY_DISCOVERY_SOURCE,
  seedBackfillChunk,
  type BackfillSeedRow,
  type SelectionSpec,
} from '@memecoinipedia/db';
import { createTestDatabase, type TestDatabase } from '@memecoinipedia/db/testing';
import {
  CURVE_ONLY_REST_UNITS,
  CURVE_ONLY_SCREEN_UNITS,
  estimateCurveOnlyUnits,
} from '../../src/backfill/cells.js';
import { formatBackfillPlan, planBackfill } from '../../src/backfill/run.js';
import { formatStatus, collectStatus } from '../../src/backfill/status.js';
import { adminUrl, describeDb } from './helpers.js';

const NOW = new Date('2026-11-16T10:00:00Z');
const addr = (i: number): string => `E${String(i).padStart(43, '0')}`;
const row = (i: number, rough: number, graduated: boolean): BackfillSeedRow => ({
  address: addr(i),
  launchpad: 'pump.fun',
  launchedAt: new Date('2025-12-01T00:00:00Z'),
  creatorWallet: null,
  graduatedAt: graduated ? new Date('2025-12-01T01:00:00Z') : null,
  roughAthMarketCapUsd: rough,
});
const SPEC: SelectionSpec = {
  chain: 'solana',
  minRoughPeakUsd: 30_000,
  includeNoPrice: false,
  order: 'peak',
};

it('the curve-only estimate is 12 units a coin, and 20 if every screen passes', () => {
  const e = estimateCurveOnlyUnits({
    counts: [0, 0, 0, 100, 0, 0],
    done: [0, 0, 0, 40, 0, 0],
    noPrice: 0,
    doneNoPrice: 0,
  } as never);
  expect(e.coinsToDo).toBe(60);
  expect(e.units).toBe(60 * (CURVE_ONLY_SCREEN_UNITS + CURVE_ONLY_REST_UNITS));
  expect(e.curveOnly?.floorUnits).toBe(60 * 12);
  expect(CURVE_ONLY_SCREEN_UNITS).toBe(12);
});

describeDb('the dry run with and without the curve-only source', () => {
  let t: TestDatabase;
  const GRADS = 25;
  const CURVES = 40;
  beforeAll(async () => {
    t = await createTestDatabase(adminUrl!);
    await seedBackfillChunk(
      t.db,
      Array.from({ length: GRADS }, (_, i) => row(i + 1, 60_000 + i * 1_000, true)),
      { chain: 'solana', discoverySource: 'dune-graduates', now: NOW },
    );
    await seedBackfillChunk(
      t.db,
      Array.from({ length: CURVES }, (_, i) => row(500 + i, 150_000 + i * 1_000, false)),
      { chain: 'solana', discoverySource: CURVE_ONLY_DISCOVERY_SOURCE, now: NOW },
    );
  });
  afterAll(async () => {
    await t.drop();
  });

  const fmt = (plan: Awaited<ReturnType<typeof planBackfill>>) =>
    formatBackfillPlan(plan, {
      stages: ['candles', 'metrics', 'metadata'],
      codexRps: 100,
      candlesConcurrency: 200,
      confirm: false,
      maxCodexUnits: null,
    });

  it('without the option: graduates only, the left-out line, the graduates estimate', async () => {
    const plan = await planBackfill(t.db, SPEC, ['candles'], 3, NOW);
    expect(plan.selection.size).toBe(GRADS);
    expect(plan.leftOutBySource).toBe(CURVES);
    const text = fmt(plan);
    expect(text).toContain(
      `${CURVES} coins of the curve-only list were left out (never graduated); --source ${CURVE_ONLY_DISCOVERY_SOURCE} selects them.`,
    );
    expect(text).toContain('by rough-peak cell');
    expect(text).not.toContain('curve-only list:');
  });

  it('with the option: the curve-only coins, their own estimate with its reason, no left-out line', async () => {
    const plan = await planBackfill(
      t.db,
      { ...SPEC, source: CURVE_ONLY_DISCOVERY_SOURCE },
      ['candles'],
      3,
      NOW,
    );
    expect(plan.selection.size).toBe(CURVES);
    expect(plan.leftOutBySource).toBe(0);
    expect(plan.estimate.units).toBe(CURVES * 20);
    const text = fmt(plan);
    expect(text).toContain('source dune-curve-only');
    expect(text).toContain('curve-only list: 40 coins still to fetch');
    expect(text).toContain('launch record 4, pool list 4, daily screen on its curve 4');
    expect(text).toContain('about 800 compute units if every coin passes');
    expect(text).not.toContain('left out');
    expect(text).not.toContain('by rough-peak cell');
  });

  it('with the option and a limit in hash order: the estimate follows the limit', async () => {
    const plan = await planBackfill(
      t.db,
      { ...SPEC, source: CURVE_ONLY_DISCOVERY_SOURCE, order: 'hash', limit: 10 },
      ['candles'],
      3,
      NOW,
    );
    expect(plan.selection.size).toBe(10);
    expect(plan.estimate.coinsToDo).toBe(10);
    expect(plan.estimate.units).toBe(200);
  });

  it('the status view takes the option', async () => {
    const plain = await collectStatus(t.db, { selection: SPEC, now: () => NOW });
    expect(plain.selection.size).toBe(GRADS);
    const curve = await collectStatus(t.db, {
      selection: { ...SPEC, source: CURVE_ONLY_DISCOVERY_SOURCE },
      now: () => NOW,
    });
    expect(curve.selection.size).toBe(CURVES);
    expect(formatStatus(curve)).toContain('source dune-curve-only');
    expect(formatStatus(plain)).not.toContain('source dune-curve-only');
  });
});
