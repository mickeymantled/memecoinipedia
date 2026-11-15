import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CsvHeaderError,
  GRADUATE_COLUMNS,
  MAX_BAD_ROW_REASONS,
  parseCsvRecords,
  readGraduates,
  readGraduatesFile,
  readGraduatesFiles,
} from '../../src/discovery/index.js';

const HEADER = GRADUATE_COLUMNS.join(',');
const A = 'DtgDZb83TqywcuBuWE89jx4k5Y7b6nQ4GYJq3Wd61JQQ';
const B = 'B13ZCbbvAR8f8uF4rv627CYKfLzub6tzHusynAMsVTuE';
const C = '2YiCXUoCvJVhSSk1USLcW8o5RioKzLsz3RCWPa9Vpump';
const CREATOR = '9JRuyRU2wbe9CVHobQ54Yvcaxjzsy3wtpd89snn63a2D';

/** A row with the 9 columns in header order; `over` replaces fields by column name. */
function line(over: Partial<Record<(typeof GRADUATE_COLUMNS)[number], string>> = {}): string {
  const base: Record<string, string> = {
    mint: A,
    created_at: '1710511110',
    creator: '',
    graduated_at: '1710535885',
    hours: '',
    peak_max_usd: '',
    peak_p999_usd: '',
    peak_at: '',
    last_hour: '',
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

describe('readGraduates', () => {
  it('reads the live-format fixture: exponent-form whole numbers, and a coin with no prices', async () => {
    const r = await readGraduatesFile(
      new URL('../sources/fixtures/dune/discovery-page.csv', import.meta.url).pathname,
    );
    expect(r.bad.count).toBe(0);
    expect(r.rows).toHaveLength(3);
    expect(r.rows[0]).toEqual({
      mint: A,
      createdAtMs: 1_710_511_110_000,
      creator: CREATOR,
      graduatedAtMs: 1_710_535_885_000,
      hours: 6453,
      peakMaxUsd: 2_842_978,
      peakP999Usd: 2_423_294,
      peakAtMs: 1_711_926_000_000,
      lastHourMs: 1_793_145_600_000,
      roughPeakUsd: 2_423_294,
    });
    expect(r.rows[1]).toMatchObject({ mint: B, hours: 360, roughPeakUsd: 275_398 });
    expect(r.rows[2]).toMatchObject({
      mint: C,
      hours: 0,
      peakMaxUsd: null,
      peakP999Usd: null,
      roughPeakUsd: null,
      peakAtMs: null,
      lastHourMs: null,
    });
  });

  it('parses exponent-form numbers exactly and as whole numbers', async () => {
    const text = [
      HEADER,
      line({ created_at: '1.71051111e+09', graduated_at: '1.710535885E+9', hours: '6.453e+03' }),
    ].join('\n');
    const r = await readGraduates(chunks(text));
    expect(r.rows[0]).toMatchObject({
      createdAtMs: 1_710_511_110_000,
      graduatedAtMs: 1_710_535_885_000,
      hours: 6453,
    });
  });

  it('needs only mint, created_at and graduated_at in the header, in any order', async () => {
    const text = `graduated_at,peak_p999_usd,mint,created_at\n1710535885,150000,${A},1710511110\n`;
    const r = await readGraduates(chunks(text));
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({
      mint: A,
      roughPeakUsd: 150_000,
      hours: null,
      creator: null,
    });
  });

  it('ignores extra columns', async () => {
    const r = await readGraduates(chunks(`${HEADER},extra\n${line()},zzz\n`));
    expect(r.rows).toHaveLength(1);
  });

  it('rejects a row without created_at or graduated_at, with the line number, and goes on', async () => {
    const text = [
      HEADER,
      line(), // line 2: good
      line({ created_at: '' }), // 3
      line({ graduated_at: '' }), // 4
      line({ mint: 'not a mint' }), // 5
      line({ mint: B }), // 6: good
    ].join('\n');
    const r = await readGraduates(chunks(text));
    expect(r.rows.map((x) => x.mint)).toEqual([A, B]);
    expect(r.records).toBe(5);
    expect(r.bad.stored.map((b) => [b.line, b.reason.split(':')[0]])).toEqual([
      [3, 'created_at'],
      [4, 'graduated_at'],
      [5, 'mint'],
    ]);
  });

  it('rejects values that are not strict numbers or not whole where a whole number is needed', async () => {
    const text = [
      HEADER,
      line({ created_at: '1710511110.5' }), // 2: not whole
      line({ created_at: 'soon' }), // 3
      line({ created_at: '0' }), // 4
      line({ created_at: '1e12' }), // 5: not epoch seconds
      line({ created_at: '2024-03-15 12:00:00' }), // 6: not seconds
      line({ hours: '1.5' }), // 7
      line({ hours: '-1' }), // 8
      line({ hours: 'NaN' }), // 9
      line({ peak_p999_usd: 'Infinity' }), // 10
      line({ peak_p999_usd: '1e999' }), // 11
      line({ peak_p999_usd: '-5' }), // 12
      line({ peak_max_usd: '0x10' }), // 13
      line({ peak_at: '1710511110.25' }), // 14
      line({ last_hour: 'x' }), // 15
      line({ creator: 'zz' }), // 16
    ].join('\n');
    const r = await readGraduates(chunks(text));
    expect(r.rows).toHaveLength(0);
    expect(r.bad.count).toBe(15);
    const byLine = Object.fromEntries(r.bad.stored.map((b) => [b.line, b.reason.split(':')[0]]));
    expect(byLine).toEqual({
      2: 'created_at',
      3: 'created_at',
      4: 'created_at',
      5: 'created_at',
      6: 'created_at',
      7: 'hours',
      8: 'hours',
      9: 'hours',
      10: 'peak_p999_usd',
      11: 'peak_p999_usd',
      12: 'peak_p999_usd',
      13: 'peak_max_usd',
      14: 'peak_at',
      15: 'last_hour',
      16: 'creator',
    });
  });

  it('rejects a row with the wrong column count and a row with bad quoting', async () => {
    const text = [
      HEADER,
      `${A},1710511110,too,few`,
      line() + ',extra',
      line().replace(A, `"${A}`),
    ].join('\n');
    const r = await readGraduates(chunks(text));
    expect(r.rows).toHaveLength(0);
    const byLine = Object.fromEntries(r.bad.stored.map((b) => [b.line, b.reason]));
    expect(byLine[2]).toMatch(/expected 9 columns, found 4/);
    expect(byLine[3]).toMatch(/expected 9 columns, found 10/);
    expect(byLine[4]).toMatch(/malformed quoting/);
  });

  it('sets roughPeakUsd to peak_p999_usd, not to the maximum', async () => {
    const r = await readGraduates(
      chunks([HEADER, line({ peak_max_usd: '9e+09', peak_p999_usd: '120000' })].join('\n')),
    );
    expect(r.rows[0]).toMatchObject({
      peakMaxUsd: 9e9,
      peakP999Usd: 120_000,
      roughPeakUsd: 120_000,
    });
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
      /missing columns: graduated_at/,
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
