/**
 * What a backfill costs, by rough-peak cell. Kept apart from `worker/plan.ts` (the sample run's
 * table), which has its own figures per sampling cell.
 *
 * Compute units per coin for the candles stage, measured on the 500-coin run (A5c) for the cells
 * from $30,000 up. Below $30,000 the figure is an assumption (11) until issue #40 reports.
 */
import type { RoughPeakCounts } from '@memecoinipedia/db';

/** Upper edges of the cells in USD: under 30k, 30k-50k, 50k-100k, 100k-1M, 1M-10M, 10M and more. */
export const CELL_EDGES: readonly number[] = [30_000, 50_000, 100_000, 1_000_000, 10_000_000];

export const CELL_LABELS: readonly string[] = [
  'under $30k',
  '$30k-$50k',
  '$50k-$100k',
  '$100k-$1M',
  '$1M-$10M',
  '$10M and more',
];

/** Units per coin for each cell, in the order of `CELL_LABELS`. */
export const UNITS_PER_COIN_BY_CELL: readonly number[] = [11, 14.7, 17.9, 20.9, 27.9, 33.3];

/** A coin with no rough peak: counted at the figure for the lowest cell. */
export const UNITS_PER_COIN_NO_PRICE = 11;

export interface CellEstimateRow {
  label: string;
  coins: number;
  /** Coins whose candles are already done (they cost nothing more). */
  alreadyDone: number;
  /** Coins still to fetch. */
  toDo: number;
  unitsPerCoin: number;
  units: number;
}

export interface BackfillEstimate {
  rows: CellEstimateRow[];
  coinsToDo: number;
  units: number;
}

/** The units a backfill of the counted coins would spend: the coins still to do, by cell. */
export function estimateBackfillUnits(counts: RoughPeakCounts): BackfillEstimate {
  const rows: CellEstimateRow[] = [];
  const add = (label: string, coins: number, done: number, per: number) => {
    if (coins === 0) return;
    const toDo = Math.max(0, coins - done);
    rows.push({ label, coins, alreadyDone: done, toDo, unitsPerCoin: per, units: toDo * per });
  };
  counts.counts.forEach((n, i) =>
    add(CELL_LABELS[i]!, n, counts.done[i] ?? 0, UNITS_PER_COIN_BY_CELL[i]!),
  );
  add('no price', counts.noPrice, counts.doneNoPrice, UNITS_PER_COIN_NO_PRICE);
  return {
    rows,
    coinsToDo: rows.reduce((s, r) => s + r.toDo, 0),
    units: rows.reduce((s, r) => s + r.units, 0),
  };
}
