/**
 * Seeding a backfill from the Dune candidate file.
 *
 * Every valid row becomes a coin with its `discovered` stage done: chain solana, launchpad
 * pump.fun, launch time, creator, graduation time, the hourly 99.9th percentile peak as the rough
 * ATH, and the discovery source. Rows under the floor are seeded too: the floor is a choice made
 * when a run is started, not here. A row with no price is seeded with a null rough ATH.
 *
 * Without `confirm` the file is read and counted and nothing is written. The file is streamed:
 * rows are held 5,000 at a time, and the next chunk of the file is not read until the batch is
 * written.
 */
import fs from 'node:fs';
import {
  SEED_CHUNK,
  seedBackfillChunk,
  type BackfillSeedResult,
  type BackfillSeedRow,
  type Database,
} from '@memecoinipedia/db';
import type { Kysely } from 'kysely';
import {
  readCurveOnly,
  readGraduates,
  type CandidateList,
  type CurveOnlyRow,
  type GraduateRow,
} from '../discovery/index.js';
import { CELL_EDGES, CELL_LABELS } from './cells.js';

export const SEED_CHAIN = 'solana';
export const SEED_LAUNCHPAD = 'pump.fun';
export const DEFAULT_DISCOVERY_SOURCE = 'dune-graduates';
/** `coins.discovery_source` of the curve-only list (issue #102). Selections key on it. */
export const CURVE_ONLY_SOURCE = 'dune-curve-only';

export interface SeedFileReport {
  /** Data records in the file, valid or not. */
  records: number;
  /** Valid rows, a mint repeated in the file counted once. */
  rows: number;
  repeated: number;
  badRows: number;
  badReasons: Array<{ line: number; reason: string }>;
  /** Rows with a rough peak, and rows with none. */
  priced: number;
  noPrice: number;
  /** Rows by rough-peak cell, in the order of `CELL_LABELS`. */
  byCell: number[];
  /** Rows by the creation event's mayhem flag (curve-only list only; zero for graduates). */
  mayhem: { yes: number; no: number; unknown: number };
  /** Which list was read. */
  list: CandidateList;
  /** Totals of what the database did; absent for a dry run. */
  written: BackfillSeedResult | null;
  seconds: number;
}

export interface SeedOptions {
  file: string;
  /**
   * Which candidate list the file is. Default `graduates`: a blank graduation time rejects the
   * row. `curve-only`: a graduation time rejects the row, and the source is `dune-curve-only`.
   */
  list?: CandidateList;
  discoverySource?: string;
  /** Write to the database. Without it the file is only read and counted. */
  confirm: boolean;
  db?: Kysely<Database> | undefined;
  now?: () => Date;
  onProgress?: (rowsWritten: number) => void;
}

export const toSeedRow = (r: GraduateRow | CurveOnlyRow): BackfillSeedRow => ({
  address: r.mint,
  launchpad: SEED_LAUNCHPAD,
  launchedAt: new Date(r.createdAtMs),
  creatorWallet: r.creator,
  graduatedAt: r.graduatedAtMs === null ? null : new Date(r.graduatedAtMs),
  roughAthMarketCapUsd: r.roughPeakUsd,
  ...('isMayhemMode' in r ? { isMayhemMode: r.isMayhemMode } : {}),
});

/** The discovery source of a list. The source of the curve-only list is what the selection keys on. */
export const discoverySourceFor = (list: CandidateList): string =>
  list === 'curve-only' ? CURVE_ONLY_SOURCE : DEFAULT_DISCOVERY_SOURCE;

export const cellOf = (rough: number): number => CELL_EDGES.filter((e) => e <= rough).length;

