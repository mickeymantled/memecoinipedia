/**
 * Reader for the CSV that `graduates.sql` returns: one row per graduated coin.
 *
 * Columns: mint, created_at, creator, graduated_at, graduation_pool, graduation_venue,
 * rough_peak_usd, rough_peak_at, trade_count, first_trade_at, last_trade_at. Any column but
 * `mint` and `created_at` may be empty. The header must name all eleven (any order).
 *
 * The parse is streaming: input chunks are turned into records one at a time, so a large file is
 * never held as text. Quoted fields (with `""` escapes and embedded newlines) are handled even
 * though no column holds free text. A bad row is collected with its line number and a reason
 * and the read goes on; at most 100 reasons are stored, and the count is always exact.
 *
 * Timestamps become epoch milliseconds (UTC): `YYYY-MM-DD HH:MM:SS[.fff]` with an optional
 * ` UTC` suffix, or ISO 8601 (`YYYY-MM-DDTHH:MM:SS[.fff]` with `Z`, an offset, or none, which
 * is read as UTC). Numbers are parsed strictly: plain decimal or exponent notation, finite.
 */
import fs from 'node:fs';

export const GRADUATE_COLUMNS = [
  'mint',
  'created_at',
  'creator',
  'graduated_at',
  'graduation_pool',
  'graduation_venue',
  'rough_peak_usd',
  'rough_peak_at',
  'trade_count',
  'first_trade_at',
  'last_trade_at',
] as const;

export interface GraduateRow {
  mint: string;
  /** Epoch milliseconds, UTC. */
  createdAtMs: number;
  creator: string | null;
  graduatedAtMs: number | null;
  graduationPool: string | null;
  graduationVenue: string | null;
  roughPeakUsd: number | null;
  roughPeakAtMs: number | null;
  tradeCount: number | null;
  firstTradeAtMs: number | null;
  lastTradeAtMs: number | null;
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
const VENUE = /^[A-Za-z0-9_.-]{1,40}$/;
const NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const INTEGER = /^\d{1,15}$/;
const SQL_TS = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?: UTC)?$/;
const ISO_TS =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})?$/;

/** Epoch ms for a timestamp string, or null when it is not one of the accepted forms. */
export function parseTimestampMs(text: string): number | null {
  const m = ISO_TS.exec(text) ?? SQL_TS.exec(text);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (h > 23 || mi > 59 || s > 59) return null;
  const ms = m[7] ? Number(m[7].padEnd(3, '0').slice(0, 3)) : 0;
  const t = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  const check = new Date(t);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
    return null;
  }
  const zone = m[8];
  if (zone === undefined || zone === 'Z') return t;
  const sign = zone.startsWith('-') ? -1 : 1;
  const oh = Number(zone.slice(1, 3));
  const om = Number(zone.slice(4, 6));
  if (oh > 23 || om > 59) return null;
  return t - sign * (oh * 60 + om) * 60_000;
}

class FieldError extends Error {}

const blank = (v: string): boolean => v.trim() === '';

function optText(name: string, v: string, pattern: RegExp): string | null {
  if (blank(v)) return null;
  const t = v.trim();
  if (!pattern.test(t)) throw new FieldError(`${name}: unexpected format`);
  return t;
}

function optTime(name: string, v: string): number | null {
  if (blank(v)) return null;
  const t = parseTimestampMs(v.trim());
  if (t === null) throw new FieldError(`${name}: not a timestamp`);
  return t;
}

function optNumber(name: string, v: string): number | null {
  if (blank(v)) return null;
  const t = v.trim();
  const n = Number(t);
  if (!NUMBER.test(t) || !Number.isFinite(n)) throw new FieldError(`${name}: not a number`);
  if (n < 0) throw new FieldError(`${name}: negative`);
  return n;
}

function optCount(name: string, v: string): number | null {
  if (blank(v)) return null;
  const t = v.trim();
  if (!INTEGER.test(t)) throw new FieldError(`${name}: not a non-negative integer`);
  return Number(t);
}

function toRow(get: (name: (typeof GRADUATE_COLUMNS)[number]) => string): GraduateRow {
  const mintRaw = get('mint').trim();
  if (!BASE58.test(mintRaw)) throw new FieldError('mint: missing or not a base58 address');
  const created = optTime('created_at', get('created_at'));
  if (created === null) throw new FieldError('created_at: missing');
  return {
    mint: mintRaw,
    createdAtMs: created,
    creator: optText('creator', get('creator'), BASE58),
    graduatedAtMs: optTime('graduated_at', get('graduated_at')),
    graduationPool: optText('graduation_pool', get('graduation_pool'), BASE58),
    graduationVenue: optText('graduation_venue', get('graduation_venue'), VENUE),
    roughPeakUsd: optNumber('rough_peak_usd', get('rough_peak_usd')),
    roughPeakAtMs: optTime('rough_peak_at', get('rough_peak_at')),
    tradeCount: optCount('trade_count', get('trade_count')),
    firstTradeAtMs: optTime('first_trade_at', get('first_trade_at')),
    lastTradeAtMs: optTime('last_trade_at', get('last_trade_at')),
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
      const missing = GRADUATE_COLUMNS.filter((c) => !names.includes(c));
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
      const row = toRow((name) => rec.fields[idx.get(name) as number] ?? '');
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
