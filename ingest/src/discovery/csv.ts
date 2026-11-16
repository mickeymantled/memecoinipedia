/**
 * Reader for the CSV that `discovery.sql` returns: one row per graduated coin.
 *
 * Columns, in this order: mint, created_at, creator, graduated_at, hours, peak_max_usd,
 * peak_p999_usd, peak_at, last_hour. The four time columns are epoch seconds (UTC), whole
 * numbers. `hours` is the number of hours with a price in Dune's hourly table; 0 when the coin has
 * none, and then the peak columns and the two hour columns are empty. `peak_p999_usd` (the 99.9th
 * percentile of the hourly prices times one billion) is the rough peak used for sizing and the
 * sample; `peak_max_usd` can be a bad print.
 *
 * Required in the header and in every row: `mint`, `created_at`, `graduated_at`. The other
 * columns may be empty, or absent from the header (a download with `columns=` leaves some out).
 * Header order does not matter.
 *
 * Dune writes an empty value as the literal text `<nil>`; it is read exactly like an empty field.
 * Dune writes whole numbers in exponent form (`1.71051111e+09`). They are exact: numbers are
 * parsed as numbers, and a whole number is required where one is expected.
 *
 * The parse is streaming: input chunks are turned into records one at a time, so a large file is
 * never held as text. Quoted fields (with `""` escapes and embedded newlines) are handled even
 * though no column holds free text. A bad row is collected with its line number and a reason
 * and the read goes on; at most 100 reasons are stored, and the count is always exact.
 */
import fs from 'node:fs';

export const GRADUATE_COLUMNS = [
  'mint',
  'created_at',
  'creator',
  'graduated_at',
  'hours',
  'peak_max_usd',
  'peak_p999_usd',
  'peak_at',
  'last_hour',
] as const;

export const REQUIRED_COLUMNS = ['mint', 'created_at', 'graduated_at'] as const;

type Column = (typeof GRADUATE_COLUMNS)[number];

export interface GraduateRow {
  mint: string;
  /** Epoch milliseconds, UTC. */
  createdAtMs: number;
  creator: string | null;
  graduatedAtMs: number;
  /** Hours with a price in Dune's hourly table. Null when the column is empty or absent. */
  hours: number | null;
  /** Highest hourly price times one billion. Can be a bad print. */
  peakMaxUsd: number | null;
  /** 99.9th percentile of the hourly prices times one billion. */
  peakP999Usd: number | null;
  peakAtMs: number | null;
  lastHourMs: number | null;
  /** The rough peak used for sizing and the sample: always `peakP999Usd`. */
  roughPeakUsd: number | null;
}

export interface BadRow {
  /** 1-based line where the record starts. */
  line: number;
  reason: string;
}

export interface BadRows {
  count: number;
  /** The first `MAX_BAD_ROW_REASONS` reasons. */
  stored: BadRow[];
}

export const MAX_BAD_ROW_REASONS = 100;

export class CsvHeaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CsvHeaderError';
  }
}

export interface ReadGraduatesResult {
  /** Empty when `onRow` was given. */
  rows: GraduateRow[];
  /** Data records seen, good and bad. */
  records: number;
  bad: BadRows;
}

export interface ReadGraduatesOptions {
  /** Called for each good row instead of collecting it. */
  onRow?: (row: GraduateRow) => void;
}

type Chunk = string | Uint8Array;

// Parsing ---------------------------------------------------------------

interface CsvRecord {
  line: number;
  fields: string[];
  /** Bad quoting: a stray quote, text after a closing quote, or a quote never closed. */
  malformed: boolean;
}

type State = 'start' | 'unquoted' | 'quoted' | 'quote-in-quoted' | 'after-close';

