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
  /** Set for the curve-only list (`estimateCurveOnlyUnits`); `units` is the upper figure. */
  curveOnly?: { screenUnitsPerCoin: number; restUnitsPerCoin: number; floorUnits: number };
}

/**
 * The curve-only list (issue #102) has its own estimate: no coin has a graduation pool, so every
 * coin makes the launch-record request (4 units), the pool-list request (4 units plus 0.0048 a
 * pool, left out) and the daily screen on its curve (4 units): 12 units. Only a coin whose screen
 * passes goes on: the first 1,500 minutes of the curve and one hourly request, 2 requests, 8
 * units. Peak refinement and other pools' bars are not counted. The list holds coins whose
 * hourly peak was $100,000 or more, so most pass the screen (it stops a coin under $90,000);
 * `units` counts every coin as passing, `floorUnits` none.
 */
export const CURVE_ONLY_SCREEN_UNITS = 12;
export const CURVE_ONLY_REST_UNITS = 8;

export function estimateCurveOnlyUnits(counts: RoughPeakCounts): BackfillEstimate {
  const total = counts.counts.reduce((s, x) => s + x, 0) + counts.noPrice;
  const done = counts.done.reduce((s, x) => s + x, 0) + counts.doneNoPrice;
  const toDo = Math.max(0, total - done);
  const per = CURVE_ONLY_SCREEN_UNITS + CURVE_ONLY_REST_UNITS;
  return {
    rows:
      toDo === 0
        ? []
        : [
            {
              label: 'curve-only',
              coins: total,
              alreadyDone: done,
              toDo,
              unitsPerCoin: per,
              units: toDo * per,
            },
          ],
    coinsToDo: toDo,
    units: toDo * per,
    curveOnly: {
      screenUnitsPerCoin: CURVE_ONLY_SCREEN_UNITS,
      restUnitsPerCoin: CURVE_ONLY_REST_UNITS,
      floorUnits: toDo * CURVE_ONLY_SCREEN_UNITS,
    },
  };
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
