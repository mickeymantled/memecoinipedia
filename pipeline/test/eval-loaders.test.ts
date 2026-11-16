import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  allocate,
  checkSplit,
  createSplit,
  loadResearchDir,
  parseCsv,
  parseLabels,
  parseResearchBatch,
  parseResults,
  parseSplit,
  toSlug,
  writeSplitFile,
  type Label,
} from '../src/eval/index.js';
import { buildRecord } from '../src/classify/input.js';

const fx = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/eval/${name}`, import.meta.url)), 'utf8');

const HEADER = 'mint,ticker,primary_narrative,secondary_narratives,parent_mint,confidence,notes\n';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'eval-'));
  dirs.push(d);
  return d;
};

describe('toSlug', () => {
  it('takes labels and slugs, any case', () => {
    expect(toSlug('culture/meme')).toBe('culture_meme');
    expect(toSlug('culture_meme')).toBe('culture_meme');
    expect(toSlug('News Event')).toBe('news_event');
    expect(toSlug(' AI ')).toBe('ai');
    expect(toSlug('ai')).toBe('ai');
    expect(toSlug('memes')).toBeNull();
    expect(toSlug('')).toBeNull();
  });
});

describe('parseCsv', () => {
  it('handles quotes, commas, newlines in fields, CRLF, a BOM and blank lines', () => {
    const r = parseCsv('﻿a,b\r\n"x, y","line1\nline2"\r\n\r\nc,"he said ""hi"""\n');
    expect(r.unterminatedAt).toBeNull();
    expect(r.records).toEqual([
      { line: 1, fields: ['a', 'b'] },
      { line: 2, fields: ['x, y', 'line1\nline2'] },
      { line: 5, fields: ['c', 'he said "hi"'] },
    ]);
  });

  it('reports an unterminated quote at its line', () => {
    expect(parseCsv('a,b\n1,"oops\n2,3\n').unterminatedAt).toBe(2);
  });
});

describe('parseLabels', () => {
  it('reads the fixture: labels and slugs, ; | and JSON secondaries', () => {
    const { labels, problems } = parseLabels(fx('labels.csv'));
    expect(problems).toEqual([]);
    expect(labels).toHaveLength(12);
    const by = Object.fromEntries(labels.map((l) => [l.mint, l]));
    expect(by['M02']!.primary).toBe('animal');
    expect(by['M02']!.secondaries).toEqual(['culture_meme']);
    expect(by['M04']).toMatchObject({ primary: 'ai', secondaries: ['tech'] });
    expect(by['M06']!.secondaries).toEqual(['political', 'news_event']);
    expect(by['M08']!.primary).toBe('culture_meme');
    expect(by['M09']!.secondaries).toEqual(['news_event']);
    expect(by['M03']).toMatchObject({ parentMint: 'P2', notes: 'a note, with a comma', line: 4 });
    expect(by['M01']!.parentMint).toBeNull();
  });

  it('reports every problem with its line number', () => {
    const text =
      HEADER +
      'A1,T,AI,,,0.5,\n' + // line 2 fine
      'A2,T,memecoin,,,0.5,\n' + // 3 unknown primary
      'A1,T,animal,,,0.5,\n' + // 4 duplicate of line 2
      'A4,T,animal,ai;tech;gaming;other,,0.5,\n' + // 5 four secondaries
      'A5,T,animal,animal,,0.5,\n' + // 6 secondary equals primary
      'A6,T,animal,,,1.5,\n' + // 7 confidence high
      'A7,T,animal,,,-0.1,\n' + // 8 confidence low
      'A8,T,animal,nonsense,,0.5,\n' + // 9 unknown secondary
      'A9,T,animal,"[""ai"",""ai""]",,0.5,\n' + // 10 repeated secondary
      'A10,T,animal,,,abc,\n' + // 11 not a number
      'A11,T,animal\n'; // 12 too few fields
    const { labels, problems } = parseLabels(text);
    expect(labels.map((l) => l.mint)).toEqual(['A1']);
    expect(problems.map((p) => [p.line, p.message])).toEqual([
      [3, 'unknown primary narrative "memecoin"'],
      [4, 'duplicate mint A1 (first on line 2)'],
      [5, '4 secondary narratives (at most 3)'],
      [6, 'secondary narrative "animal" equals the primary'],
      [7, 'confidence "1.5" is not a number from 0 to 1'],
      [8, 'confidence "-0.1" is not a number from 0 to 1'],
      [9, 'unknown secondary narrative "nonsense"'],
      [10, 'secondary narrative "ai" is repeated'],
      [11, 'confidence "abc" is not a number from 0 to 1'],
      [12, 'expected 7 fields, found 3'],
    ]);
  });

  it('accepts confidence 0 and 1 and an empty one', () => {
    const { labels, problems } = parseLabels(HEADER + 'a,T,AI,,,0,\nb,T,AI,,,1,\nc,T,AI,,,,\n');
    expect(problems).toEqual([]);
    expect(labels.map((l) => l.confidence)).toEqual([0, 1, null]);
  });

  it('counts lines inside a quoted multi-line note', () => {
    const { problems } = parseLabels(HEADER + 'a,T,AI,,,0.5,"two\nlines"\nb,T,nope,,,0.5,\n');
    expect(problems).toEqual([{ line: 4, message: 'unknown primary narrative "nope"' }]);
  });

  it('reports a missing column and an empty file', () => {
    expect(parseLabels('mint,ticker\na,b\n').problems[0]!.message).toContain('header lacks');
    expect(parseLabels('').problems).toEqual([{ line: 1, message: 'no header row' }]);
  });
});

describe('parseResults', () => {
  it('reads what file mode writes, results and failures', () => {
    const r = parseResults(fx('results.jsonl'));
    expect(r.problems).toEqual([]);
    expect(r.byMint.size).toBe(12 - 1 + 1); // 12 lines: 10 labelled results, M12, X99
    expect(r.byMint.get('M12')).toEqual({
      kind: 'failed',
      mint: 'M12',
      error: 'schema validation failed: reason: too long',
    });
    expect(r.byMint.get('M05')).toMatchObject({ kind: 'ok', primary: 'tech', confidence: 0.75 });
  });

  it('reports bad lines and repeated mints with line numbers', () => {
    const r = parseResults(
      [
        '{"mint":"a","primary_narrative":"ai","secondary_narratives":[],"confidence":0.5,"reason":"r","parent_address":null}',
        'not json',
        '{"mint":"b","primary_narrative":"ai"}',
        '{"mint":"c","primary_narrative":"ai","secondary_narratives":[],"confidence":2,"reason":"r","parent_address":null}',
        '{"mint":"a","error":"x"}',
        '',
      ].join('\n'),
    );
    expect(r.byMint.size).toBe(1);
    expect(r.problems.map((p) => p.line)).toEqual([2, 3, 4, 5]);
    expect(r.problems[3]!.message).toContain('appears again (first on line 1)');
  });
});

describe('split', () => {
  const mk = (n: number, narrative: string, from = 0): Label[] =>
    Array.from({ length: n }, (_, i) => ({
      line: 0,
      mint: `${narrative}${from + i}`,
      ticker: '',
      primary: narrative,
      secondaries: [],
      parentMint: null,
      confidence: null,
      notes: '',
    }));
  const labels = [
    ...mk(100, 'animal'),
    ...mk(60, 'ai'),
    ...mk(30, 'political'),
    ...mk(10, 'gaming'),
  ];

  it('allocates by largest remainder and never over-fills a group', () => {
    expect(allocate([100, 60, 30, 10], 80)).toEqual([40, 24, 12, 4]);
    expect(allocate([1, 1, 1], 2)).toEqual([1, 1, 0]);
    expect(allocate([5, 1], 6)).toEqual([5, 1]);
    expect(() => allocate([1], 2)).toThrow();
  });

  it('is stratified, sized 120 and 80, disjoint, and the same for the same seed', () => {
    const o = { tune: 120, holdout: 80, seed: 42, createdAt: '2026-11-15T00:00:00.000Z' };
    const s = createSplit(labels, o);
    expect(s.tune).toHaveLength(120);
    expect(s.holdout).toHaveLength(80);
    expect(new Set([...s.tune, ...s.holdout]).size).toBe(200);
    const heldOut = (slug: string) => s.holdout.filter((m) => m.startsWith(slug)).length;
    expect([heldOut('animal'), heldOut('ai'), heldOut('political'), heldOut('gaming')]).toEqual([
      40, 24, 12, 4,
    ]);
    expect(s.seed).toBe(42);
    expect(s.created_at).toBe(o.createdAt);
    expect(createSplit(labels, o)).toEqual(s);
    expect(createSplit(labels, { ...o, seed: 43 }).holdout).not.toEqual(s.holdout);
    expect(parseSplit(JSON.stringify(s))).toEqual(s);
  });

  it('takes a stratified subset when there are more labels than tune + holdout', () => {
    const s = createSplit(labels, { tune: 30, holdout: 20, seed: 1, createdAt: 'x' });
    expect(s.tune.length + s.holdout.length).toBe(50);
    expect(s.holdout.filter((m) => m.startsWith('animal'))).toHaveLength(10);
  });

  it('refuses sizes the labels cannot fill', () => {
    expect(() => createSplit(labels, { tune: 151, holdout: 50, seed: 1, createdAt: 'x' })).toThrow(
      'needs 201 labelled coins, the labels have 200',
    );
  });

  it('rejects a split file with an overlap, and flags mints without a label', () => {
    expect(() => parseSplit('{"seed":1,"created_at":"x","tune":["a"],"holdout":["a"]}')).toThrow(
      /more than once/,
    );
    expect(() => parseSplit('nope')).toThrow(/not valid JSON/);
    const s = parseSplit('{"seed":1,"created_at":"x","tune":["a"],"holdout":["zzz"]}');
    expect(checkSplit(s, [{ ...mk(1, 'x')[0]!, mint: 'a' }])).toEqual([
      { line: 0, message: 'split lists zzz, which has no label' },
    ]);
  });

  it('writes once and refuses to overwrite', async () => {
    const path = join(tmp(), 'sub', 'split.json');
    const s = createSplit(labels, { tune: 10, holdout: 5, seed: 3, createdAt: 'x' });
    await writeSplitFile(path, s);
    expect(parseSplit(readFileSync(path, 'utf8'))).toEqual(s);
    const before = readFileSync(path, 'utf8');
    await expect(writeSplitFile(path, { ...s, seed: 4 })).rejects.toThrow(/already exists/);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });
});

describe('research loader', () => {
  it('loads real pilot entries into the classifier research slot', () => {
    const load = parseResearchBatch(fx('research-excerpt.json'), 'batch-7.json');
    expect(load.problems).toEqual([]);
    expect([...load.byMint.keys()]).toEqual([
      '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump',
      '2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump',
    ]);
    const fart = load.byMint.get('9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump')!;
    // Empty origin_date is dropped; Grok's answer (primary, parent, sources) is not in the slot.
    expect(Object.keys(fart).sort()).toEqual([
      'confidence',
      'key_accounts',
      'notes',
      'origin',
      'trigger_event',
    ]);
    expect(fart.confidence).toBe(0.8);
    expect(load.byMint.get('2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump')!.origin_date).toBe(
      '2024-10-30',
    );
    // The classifier's own input builder accepts it as is.
    const rec = buildRecord({
      chain: 'solana',
      address: 'x',
      name: null,
      ticker: null,
      description: null,
      socials: {},
      launched_at: null,
      graduated_at: null,
      ath_market_cap_usd: null,
      ath_at: null,
      seconds_to_ath: null,
      status: 'x',
      research: fart,
    });
    expect(rec['research']).toMatchObject({ confidence: 0.8 });
  });

  const good = JSON.parse(fx('research-excerpt.json'))[0] as Record<string, unknown>;
  const entry = (patch: Record<string, unknown>, mint = 'm1') => ({ ...good, mint, ...patch });

  it('rejects bad entries one by one and keeps the rest', () => {
    const batch = [
      entry({}, 'ok1'),
      entry({ primary_narrative: 'memes' }, 'bad-primary'),
      entry({ secondary_narratives: ['animal', 'animal-ish'] }, 'bad-secondary'),
      entry({ secondary_narratives: ['AI'] }, 'secondary-is-primary'),
      entry({ confidence: 1.5 }, 'bad-confidence'),
      entry({ sources: 'http://x' }, 'bad-sources'),
      entry({ extra: 1 }, 'extra-key'),
      { ...good, mint: undefined },
      entry({}, 'ok1'),
      'not an object',
    ];
    const load = parseResearchBatch(JSON.stringify(batch), 'batch-9.json');
    expect([...load.byMint.keys()]).toEqual(['ok1']);
    expect(load.problems.map((p) => [p.index, p.mint])).toEqual([
      [1, 'bad-primary'],
      [2, 'bad-secondary'],
      [3, 'secondary-is-primary'],
      [4, 'bad-confidence'],
      [5, 'bad-sources'],
      [6, 'extra-key'],
      [7, null],
      [8, 'ok1'],
      [9, null],
    ]);
    expect(load.problems[0]!.message).toBe('unknown primary narrative "memes"');
    expect(load.problems[6]!.message).toContain('mint');
    expect(load.problems[7]!.message).toContain('already loaded');
  });

  it('reports a file that is not a JSON array', () => {
    expect(parseResearchBatch('{', 'a.json').problems[0]!.message).toBe('not valid JSON');
    expect(parseResearchBatch('{}', 'a.json').problems[0]!.message).toContain('JSON array');
  });

  it('loads batch-*.json from a directory, in name order, and ignores other files', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'batch-7.json'), fx('research-excerpt.json'));
    writeFileSync(join(dir, 'batch-8.json'), JSON.stringify([entry({}, 'z1'), entry({}, 'z1')]));
    writeFileSync(join(dir, 'notes.json'), 'ignored');
    const load = await loadResearchDir(dir);
    expect(load.byMint.size).toBe(3);
    expect(load.problems).toHaveLength(1);
    expect(load.problems[0]).toMatchObject({ file: 'batch-8.json', index: 1, mint: 'z1' });
  });
});