/** Splits a stream of chunks into records, honouring quotes. Yields once per record. */
export async function* parseCsvRecords(source: AsyncIterable<Chunk>): AsyncGenerator<CsvRecord> {
  const decoder = new TextDecoder('utf-8');
  let state = 'start' as State;
  let fields: string[] = [];
  let field = '';
  let malformed = false;
  let line = 1;
  let recordLine = 1;
  let pendingCr = false;
  let first = true;

  function* step(ch: string): Generator<CsvRecord> {
    if (pendingCr) {
      pendingCr = false;
      if (ch === '\n') return; // CRLF: the record already ended at the CR.
    }
    if (state === 'quote-in-quoted') {
      if (ch === '"') {
        field += '"';
        state = 'quoted';
        return;
      }
      state = 'after-close';
    }
    if (state === 'quoted') {
      if (ch === '"') state = 'quote-in-quoted';
      else {
        if (ch === '\n') line++;
        field += ch;
      }
      return;
    }
    if (ch === ',') {
      fields.push(field);
      field = '';
      state = 'start';
      return;
    }
    if (ch === '\n' || ch === '\r') {
      const blankLine = state === 'start' && fields.length === 0;
      if (!blankLine) {
        fields.push(field);
        yield { line: recordLine, fields, malformed };
      }
      fields = [];
      field = '';
      malformed = false;
      state = 'start';
      line++;
      recordLine = line;
      if (ch === '\r') pendingCr = true;
      return;
    }
    if (state === 'after-close') {
      malformed = true; // text after a closing quote
    } else if (ch === '"') {
      if (state === 'start') state = 'quoted';
      else {
        malformed = true; // a quote inside an unquoted field
        field += ch;
      }
    } else {
      state = 'unquoted';
      field += ch;
    }
  }

  function* feed(text: string): Generator<CsvRecord> {
    for (const ch of text) yield* step(ch);
  }

  for await (const chunk of source) {
    let text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    if (first && text.length > 0) {
      first = false;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    yield* feed(text);
  }
  yield* feed(decoder.decode());
  if (state === 'quoted') malformed = true;
  if (state !== 'start' || fields.length > 0) {
    fields.push(field);
    yield { line: recordLine, fields, malformed };
  }
}

// Field parsers -----------------------------------------------------------

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

class FieldError extends Error {}

/** Dune writes an empty value as the literal text `<nil>`; it counts as blank. */
const blank = (v: string): boolean => {
  const t = v.trim();
  return t === '' || t === '<nil>';
};

function number(name: string, v: string): number {
  const t = v.trim();
  const n = Number(t);
  if (!NUMBER.test(t) || !Number.isFinite(n)) throw new FieldError(`${name}: not a number`);
  return n;
}

function optText(name: string, v: string, pattern: RegExp): string | null {
  if (blank(v)) return null;
  const t = v.trim();
  if (!pattern.test(t)) throw new FieldError(`${name}: unexpected format`);
  return t;
}

/** Epoch seconds, a whole number, as milliseconds. */
function seconds(name: string, v: string): number {
  const n = number(name, v);
  if (!Number.isInteger(n) || n <= 0 || n >= 1e11) {
    throw new FieldError(`${name}: not a whole number of epoch seconds`);
  }
  return n * 1000;
}

const optSeconds = (name: string, v: string): number | null => (blank(v) ? null : seconds(name, v));

function optUsd(name: string, v: string): number | null {
  if (blank(v)) return null;
  const n = number(name, v);
  if (n < 0) throw new FieldError(`${name}: negative`);
  return n;
}

function optHours(name: string, v: string): number | null {
  if (blank(v)) return null;
  const n = number(name, v);
  if (!Number.isInteger(n) || n < 0)
    throw new FieldError(`${name}: not a non-negative whole number`);
  return n;
}

function toRow(get: (name: Column) => string): GraduateRow {
  const mint = get('mint').trim();
  if (!BASE58.test(mint)) throw new FieldError('mint: missing or not a base58 address');
  if (blank(get('created_at'))) throw new FieldError('created_at: missing');
  if (blank(get('graduated_at'))) throw new FieldError('graduated_at: missing');
  const p999 = optUsd('peak_p999_usd', get('peak_p999_usd'));
  return {
    mint,
    createdAtMs: seconds('created_at', get('created_at')),
    creator: optText('creator', get('creator'), BASE58),
    graduatedAtMs: seconds('graduated_at', get('graduated_at')),
    hours: optHours('hours', get('hours')),
    peakMaxUsd: optUsd('peak_max_usd', get('peak_max_usd')),
    peakP999Usd: p999,
    peakAtMs: optSeconds('peak_at', get('peak_at')),
    lastHourMs: optSeconds('last_hour', get('last_hour')),
    roughPeakUsd: p999,
  };
}

// Reader ---------------------------------------------------------------

/** Reads graduates from a stream of chunks. Throws `CsvHeaderError` for a bad header. */
export async function readGraduates(
  source: AsyncIterable<Chunk>,
  options: ReadGraduatesOptions = {},
): Promise<ReadGraduatesResult> {
  const rows: GraduateRow[] = [];
  const bad: BadRows = { count: 0, stored: [] };
  let records = 0;
  let index: Map<string, number> | null = null;

  const reject = (line: number, reason: string) => {
    bad.count++;
    if (bad.stored.length < MAX_BAD_ROW_REASONS) bad.stored.push({ line, reason });
  };

  for await (const rec of parseCsvRecords(source)) {
    if (index === null) {
      const names = rec.fields.map((f) => f.trim());
      const missing = REQUIRED_COLUMNS.filter((c) => !names.includes(c));
      if (missing.length > 0)
        throw new CsvHeaderError(`Header is missing columns: ${missing.join(', ')}`);
      if (new Set(names).size !== names.length)
        throw new CsvHeaderError('Header repeats a column name');
      index = new Map(names.map((n, i) => [n, i]));
      continue;
    }
    records++;
    if (rec.malformed) {
      reject(rec.line, 'malformed quoting');
      continue;
    }
    if (rec.fields.length !== index.size) {
      reject(rec.line, `expected ${index.size} columns, found ${rec.fields.length}`);
      continue;
    }
    try {
      const idx = index;
      const row = toRow((name) => {
        const at = idx.get(name);
        return at === undefined ? '' : (rec.fields[at] ?? '');
      });
      if (options.onRow) options.onRow(row);
      else rows.push(row);
    } catch (err) {
      if (err instanceof FieldError) reject(rec.line, err.message);
      else throw err;
    }
  }
  if (index === null) throw new CsvHeaderError('The file is empty: no header row');
  return { rows, records, bad };
}

export function readGraduatesFile(
  path: string,
  options: ReadGraduatesOptions = {},
): Promise<ReadGraduatesResult> {
  return readGraduates(fs.createReadStream(path), options);
}

/**
 * Reads several files into one list. A mint seen twice (across files) is kept once, the first
 * time, and counted in `duplicates`. Bad rows are summed with their file path in the reason.
 */
export async function readGraduatesFiles(paths: readonly string[]): Promise<{
  rows: GraduateRow[];
  records: number;
  duplicates: number;
  bad: BadRows;
}> {
  const seen = new Set<string>();
  const rows: GraduateRow[] = [];
  const bad: BadRows = { count: 0, stored: [] };
  let records = 0;
  let duplicates = 0;
  for (const p of paths) {
    const r = await readGraduatesFile(p);
    records += r.records;
    bad.count += r.bad.count;
    for (const b of r.bad.stored) {
      if (bad.stored.length < MAX_BAD_ROW_REASONS)
        bad.stored.push({ line: b.line, reason: `${p}: ${b.reason}` });
    }
    for (const row of r.rows) {
      if (seen.has(row.mint)) duplicates++;
      else {
        seen.add(row.mint);
        rows.push(row);
      }
    }
  }
  return { rows, records, duplicates, bad };
}
