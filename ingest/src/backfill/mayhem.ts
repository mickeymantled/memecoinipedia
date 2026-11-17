/**
 * Loading the Mayhem Mode flag of the graduates already in the database from the two-column file
 * `ingest/sql/dune/mayhem-graduates.sql` produces (issue #102). Reads the file and, with `confirm`,
 * writes the flag onto coins that exist; it inserts no coin and asks no provider. Without
 * `confirm` it opens the database only to read, and prints what would change.
 */
import fs from 'node:fs';
import { applyMayhemFlags, type Database, type MayhemFlagResult } from '@memecoinipedia/db';
import type { Kysely } from 'kysely';
import { parseCsvRecords } from '../discovery/index.js';

export const MAYHEM_FILE_COLUMNS = ['mint', 'is_mayhem_mode'] as const;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const CHUNK = 5_000;

export interface MayhemFileReport extends MayhemFlagResult {
  /** Data records in the file. */
  records: number;
  /** Records rejected (bad mint, or a flag that is not true or false). */
  rejected: number;
  rejectedReasons: string[];
  confirm: boolean;
}

export async function loadMayhemFlags(opts: {
  file: string;
  confirm: boolean;
  db: Kysely<Database>;
  now?: Date;
}): Promise<MayhemFileReport> {
  const now = opts.now ?? new Date();
  const report: MayhemFileReport = {
    records: 0,
    rejected: 0,
    rejectedReasons: [],
    confirm: opts.confirm,
    given: 0,
    givenTrue: 0,
    givenFalse: 0,
    notFound: 0,
    setTrue: 0,
    setFalse: 0,
    keptTrue: 0,
    unchanged: 0,
  };
  const reject = (line: number, reason: string) => {
    report.rejected += 1;
    if (report.rejectedReasons.length < 10) report.rejectedReasons.push(`line ${line}: ${reason}`);
  };
  // A mint repeated in the file counts once; a true wins.
  const flags = new Map<string, boolean>();
  let header: string[] | null = null;
  for await (const rec of parseCsvRecords(fs.createReadStream(opts.file))) {
    if (header === null) {
      header = rec.fields.map((f) => f.replace(new RegExp('^\\uFEFF'), '').trim());
      if (header.join(',') !== MAYHEM_FILE_COLUMNS.join(',')) {
        throw new Error(`The header must be exactly: ${MAYHEM_FILE_COLUMNS.join(',')}`);
      }
      continue;
    }
    if (rec.fields.length === 1 && rec.fields[0]!.trim() === '') continue;
    report.records += 1;
    if (rec.malformed || rec.fields.length !== 2) {
      reject(rec.line, 'malformed record');
      continue;
    }
    const mint = rec.fields[0]!.trim();
    const flag = rec.fields[1]!.trim().toLowerCase();
    if (!BASE58.test(mint)) reject(rec.line, 'mint: missing or not a base58 address');
    else if (flag !== 'true' && flag !== 'false')
      reject(rec.line, 'is_mayhem_mode: not true or false');
    else flags.set(mint, (flags.get(mint) ?? false) || flag === 'true');
  }
  if (header === null) throw new Error('The file is empty');

  const pairs = [...flags].map(([address, isMayhemMode]) => ({ address, isMayhemMode }));
  for (let i = 0; i < pairs.length; i += CHUNK) {
    const r = await applyMayhemFlags(opts.db, pairs.slice(i, i + CHUNK), {
      chain: 'solana',
      apply: opts.confirm,
      now,
    });
    report.given += r.given;
    report.givenTrue += r.givenTrue;
    report.givenFalse += r.givenFalse;
    report.notFound += r.notFound;
    report.setTrue += r.setTrue;
    report.setFalse += r.setFalse;
    report.keptTrue += r.keptTrue;
    report.unchanged += r.unchanged;
  }
  return report;
}

const n = (x: number) => x.toLocaleString('en-US');

export function formatMayhemReport(r: MayhemFileReport): string {
  const lines = [
    `Read ${n(r.records)} records: ${n(r.given)} coins (true ${n(r.givenTrue)}, false ${n(r.givenFalse)}), ${n(r.rejected)} rejected.`,
    ...r.rejectedReasons.map((x) => `  rejected, ${x}`),
    `${r.confirm ? 'Changed' : 'Would change'}: set to true ${n(r.setTrue)}, set to false (was empty) ${n(r.setFalse)}.`,
    `Left as they are: already the same ${n(r.unchanged)}, already true while the file says false ${n(r.keptTrue)}.`,
    `Not in the database (nothing inserted): ${n(r.notFound)}.`,
  ];
  lines.push(r.confirm ? 'Written.' : 'Dry run: no write. Add --confirm to write.');
  return lines.join('\n');
}
