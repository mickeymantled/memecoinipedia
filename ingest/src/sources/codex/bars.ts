import type { Bar } from '../../metrics/types.js';
import type { BarResolution } from './queries.js';
import type { BarsColumns } from './schemas.js';

/** Codex answers at most this many buckets per getBars request. */
export const MAX_BUCKETS_PER_REQUEST = 1_500;

export const RESOLUTION_SECONDS: Record<BarResolution, number> = {
  '1': 60,
  '60': 3_600,
  '1D': 86_400,
};

export interface BarRequestWindow {
  /** First bucket start, unix seconds, aligned to the resolution. Inclusive. */
  from: number;
  /** Last second covered, unix seconds. `to - from + 1` is a whole number of buckets. Inclusive. */
  to: number;
  /** Number of buckets in the window, at most 1,500. */
  buckets: number;
}

/**
 * Splits `[from, to)` into getBars windows of at most 1,500 buckets.
 *
 * Codex applies the 1,500 cap to the requested range even when empty bars are
 * removed, so a long range has to be split up front. The range is widened to
 * bucket boundaries: the first window starts at `floor(from / res) * res` and
 * the last ends at the last bucket that touches `to`. Windows are contiguous
 * (each starts one second after the previous ends), so no bucket is requested
 * twice or skipped. Pure; a dry run uses it to count requests.
 */
export function planBarRequests(args: {
  from: number;
  to: number;
  resolution: BarResolution;
}): BarRequestWindow[] {
  const step = RESOLUTION_SECONDS[args.resolution];
  if (!Number.isFinite(args.from) || !Number.isFinite(args.to)) {
    throw new TypeError('from and to must be finite unix seconds');
  }
  if (args.to <= args.from) return [];
  const firstBucket = Math.floor(args.from / step);
  // Exclusive upper bound: the bucket that contains `to - 1`, plus one.
  const endBucket = Math.floor((args.to - 1) / step) + 1;
  const windows: BarRequestWindow[] = [];
  for (let b = firstBucket; b < endBucket; b += MAX_BUCKETS_PER_REQUEST) {
    const buckets = Math.min(MAX_BUCKETS_PER_REQUEST, endBucket - b);
    windows.push({ from: b * step, to: (b + buckets) * step - 1, buckets });
  }
  return windows;
}

/**
 * Converts Codex's column-oriented bars into `Bar[]`.
 *
 * Mapping: `volume` to `volumeUsd`, `transactions` to `trades`, `traders` to
 * `traders`, `liquidity` to `liquidityUsd` (null stays null). Buckets with no
 * trades are dropped. Rows missing any of t, o, h, l, c are dropped.
 */
export function barsFromColumns(cols: BarsColumns | null | undefined): Bar[] {
  if (!cols) return [];
  const out: Bar[] = [];
  for (let i = 0; i < cols.t.length; i++) {
    const t = cols.t[i];
    const o = cols.o[i];
    const h = cols.h[i];
    const l = cols.l[i];
    const c = cols.c[i];
    if (t == null || o == null || h == null || l == null || c == null) continue;
    const trades = cols.transactions?.[i] ?? 0;
    const volumeUsd = cols.volume?.[i] ?? 0;
    // "Only buckets with at least one trade have a bar."
    if (trades <= 0 && volumeUsd <= 0) continue;
    out.push({
      t,
      o,
      h,
      l,
      c,
      volumeUsd,
      trades,
      traders: cols.traders?.[i] ?? 0,
      liquidityUsd: cols.liquidity?.[i] ?? null,
    });
  }
  return out;
}

/** Sorts by `t` and keeps the first bar seen for each `t`. Does not mutate the input. */
export function sortAndDedupeBars(bars: readonly Bar[]): Bar[] {
  const seen = new Set<number>();
  const sorted = [...bars].sort((a, b) => a.t - b.t);
  const out: Bar[] = [];
  for (const bar of sorted) {
    if (seen.has(bar.t)) continue;
    seen.add(bar.t);
    out.push(bar);
  }
  return out;
}
