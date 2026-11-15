/**
 * `sizeTargetSet`: one row per launch month, from the graduates list.
 *
 * The launch month is the UTC month of `created_at`. Months with no coins between the first and
 * the last are included with zeros. A coin counts as having reached a threshold when its rough
 * peak is at or above it (`>=`). A coin with no rough peak counts as graduated and is below
 * every threshold.
 *
 * For coins at $100k or more, the statistics are taken over trades per coin and over the days
 * between the first and the last trade (fractional days). Percentiles use the nearest-rank
 * method on the exact data (no interpolation): for n values sorted ascending, the p-th
 * percentile is the value at rank ceil(p/100 * n). The median is the 50th percentile, so for an
 * even n it is the lower of the two middle values. A coin with no trade count is left out of the
 * trades statistics; a coin with a missing time, or a last trade before its first, is left out
 * of the days statistics. `coinsInStats` says how many coins went into each.
 */
import type { GraduateRow } from './csv.js';

export const PEAK_THRESHOLDS_USD = [
  50_000, 80_000, 100_000, 125_000, 1_000_000, 10_000_000, 100_000_000,
] as const;

/** The threshold that selects the coins whose trade statistics are reported. */
export const STATS_THRESHOLD_USD = 100_000;

const DAY_MS = 86_400_000;

export interface Distribution {
  /** Number of values in the statistic. */
  n: number;
  median: number;
  p90: number;
  p99: number;
  max: number;
}

export interface MonthSize {
  /** `YYYY-MM`, UTC. */
  month: string;
  graduated: number;
  /** Coins whose rough peak is at or above each threshold, keyed by the threshold in USD. */
  reached: Record<string, number>;
  /** Over coins at $100k or more; null when no coin qualifies with data. */
  tradesPerCoin: Distribution | null;
  daysBetweenFirstAndLastTrade: Distribution | null;
}

/** Nearest-rank percentile of an ascending array. `p` in (0, 100]. */
export function nearestRank(sortedAscending: readonly number[], p: number): number {
  const n = sortedAscending.length;
  if (n === 0) throw new RangeError('no values');
  const rank = Math.max(1, Math.ceil((p / 100) * n - 1e-9));
  return sortedAscending[Math.min(n, rank) - 1] as number;
}

function distribution(values: number[]): Distribution | null {
  if (values.length === 0) return null;
  const v = [...values].sort((a, b) => a - b);
  return {
    n: v.length,
    median: nearestRank(v, 50),
    p90: nearestRank(v, 90),
    p99: nearestRank(v, 99),
    max: v[v.length - 1] as number,
  };
}

export function monthOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function nextMonth(month: string): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

export function sizeTargetSet(rows: readonly GraduateRow[]): MonthSize[] {
  if (rows.length === 0) return [];
  const byMonth = new Map<string, GraduateRow[]>();
  for (const r of rows) {
    const m = monthOf(r.createdAtMs);
    const list = byMonth.get(m);
    if (list) list.push(r);
    else byMonth.set(m, [r]);
  }
  const months = [...byMonth.keys()].sort();
  const first = months[0] as string;
  const last = months[months.length - 1] as string;

  const out: MonthSize[] = [];
  for (let m = first; m <= last; m = nextMonth(m)) {
    const coins = byMonth.get(m) ?? [];
    const reached: Record<string, number> = {};
    for (const t of PEAK_THRESHOLDS_USD) {
      reached[String(t)] = coins.filter(
        (c) => c.roughPeakUsd !== null && c.roughPeakUsd >= t,
      ).length;
    }
    const big = coins.filter(
      (c) => c.roughPeakUsd !== null && c.roughPeakUsd >= STATS_THRESHOLD_USD,
    );
    const trades = big.flatMap((c) => (c.tradeCount === null ? [] : [c.tradeCount]));
    const days = big.flatMap((c) =>
      c.firstTradeAtMs !== null && c.lastTradeAtMs !== null && c.lastTradeAtMs >= c.firstTradeAtMs
        ? [(c.lastTradeAtMs - c.firstTradeAtMs) / DAY_MS]
        : [],
    );
    out.push({
      month: m,
      graduated: coins.length,
      reached,
      tradesPerCoin: distribution(trades),
      daysBetweenFirstAndLastTrade: distribution(days),
    });
  }
  return out;
}

/** A plain-text table for the console. */
export function formatSizingTable(sizes: readonly MonthSize[]): string {
  const label = (t: number) => (t >= 1_000_000 ? `>=${t / 1_000_000}M` : `>=${t / 1000}k`);
  const cols = ['month', 'grad', ...PEAK_THRESHOLDS_USD.map(label)];
  const lines = [cols.join('\t') + '\ttrades med/p90/p99/max\tdays med/p90/p99/max'];
  const fmt = (d: Distribution | null) =>
    d === null ? '-' : [d.median, d.p90, d.p99, d.max].map((x) => Number(x.toFixed(1))).join('/');
  for (const s of sizes) {
    lines.push(
      [
        s.month,
        s.graduated,
        ...PEAK_THRESHOLDS_USD.map((t) => s.reached[String(t)]),
        fmt(s.tradesPerCoin),
        fmt(s.daysBetweenFirstAndLastTrade),
      ].join('\t'),
    );
  }
  return lines.join('\n');
}
