/**
 * `drawSample`: the Phase A sample, at most 500 coins, drawn without any random function.
 *
 * - Probe coins are always in the output, flagged, and are removed from the pool before the
 *   draw, so they never count against a quota. A probe that is not in the list is still
 *   returned, flagged as missing.
 * - The other coins are drawn per launch half-year (UTC half of `created_at`, `2024-H1` to
 *   `2026-H2` by default; coins outside the given half-years are not drawn) and per rough-peak
 *   cell. Cells are lower-inclusive and upper-exclusive. A coin with no rough peak, or one under
 *   the lowest cell, is in no cell and is not drawn.
 * - Inside a cell the order is the SHA-256 of the mint (hex, ascending), then the mint, so the
 *   same list gives the same sample in any row order. A mint that appears twice is reduced to its
 *   earliest `created_at` row (ties broken by the row's JSON text), also independent of order.
 * - A cell with fewer coins than its quota takes all it has. The shortfalls of the other cells of
 *   the same half-year are added to the quota of the fill cell (`$100k to $1M` by default), which
 *   then takes what exists.
 */
import { createHash } from 'node:crypto';
import type { GraduateRow } from './csv.js';

export interface SampleCell {
  name: string;
  /** Inclusive lower bound, USD. */
  minUsd: number;
  /** Exclusive upper bound, USD; null for no bound. */
  maxUsd: number | null;
  quota: number;
}

export const DEFAULT_CELLS: readonly SampleCell[] = [
  { name: '50k-100k', minUsd: 50_000, maxUsd: 100_000, quota: 10 },
  { name: '100k-1M', minUsd: 100_000, maxUsd: 1_000_000, quota: 35 },
  { name: '1M-10M', minUsd: 1_000_000, maxUsd: 10_000_000, quota: 20 },
  { name: '10M+', minUsd: 10_000_000, maxUsd: null, quota: 15 },
];

export const DEFAULT_FILL_CELL = '100k-1M';
export const DEFAULT_HALF_YEARS: readonly string[] = [
  '2024-H1',
  '2024-H2',
  '2025-H1',
  '2025-H2',
  '2026-H1',
  '2026-H2',
];
export const DEFAULT_MAX_COINS = 500;

export interface DrawOptions {
  cells?: readonly SampleCell[];
  fillCell?: string;
  halfYears?: readonly string[];
  /** Probe mints, in output order. */
  probes?: readonly string[];
  /** Hard bound on the output. Default 500. */
  maxCoins?: number;
}

export interface SampleRow {
  mint: string;
  /** Null for a probe outside every half-year, or one missing from the list. */
  halfYear: string | null;
  /** Null for a probe with no rough peak in any cell, or one missing from the list. */
  cell: string | null;
  probe: boolean;
  /** True for a probe that is not in the list. Then `row` is null. */
  probeMissing: boolean;
  row: GraduateRow | null;
}

