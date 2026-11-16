/**
 * Reads the sample CSV (a Dune result file) into coins for the `discovered`
 * stage.
 *
 * Columns: mint, half_year, cell, probe, cell_size, created_at, creator,
 * graduated_at, hours, peak_max_usd, peak_p999_usd, peak_at. Times are ISO 8601.
 *
 * Mapping: address = mint, chain = solana, launchpad = pump.fun,
 * launched_at = created_at, creator_wallet = creator, graduated_at =
 * graduated_at (never mixed with created_at), discovery_source =
 * dune-2026-11-15, rough_ath_market_cap_usd = peak_p999_usd.
 *
 * The file is data. A row that does not parse is reported and left out; it is
 * never guessed at.
 */
import { readFile } from 'node:fs/promises';
import type { DiscoveredCoin } from '@memecoinipedia/db';

export const SAMPLE_DISCOVERY_SOURCE = 'dune-2026-11-15';
const CHAIN = 'solana';
const LAUNCHPAD = 'pump.fun';
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const REQUIRED = ['mint', 'created_at', 'creator', 'graduated_at', 'peak_p999_usd'] as const;

export interface RowProblem {
  line: number;
  mint: string | null;
  problem: string;
}

export interface ParsedSample {
  coins: DiscoveredCoin[];
  /** Data rows read, valid or not. */
  rowsRead: number;
  problems: RowProblem[];
  /** Rows whose mint repeated an earlier row; the first one is kept. */
  duplicates: number;
}

/** Splits CSV text into rows of fields. Handles quoted fields, doubled quotes and CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }
  return rows;
}

function parseTime(value: string): Date | null | 'bad' {
  const v = value.trim();
  if (v === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? 'bad' : d;
}

export function parseSampleCsv(text: string): ParsedSample {
  const rows = parseCsv(text);
  const header = rows[0]?.map((h) => h.trim());
  if (!header) throw new Error('The sample file is empty');
  const col = new Map(header.map((h, i) => [h, i]));
  const missing = REQUIRED.filter((c) => !col.has(c));
  if (missing.length > 0) throw new Error(`The sample file lacks column(s): ${missing.join(', ')}`);
  const at = (r: string[], name: (typeof REQUIRED)[number]): string => r[col.get(name)!] ?? '';

  const coins: DiscoveredCoin[] = [];
  const problems: RowProblem[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]!;
    const line = i + 1;
    const mint = at(r, 'mint').trim();
    const bad = (problem: string) => problems.push({ line, mint: mint || null, problem });
    if (!BASE58.test(mint)) {
      bad('mint is not a base58 address');
      continue;
    }
    if (seen.has(mint)) {
      duplicates++;
      continue;
    }
    const launchedAt = parseTime(at(r, 'created_at'));
    const graduatedAt = parseTime(at(r, 'graduated_at'));
    if (launchedAt === 'bad' || graduatedAt === 'bad') {
      bad('created_at or graduated_at is not a valid time');
      continue;
    }
    if (launchedAt === null) {
      bad('created_at is empty');
      continue;
    }
    const creator = at(r, 'creator').trim();
    if (creator !== '' && !BASE58.test(creator)) {
      bad('creator is not a base58 address');
      continue;
    }
    const peakText = at(r, 'peak_p999_usd').trim();
    const peak = peakText === '' ? null : Number(peakText);
    if (peak !== null && (!Number.isFinite(peak) || peak < 0)) {
      bad('peak_p999_usd is not a non-negative number');
      continue;
    }
    seen.add(mint);
    coins.push({
      chain: CHAIN,
      address: mint,
      launchpad: LAUNCHPAD,
      launchedAt,
      creatorWallet: creator === '' ? null : creator,
      graduatedAt,
      discoverySource: SAMPLE_DISCOVERY_SOURCE,
      roughAthMarketCapUsd: peak,
    });
  }
  return { coins, rowsRead: rows.length - 1, problems, duplicates };
}

export async function readSampleFile(path: string): Promise<ParsedSample> {
  return parseSampleCsv(await readFile(path, 'utf8'));
}
