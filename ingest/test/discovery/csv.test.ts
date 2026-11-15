import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CsvHeaderError,
  GRADUATE_COLUMNS,
  MAX_BAD_ROW_REASONS,
  parseCsvRecords,
  parseTimestampMs,
  readGraduates,
  readGraduatesFile,
  readGraduatesFiles,
} from '../../src/discovery/index.js';

const HEADER = GRADUATE_COLUMNS.join(',');
const A = '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump';
const B = '2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump';
const POOL = 'HfVxfzmAPWER3LQ8VbDcbch6ACchbpuyXv3ujgRtpump';

/** A row with the 11 columns in header order; `over` replaces fields by column name. */
function line(over: Partial<Record<(typeof GRADUATE_COLUMNS)[number], string>> = {}): string {
  const base: Record<string, string> = {
    mint: A,
    created_at: '2024-10-17 12:00:00',
    creator: '',
    graduated_at: '',
    graduation_pool: '',
    graduation_venue: '',
    rough_peak_usd: '',
    rough_peak_at: '',
    trade_count: '',
    first_trade_at: '',
    last_trade_at: '',
    ...over,
  };
  return GRADUATE_COLUMNS.map((c) => base[c]).join(',');
}

async function* chunks(text: string, size = 7): AsyncGenerator<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}

async function collect(text: string) {
  const out = [];
  for await (const r of parseCsvRecords(chunks(text, 3))) out.push(r);
  return out;
}

const tmpDirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-test-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('parseCsvRecords', () => {
  it('splits plain records, with LF, CRLF and a missing final newline', async () => {
    const recs = await collect('a,b\r\nc,d\ne,f');
    expect(recs.map((r) => r.fields)).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e', 'f'],
    ]);
    expect(recs.map((r) => r.line)).toEqual([1, 2, 3]);
  });

  it('handles quoted fields: commas, doubled quotes, newlines, and the line numbers after them', async () => {
    const recs = await collect('a,"b,1","say ""hi""","x\ny"\nlast,1\n');
    expect(recs[0]!.fields).toEqual(['a', 'b,1', 'say "hi"', 'x\ny']);
    expect(recs[0]!.malformed).toBe(false);
    expect(recs[1]).toMatchObject({ line: 3, fields: ['last', '1'] });
  });

  it('keeps empty fields and skips blank lines', async () => {
    const recs = await collect('a,,c\n\n,,\n');
    expect(recs.map((r) => r.fields)).toEqual([
      ['a', '', 'c'],
      ['', '', ''],
    ]);
  });

  it('flags bad quoting', async () => {
    expect((await collect('a,b"c,d\n'))[0]!.malformed).toBe(true);
    expect((await collect('a,"b"c,d\n'))[0]!.malformed).toBe(true);
    expect((await collect('a,"never closed\nb,c\n'))[0]!.malformed).toBe(true);
  });

  it('gives the same records however the input is split, including inside a multi-byte character', async () => {
    const text = 'a,"é€,x"\n"y""",b\n';
    const whole = await collect(text);
    for (const size of [1, 2, 5]) {
      const out = [];
      for await (const r of parseCsvRecords(chunks(text, size))) out.push(r);
      expect(out).toEqual(whole);
    }
  });

  it('ignores a byte order mark', async () => {
    expect((await collect('﻿a,b\n'))[0]!.fields).toEqual(['a', 'b']);
  });
});

