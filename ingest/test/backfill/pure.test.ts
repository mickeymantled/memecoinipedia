import { expect, it } from 'vitest';
import { estimateBackfillUnits, UNITS_PER_COIN_BY_CELL } from '../../src/backfill/cells.js';
import {
  BACKFILL_BATCH_SIZE,
  CODEX_DOCUMENTED_GROWTH_RPS,
  DEFAULT_CODEX_RPS,
  DEFAULT_DB_POOL,
  DEFAULT_QUEUE_POOL,
  MAX_CONNECTIONS,
} from '../../src/backfill/defaults.js';
import { formatBytes, formatDuration } from '../../src/backfill/status.js';
import { RateLimiter } from '../../src/sources/ratelimit.js';

it('the default pools fit under the connection cap, and the default rate under the documented limit', () => {
  expect(DEFAULT_DB_POOL + DEFAULT_QUEUE_POOL).toBeLessThanOrEqual(MAX_CONNECTIONS);
  expect(DEFAULT_CODEX_RPS).toBeLessThan(CODEX_DOCUMENTED_GROWTH_RPS);
  expect(BACKFILL_BATCH_SIZE.candles).toBeGreaterThan(1);
});

it('the estimate multiplies the coins still to fetch by the units of their cell', () => {
  const e = estimateBackfillUnits({
    counts: [0, 10, 0, 0, 0, 0],
    done: [0, 4, 0, 0, 0, 0],
    noPrice: 0,
    doneNoPrice: 0,
  } as never);
  expect(e.coinsToDo).toBe(6);
  expect(e.units).toBeCloseTo(6 * UNITS_PER_COIN_BY_CELL[1]!, 5);
  expect(e.rows[0]!.alreadyDone).toBe(4);
});

it('coins with no price are estimated at the lowest cell figure', () => {
  const e = estimateBackfillUnits({
    counts: [0, 0, 0, 0, 0, 0],
    done: [0, 0, 0, 0, 0, 0],
    noPrice: 3,
    doneNoPrice: 0,
  } as never);
  expect(e.units).toBeCloseTo(3 * UNITS_PER_COIN_BY_CELL[0]!, 5);
});

it('formats durations and sizes', () => {
  expect(formatDuration(0.5)).toBe('under a minute');
  expect(formatDuration(150)).toBe('2 h 30 min');
  expect(formatDuration(60 * 72)).toBe('3.0 days');
  expect(formatBytes(2_500_000_000)).toBe('2.50 GB');
  expect(formatBytes(5_000_000)).toBe('5 MB');
});

it('a rate-limit penalty slows the limiter, and the rate recovers after a quiet spell', async () => {
  let t = 0;
  const l = new RateLimiter({
    maxPerSecond: 100,
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  });
  l.penalize({ retryAfterMs: 10 });
  expect(l.penalties).toBe(1);
  expect(l.currentRate).toBeLessThan(100);
  t += 60_000;
  await l.acquire();
  expect(l.currentRate).toBeCloseTo(100, 0);
});