export function halfYearOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-H${d.getUTCMonth() < 6 ? 1 : 2}`;
}

function cellOf(peak: number | null, cells: readonly SampleCell[]): string | null {
  if (peak === null) return null;
  for (const c of cells) {
    if (peak >= c.minUsd && (c.maxUsd === null || peak < c.maxUsd)) return c.name;
  }
  return null;
}

const sha = (mint: string): string => createHash('sha256').update(mint).digest('hex');

function cmpCoins(a: { hash: string; mint: string }, b: { hash: string; mint: string }): number {
  if (a.hash !== b.hash) return a.hash < b.hash ? -1 : 1;
  return a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0;
}

/** One row per mint, chosen without regard to input order. */
function dedupe(rows: readonly GraduateRow[]): Map<string, GraduateRow> {
  const best = new Map<string, { row: GraduateRow; text: string }>();
  for (const row of rows) {
    const text = JSON.stringify(row);
    const cur = best.get(row.mint);
    if (
      !cur ||
      row.createdAtMs < cur.row.createdAtMs ||
      (row.createdAtMs === cur.row.createdAtMs && text < cur.text)
    ) {
      best.set(row.mint, { row, text });
    }
  }
  return new Map([...best].map(([m, v]) => [m, v.row]));
}

export function drawSample(rows: readonly GraduateRow[], options: DrawOptions = {}): SampleRow[] {
  const cells = options.cells ?? DEFAULT_CELLS;
  const fillName = options.fillCell ?? DEFAULT_FILL_CELL;
  const halfYears = options.halfYears ?? DEFAULT_HALF_YEARS;
  const probes = [...new Set(options.probes ?? [])];
  const maxCoins = options.maxCoins ?? DEFAULT_MAX_COINS;

  if (!cells.some((c) => c.name === fillName))
    throw new RangeError(`Unknown fill cell ${fillName}`);
  const quotaTotal = cells.reduce((s, c) => s + c.quota, 0);
  if (quotaTotal * halfYears.length + probes.length > maxCoins) {
    throw new RangeError(
      `Quotas allow up to ${quotaTotal * halfYears.length + probes.length} coins, over the limit of ${maxCoins}`,
    );
  }

  const unique = dedupe(rows);
  const out: SampleRow[] = [];
  const probeSet = new Set(probes);

  for (const mint of probes) {
    const row = unique.get(mint) ?? null;
    out.push({
      mint,
      halfYear: row ? halfYearOf(row.createdAtMs) : null,
      cell: row ? cellOf(row.roughPeakUsd, cells) : null,
      probe: true,
      probeMissing: row === null,
      row,
    });
  }

  // The pool: probes removed, then grouped by half-year and cell.
  const pool = new Map<string, Array<{ hash: string; mint: string; row: GraduateRow }>>();
  const wanted = new Set(halfYears);
  for (const [mint, row] of unique) {
    if (probeSet.has(mint)) continue;
    const hy = halfYearOf(row.createdAtMs);
    if (!wanted.has(hy)) continue;
    const cell = cellOf(row.roughPeakUsd, cells);
    if (cell === null) continue;
    const key = `${hy}\u0000${cell}`;
    const list = pool.get(key);
    const item = { hash: sha(mint), mint, row };
    if (list) list.push(item);
    else pool.set(key, [item]);
  }
  for (const list of pool.values()) list.sort(cmpCoins);

  for (const hy of halfYears) {
    const available = (cell: string) => pool.get(`${hy}\u0000${cell}`) ?? [];
    let shortfall = 0;
    const take = new Map<string, number>();
    for (const c of cells) {
      if (c.name === fillName) continue;
      const n = Math.min(c.quota, available(c.name).length);
      shortfall += c.quota - n;
      take.set(c.name, n);
    }
    const fill = cells.find((c) => c.name === fillName) as SampleCell;
    take.set(fillName, Math.min(fill.quota + shortfall, available(fillName).length));
    for (const c of cells) {
      for (const item of available(c.name).slice(0, take.get(c.name) ?? 0)) {
        out.push({
          mint: item.mint,
          halfYear: hy,
          cell: c.name,
          probe: false,
          probeMissing: false,
          row: item.row,
        });
      }
    }
  }
  return out;
}

const csvCell = (v: string | number | boolean | null): string => {
  if (v === null) return '';
  const t = String(v);
  return /[",\n\r]/.test(t) ? `"${t.replaceAll('"', '""')}"` : t;
};

/** The sample as CSV text, one row per coin. */
export function sampleToCsv(sample: readonly SampleRow[]): string {
  const header = 'mint,half_year,cell,probe,probe_missing,created_at,rough_peak_usd';
  const lines = sample.map((s) =>
    [
      s.mint,
      s.halfYear,
      s.cell,
      s.probe,
      s.probeMissing,
      s.row ? new Date(s.row.createdAtMs).toISOString() : null,
      s.row?.roughPeakUsd ?? null,
    ]
      .map(csvCell)
      .join(','),
  );
  return [header, ...lines].join('\n') + '\n';
}