describe('parseTimestampMs', () => {
  const t = Date.UTC(2024, 9, 17, 12, 0, 0);
  it.each([
    ['2024-10-17 12:00:00', t],
    ['2024-10-17 12:00:00 UTC', t],
    ['2024-10-17 12:00:00.123', t + 123],
    ['2024-10-17 12:00:00.123456 UTC', t + 123],
    ['2024-10-17 12:00:00.5', t + 500],
    ['2024-10-17T12:00:00', t],
    ['2024-10-17T12:00:00Z', t],
    ['2024-10-17T12:00:00.250Z', t + 250],
    ['2024-10-17T14:00:00+02:00', t],
    ['2024-10-17T07:30:00-04:30', t],
    ['2024-02-29 00:00:00', Date.UTC(2024, 1, 29)],
  ])('reads %s', (text, ms) => {
    expect(parseTimestampMs(text)).toBe(ms);
  });

  it.each([
    [''],
    ['2024-10-17'],
    ['2023-02-29 00:00:00'],
    ['2024-13-01 00:00:00'],
    ['2024-10-17 24:00:00'],
    ['2024-10-17 12:60:00'],
    ['2024-10-17 12:00:60'],
    ['2024-10-17 12:00:00 PST'],
    ['2024-10-17T12:00:00+25:00'],
    ['2024-10-17T12:00:00+0200'],
    ['yesterday'],
    ['1729166400'],
    ['2024-10-17 12:00:00; drop'],
  ])('rejects %j', (text) => {
    expect(parseTimestampMs(text)).toBeNull();
  });
});