export async function seedFromCandidateFile(opts: SeedOptions): Promise<SeedFileReport> {
  const started = Date.now();
  const now = opts.now ?? (() => new Date());
  if (opts.confirm && !opts.db) throw new Error('Seeding needs a database');
  const list = opts.list ?? 'graduates';
  const source = opts.discoverySource ?? discoverySourceFor(list);

  const seen = new Set<string>();
  const report: SeedFileReport = {
    records: 0,
    rows: 0,
    repeated: 0,
    badRows: 0,
    badReasons: [],
    priced: 0,
    noPrice: 0,
    byCell: CELL_LABELS.map(() => 0),
    mayhem: { yes: 0, no: 0, unknown: 0 },
    list,
    written: null,
    seconds: 0,
  };
  const totals: BackfillSeedResult = {
    total: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    stagesMarked: 0,
  };
  let batch: BackfillSeedRow[] = [];
  let written = 0;

  const flush = async (): Promise<void> => {
    if (!opts.confirm || batch.length === 0) {
      batch = [];
      return;
    }
    const chunk = batch;
    batch = [];
    const r = await seedBackfillChunk(opts.db!, chunk, {
      chain: SEED_CHAIN,
      discoverySource: source,
      now: now(),
    });
    totals.total += r.total;
    totals.inserted += r.inserted;
    totals.updated += r.updated;
    totals.unchanged += r.unchanged;
    totals.stagesMarked += r.stagesMarked;
    written += chunk.length;
    opts.onProgress?.(written);
  };

  // Backpressure: the reader asks for the next piece of the file only after the batch it just
  // filled has been written.
  async function* pieces(): AsyncGenerator<Uint8Array> {
    for await (const piece of fs.createReadStream(opts.file)) {
      yield piece as Uint8Array;
      if (batch.length >= SEED_CHUNK) await flush();
    }
  }

  const onRow = (r: GraduateRow | CurveOnlyRow): void => {
    if (seen.has(r.mint)) {
      report.repeated++;
      return;
    }
    seen.add(r.mint);
    report.rows++;
    if (r.roughPeakUsd === null) report.noPrice++;
    else {
      report.priced++;
      report.byCell[cellOf(r.roughPeakUsd)]!++;
    }
    if ('isMayhemMode' in r) {
      if (r.isMayhemMode === true) report.mayhem.yes++;
      else if (r.isMayhemMode === false) report.mayhem.no++;
      else report.mayhem.unknown++;
    }
    batch.push(toSeedRow(r));
  };
  // The reader is chosen by the option, never by looking at the file.
  const read =
    list === 'curve-only'
      ? await readCurveOnly(pieces(), { onRow })
      : await readGraduates(pieces(), { onRow });
  await flush();

  report.records = read.records;
  report.badRows = read.bad.count;
  report.badReasons = read.bad.stored.slice(0, 10);
  report.written = opts.confirm ? totals : null;
  report.seconds = (Date.now() - started) / 1000;
  return report;
}

const n = (x: number) => x.toLocaleString('en-US');

export function formatSeedReport(r: SeedFileReport, confirm: boolean): string {
  const lines: string[] = [];
  lines.push(
    `Candidate file: ${n(r.records)} records, ${n(r.rows)} valid coins` +
      `${r.repeated > 0 ? `, ${n(r.repeated)} repeated mints left out` : ''}` +
      `, ${n(r.badRows)} rows rejected.`,
  );
  for (const b of r.badReasons) lines.push(`  line ${b.line}: ${b.reason}`);
  lines.push(`With a rough peak: ${n(r.priced)}; with none: ${n(r.noPrice)}.`);
  lines.push('By rough peak:');
  r.byCell.forEach((c, i) => lines.push(`  ${CELL_LABELS[i]!.padEnd(14)} ${n(c).padStart(9)}`));
  if (r.list === 'curve-only') {
    lines.push(
      `Mayhem flag in the file: true ${n(r.mayhem.yes)}, false ${n(r.mayhem.no)}, empty ${n(r.mayhem.unknown)}.`,
    );
  }
  if (!confirm) {
    lines.push('Nothing written (no --confirm). Seeding makes no provider call and costs nothing.');
  } else if (r.written) {
    const w = r.written;
    lines.push(
      `Seeded in ${r.seconds.toFixed(1)} s: ${n(w.inserted)} new, ${n(w.updated)} changed, ` +
        `${n(w.unchanged)} already as they were; discovered stage marked on ${n(w.stagesMarked)}.`,
    );
  }
  return lines.join('\n');
}
