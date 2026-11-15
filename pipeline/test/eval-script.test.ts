import { execFile } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../scripts/eval.ts', import.meta.url));
const TSX = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url));
const FIXTURES = fileURLToPath(new URL('./fixtures/eval/', import.meta.url));
const env = { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' };

async function script(args: string[]) {
  try {
    const r = await run(TSX, [SCRIPT, ...args], { env, timeout: 60_000 });
    return { code: 0, out: r.stdout, err: r.stderr };
  } catch (e) {
    const x = e as { code: number; stdout: string; stderr: string };
    return { code: x.code, out: x.stdout, err: x.stderr };
  }
}

let dir: string;
const p = (name: string) => join(dir, name);
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'eval-script-'));
  for (const f of ['labels.csv', 'results.jsonl', 'split.json']) copyFileSync(FIXTURES + f, p(f));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const common = () => ['--labels', p('labels.csv'), '--split-file', p('split.json')];

describe('eval script: score', () => {
  it('scores the tune split in one command and writes the JSON and the disagreements', async () => {
    const r = await script([
      'score',
      ...common(),
      '--results',
      p('results.jsonl'),
      '--json',
      p('out.json'),
    ]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Split: tune, 8 labelled coins');
    expect(r.out).toContain('overall: 4/8 = 50.0% (95% interval 21.5% to 78.5%)');
    expect(r.out).toContain('X99');
    const json = JSON.parse(readFileSync(p('out.json'), 'utf8')) as Record<string, unknown>;
    expect(json['labelled']).toBe(8);
    expect(json['correct']).toBe(4);
    const csv = readFileSync(p('results.jsonl.disagreements.csv'), 'utf8');
    expect(csv.split('\n')[0]).toBe('mint,ticker,label,prediction,confidence,reason');
    expect(csv).toContain('M03,CCC,animal,culture_meme,0.6,frog meme');
    expect(csv).toContain('M12,LLL,derivative,(failed)');
    expect(csv).not.toContain('M07');
  });

  it('does not name held-out coins unless --show-holdout is given', async () => {
    const hidden = await script([
      'score',
      ...common(),
      '--results',
      p('results.jsonl'),
      '--split',
      'holdout',
    ]);
    expect(hidden.code).toBe(0);
    expect(hidden.out).toContain('overall: 3/4 = 75.0%');
    expect(hidden.out).toContain('1 held-out disagreement(s) are not listed');
    for (const secret of ['M07', 'GGG', 'politician name']) {
      expect(hidden.out).not.toContain(secret);
      expect(readFileSync(p('results.jsonl.disagreements.csv'), 'utf8')).not.toContain(secret);
    }
    const shown = await script([
      'score',
      ...common(),
      '--results',
      p('results.jsonl'),
      '--split',
      'holdout',
      '--show-holdout',
    ]);
    expect(readFileSync(p('results.jsonl.disagreements.csv'), 'utf8')).toContain('M07,GGG');
    expect(shown.out).not.toContain('are not listed');
  });

  it('--split all scores everything but still withholds the holdout coins', async () => {
    const r = await script([
      'score',
      ...common(),
      '--results',
      p('results.jsonl'),
      '--split',
      'all',
    ]);
    expect(r.out).toContain('overall: 7/12 = 58.3% (95% interval 32.0% to 80.7%)');
    expect(r.out).not.toContain('M07');
  });

  it('exits 2 and scores nothing when the labels have a problem', async () => {
    writeFileSync(
      p('bad.csv'),
      'mint,ticker,primary_narrative,secondary_narratives,parent_mint,confidence,notes\nA,T,nope,,,0.5,\n',
    );
    const r = await script([
      'score',
      '--labels',
      p('bad.csv'),
      '--split',
      'all',
      '--results',
      p('results.jsonl'),
    ]);
    expect(r.code).toBe(2);
    expect(r.err).toContain('bad.csv:2: unknown primary narrative "nope"');
    expect(r.out).toBe('');
  });

  it('needs a split file for tune and holdout, and a results file', async () => {
    const r = await script([
      'score',
      '--labels',
      p('labels.csv'),
      '--split-file',
      p('none.json'),
      '--results',
      p('results.jsonl'),
    ]);
    expect(r.code).toBe(2);
    expect(r.err).toContain('no split file');
    expect((await script(['score'])).err).toContain('--results');
  });
});

describe('eval script: make-split and research', () => {
  it('creates the split once and refuses to overwrite it', async () => {
    const target = p('new-split.json');
    const first = await script([
      'make-split',
      '--labels',
      p('labels.csv'),
      '--split-file',
      target,
      '--seed',
      '5',
      '--tune',
      '6',
      '--holdout',
      '4',
    ]);
    expect(first.code).toBe(0);
    expect(first.out).toContain('6 tune, 4 holdout, seed 5');
    const before = readFileSync(target, 'utf8');
    const split = JSON.parse(before) as { seed: number; created_at: string };
    expect(split.seed).toBe(5);
    expect(Number.isNaN(Date.parse(split.created_at))).toBe(false);
    const second = await script([
      'make-split',
      '--labels',
      p('labels.csv'),
      '--split-file',
      target,
      '--seed',
      '6',
      '--tune',
      '6',
      '--holdout',
      '4',
    ]);
    expect(second.code).toBe(2);
    expect(second.err).toContain('already exists');
    expect(readFileSync(target, 'utf8')).toBe(before);
  });

  it('needs a seed', async () => {
    const r = await script([
      'make-split',
      '--labels',
      p('labels.csv'),
      '--split-file',
      p('s2.json'),
    ]);
    expect(r.code).toBe(2);
    expect(existsSync(p('s2.json'))).toBe(false);
  });

  it('research: lists what it loaded and rejected', async () => {
    const rd = mkdtempSync(join(tmpdir(), 'eval-research-'));
    try {
      copyFileSync(FIXTURES + 'research-excerpt.json', join(rd, 'batch-7.json'));
      const ok = await script(['research', rd]);
      expect(ok.code).toBe(0);
      expect(ok.out).toContain('2 entries loaded');
      expect(ok.out).toContain('0 rejected');
      writeFileSync(join(rd, 'batch-8.json'), '[{"mint":"q"}]');
      const bad = await script(['research', rd]);
      expect(bad.code).toBe(1);
      expect(bad.out).toContain('rejected batch-8.json entry 0 (q)');
    } finally {
      rmSync(rd, { recursive: true, force: true });
    }
  });
});