describe('readGraduates', () => {
  it('reads the hand-written fixture, including an all-empty optional row', async () => {
    const r = await readGraduatesFile(
      new URL('../sources/fixtures/dune/graduates.csv', import.meta.url).pathname,
    );
    expect(r.bad.count).toBe(0);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({
      mint: A,
      createdAtMs: Date.UTC(2024, 9, 17, 12),
      graduationVenue: 'pumpswap',
      roughPeakUsd: 2578681053.5,
      tradeCount: 2_500_000,
      firstTradeAtMs: Date.UTC(2024, 9, 17, 12, 1),
    });
    expect(r.rows[1]).toMatchObject({
      mint: B,
      createdAtMs: Date.UTC(2024, 10, 3, 8, 30, 0, 123),
      creator: null,
      graduatedAtMs: null,
      roughPeakUsd: null,
      tradeCount: null,
    });
  });

  it('accepts the columns in any order and ignores extra columns', async () => {
    const cols = [...GRADUATE_COLUMNS].reverse();
    const text = `${[...cols, 'extra'].join(',')}\n${cols.map((c) => (c === 'mint' ? A : c === 'created_at' ? '2024-01-02 03:04:05' : '')).join(',')},zzz\n`;
    const r = await readGraduates(chunks(text));
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.mint).toBe(A);
  });

  it('reports bad rows with their line numbers and goes on', async () => {
    const text = [
      HEADER,
      line(), // line 2: good
      line({ mint: 'not a mint' }), // 3
      line({ created_at: '' }), // 4
      line({ created_at: 'soon' }), // 5
      line({ rough_peak_usd: 'NaN' }), // 6
      line({ rough_peak_usd: '1e999' }), // 7
      line({ rough_peak_usd: '-5' }), // 8
      line({ rough_peak_usd: '0x10' }), // 9
      line({ trade_count: '1.5' }), // 10
      line({ trade_count: '-1' }), // 11
      line({ graduation_venue: 'a b; drop' }), // 12
      line({ creator: 'zz' }), // 13
      `${A},2024-01-01 00:00:00,too,few`, // 14
      line() + ',extra', // 15
      `${line()}`.replace(A, `"${A}`), // 16: unterminated quote swallows the rest
    ].join('\n');
    const r = await readGraduates(chunks(text));
    expect(r.rows).toHaveLength(1);
    expect(r.records).toBe(15);
    expect(r.bad.count).toBe(14);
    expect(r.bad.stored.map((b) => b.line)).toEqual([
      3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
    ]);
    const byLine = Object.fromEntries(r.bad.stored.map((b) => [b.line, b.reason]));
    expect(byLine[3]).toMatch(/^mint/);
    expect(byLine[4]).toMatch(/^created_at/);
    expect(byLine[5]).toMatch(/^created_at/);
    expect(byLine[6]).toMatch(/^rough_peak_usd/);
    expect(byLine[7]).toMatch(/^rough_peak_usd/);
    expect(byLine[8]).toMatch(/negative/);
    expect(byLine[9]).toMatch(/^rough_peak_usd/);
    expect(byLine[10]).toMatch(/^trade_count/);
    expect(byLine[11]).toMatch(/^trade_count/);
    expect(byLine[12]).toMatch(/^graduation_venue/);
    expect(byLine[13]).toMatch(/^creator/);
    expect(byLine[14]).toMatch(/expected 11 columns, found 4/);
    expect(byLine[15]).toMatch(/expected 11 columns, found 12/);
    expect(byLine[16]).toMatch(/malformed quoting/);
  });

  it('accepts plain, signed-free decimals and exponent notation for the peak', async () => {
    const text = [
      HEADER,
      line({ mint: A, rough_peak_usd: '1.2E7' }),
      line({ mint: B, rough_peak_usd: '125000' }),
      line({ mint: POOL, rough_peak_usd: '0' }),
    ].join('\n');
    const r = await readGraduates(chunks(text));
    expect(r.rows.map((x) => x.roughPeakUsd)).toEqual([12_000_000, 125_000, 0]);
  });

  it('stores at most 100 reasons but counts every bad row', async () => {
    const bad = Array.from({ length: 250 }, () => line({ mint: 'x' }));
    const r = await readGraduates(chunks([HEADER, ...bad].join('\n'), 64));
    expect(r.bad.count).toBe(250);
    expect(r.bad.stored).toHaveLength(MAX_BAD_ROW_REASONS);
    expect(r.bad.stored[0]!.line).toBe(2);
    expect(r.rows).toHaveLength(0);
  });

  it('streams: a row is delivered before the rest of the input is read', async () => {
    let produced = 0;
    async function* source(): AsyncGenerator<string> {
      yield HEADER + '\n';
      for (let i = 0; i < 1000; i++) {
        produced++;
        yield line({ mint: A }) + '\n';
      }
    }
    let producedAtFirstRow = -1;
    const r = await readGraduates(source(), {
      onRow: () => {
        if (producedAtFirstRow < 0) producedAtFirstRow = produced;
      },
    });
    expect(producedAtFirstRow).toBe(1);
    expect(r.records).toBe(1000);
    expect(r.rows).toEqual([]); // not collected when onRow is given
  });

  it('throws on a bad header or an empty file', async () => {
    await expect(readGraduates(chunks(''))).rejects.toBeInstanceOf(CsvHeaderError);
    await expect(readGraduates(chunks('mint,created_at\n'))).rejects.toThrow(
      /missing columns: creator/,
    );
    await expect(readGraduates(chunks(`${HEADER},mint\n`))).rejects.toThrow(/repeats/);
  });

  it('reads a header-only file as zero rows', async () => {
    const r = await readGraduates(chunks(HEADER + '\n'));
    expect(r).toMatchObject({ rows: [], records: 0 });
  });
});

describe('readGraduatesFiles', () => {
  it('merges files, keeps a repeated mint once and prefixes reasons with the file', async () => {
    const dir = tmpDir();
    const f1 = path.join(dir, 'a.csv');
    const f2 = path.join(dir, 'b.csv');
    fs.writeFileSync(f1, [HEADER, line({ mint: A }), line({ mint: 'bad' })].join('\n'));
    fs.writeFileSync(f2, [HEADER, line({ mint: A }), line({ mint: B })].join('\n'));
    const r = await readGraduatesFiles([f1, f2]);
    expect(r.rows.map((x) => x.mint)).toEqual([A, B]);
    expect(r.duplicates).toBe(1);
    expect(r.records).toBe(4);
    expect(r.bad.count).toBe(1);
    expect(r.bad.stored[0]!.reason.startsWith(f1)).toBe(true);
  });
});
