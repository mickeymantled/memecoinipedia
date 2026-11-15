import type { GraduateRow } from '../../src/discovery/index.js';

export function row(
  mint: string,
  created: string,
  peak: number | null,
  extra: Partial<GraduateRow> = {},
): GraduateRow {
  return {
    mint,
    createdAtMs: Date.parse(created),
    creator: null,
    graduatedAtMs: null,
    graduationPool: null,
    graduationVenue: null,
    roughPeakUsd: peak,
    roughPeakAtMs: null,
    tradeCount: null,
    firstTradeAtMs: null,
    lastTradeAtMs: null,
    ...extra,
  };
}

/** A deterministic shuffle (a fixed linear congruential generator), so tests do not use random. */
export function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let s = seed >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}
