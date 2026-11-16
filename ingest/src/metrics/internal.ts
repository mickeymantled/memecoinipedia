import type { Bar } from './types.js';

export type Resolution = '1m' | '1h' | '1d';

export const SECONDS: Record<Resolution, number> = { '1m': 60, '1h': 3_600, '1d': 86_400 };

/** A pool whose bars have been cleaned (docs/metrics.md section 3) and sorted by `t`. */
export interface CleanPool {
  address: string;
  isPrimary: boolean;
  bars1m: Bar[];
  bars1h: Bar[];
  bars1d: Bar[];
}

/** A smoothed price observation (docs/metrics.md section 4). */
export interface Window {
  t: number;
  price: number;
  volume: number;
  traders: number;
  /** `max(o, h, l, c)` of an hourly or daily bar; equal to `price` for a 1-minute window. */
  high: number;
  strict: boolean;
  poolAddress: string;
  isPrimary: boolean;
  resolution: Resolution;
}

/** One point per timestamp (docs/metrics.md section 5). */
export interface CoinPoint {
  t: number;
  price: number;
  /** The `high` of the window the point came from. Only the coverage flag reads it. */
  high: number;
  strict: boolean;
  poolAddress: string;
  resolution: Resolution;
}

/** A point of the level series (docs/metrics.md section 7). */
export interface LevelPoint {
  t: number;
  level: number;
}

/**
 * Inclusive comparison with a tiny relative tolerance. docs/metrics.md says every
 * comparison against a parameter is inclusive, and prices are decimal fractions
 * stored in binary floats: (1 - 0.8) * 0.0001 is not 0.2 * 0.0001, so without the
 * tolerance an "exactly 80% drop" would miss the rule.
 */
export function atLeast(value: number, limit: number): boolean {
  if (value >= limit) return true;
  return Math.abs(value - limit) <= 1e-12 * Math.max(Math.abs(value), Math.abs(limit));
}

/** `value <= limit`, with the same tolerance as `atLeast`. */
export function atMost(value: number, limit: number): boolean {
  return atLeast(limit, value);
}

/** The highest of open, high, low and close. */
export function barPeak(bar: Bar): number {
  return Math.max(bar.o, bar.h, bar.l, bar.c);
}

export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
