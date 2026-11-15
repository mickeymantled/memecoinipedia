import type { GraduateRow } from '../../src/discovery/index.js';

/** A graduate with the given rough peak (`peak_p999_usd`). Graduation is an hour after creation. */
export function row(
  mint: string,
  created: string,
  peak: number | null,
  extra: Partial<GraduateRow> = {},
): GraduateRow {
  const createdAtMs = Date.parse(created);
  return {
    mint,
    createdAtMs,
    creator: null,
    graduatedAtMs: createdAtMs + 3_600_000,
    hours: null,
    peakMaxUsd: peak,
    peakP999Usd: peak,
    peakAtMs: null,
    lastHourMs: null,
    roughPeakUsd: peak,
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
