import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  csvLine,
  disagreementsCsv,
  formatReport,
  mintsFor,
  parseLabels,
  parseResults,
  parseSplit,
  proportion,
  redact,
  reportJson,
  score,
} from '../src/eval/index.js';

const fx = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/eval/${name}`, import.meta.url)), 'utf8');

/*
 * The fixture, worked by hand (test/fixtures/eval). Twelve labelled coins; the results file has
 * ten results, one failure (M12), no line for M11, and one coin that is not labelled (X99).
 *
 *   coin  label         prediction    conf   hit
 *   M01   animal        animal        0.90   yes
 *   M02   animal        animal        0.88   yes
 *   M03   animal        culture_meme  0.60   no   (secondaries: animal)
 *   M04   ai            ai            0.95   yes
 *   M05   ai            tech          0.75   no   (secondaries: ai)
 *   M06   celebrity     celebrity     0.70   yes  (exactly on the 0.7 edge: upper band)
 *   M07   celebrity     political     0.45   no
 *   M08   culture_meme  culture_meme  0.80   yes
 *   M09   political     political     0.85   yes  (exactly on the 0.85 edge: top band)
 *   M10   gaming        gaming        0.50   yes  (exactly on the 0.5 edge: second band)
 *   M11   utility       (missing)
 *   M12   derivative    (failed)
 *
 * Correct: M01 M02 M04 M06 M08 M09 M10 = 7 of 12. Wilson 95% for 7/12 (z = 1.96):
 *   centre = (7/12 + 1.96^2/24) / (1 + 1.96^2/12) = 0.74340 / 1.32013 = 0.56312
 *   half   = 1.96 * sqrt(0.58333*0.41667/12 + 1.96^2/576) / 1.32013 = 0.32161 / 1.32013 = 0.24362
 *   interval 0.3195 to 0.8067.
 * Bands (10 classified coins): below 0.5: M07 (1 coin, 0 right); 0.5 to 0.7: M03 M10 (2, 1);
 *   0.7 to 0.85: M05 M06 M08 (3, 2); 0.85 up: M01 M02 M04 M09 (4, 4). Shares 10 20 30 40%.
 * Cut at 0.7: below = M07 M03 M10, 3 coins, 1 right; at or above = 7 coins, 6 right.
 * Secondaries: label's primary is the model's primary for 7; only among secondaries for M03 and
 *   M05 (2); not found for M07, M11, M12. Either: 9 of 12.
 * Parent: labels with a parent: M03 (P2) M08 (P4) M10 (P6) M12 (P1) = 4. Results naming a parent:
 *   M03 P2, M05 P3, M08 P5, M09 P7, M10 P6 = 5. Right: M03, M10 = 2. Precision 2/5, recall 2/4.
 */
const labels = parseLabels(fx('labels.csv')).labels;
const results = parseResults(fx('results.jsonl'));
const split = parseSplit(fx('split.json'));

describe('proportion (Wilson interval)', () => {
  it('matches the textbook values', () => {
    const p = proportion(7, 12);
    expect(p.value).toBeCloseTo(0.5833, 4);
    expect(p.low).toBeCloseTo(0.3195, 3);
    expect(p.high).toBeCloseTo(0.8067, 3);
    const half = proportion(4, 8);
    expect(half.low).toBeCloseTo(0.215, 3);
    expect(half.high).toBeCloseTo(0.785, 3);
    const three = proportion(3, 4);
    expect(three.low).toBeCloseTo(0.3006, 3);
    expect(three.high).toBeCloseTo(0.9544, 3);
  });

  it('keeps 0/n and n/n inside 0 to 1, and 0/0 is empty', () => {
    const none = proportion(0, 10);
    expect(none.low).toBe(0);
    expect(none.high).toBeCloseTo(0.2775, 3);
    const all = proportion(10, 10);
    expect(all.high).toBe(1);
    expect(all.low).toBeCloseTo(0.7225, 3);
    expect(proportion(0, 0)).toEqual({ k: 0, n: 0, value: null, low: null, high: null });
  });
});

describe('score: whole fixture', () => {
  const s = score({ labels, results, scope: null });

  it('headline number counts failed and missing coins as wrong', () => {
    expect(s.total).toBe(12);
    expect(s.correct).toBe(7);
    expect(s.failed).toBe(1);
    expect(s.missing).toBe(1);
    expect(s.accuracy.value).toBeCloseTo(7 / 12, 10);
    expect(s.accuracy.low).toBeCloseTo(0.3195, 3);
    expect(s.accuracy.high).toBeCloseTo(0.8067, 3);
  });

  it('lists a missing coin and an unlabelled coin without changing the denominator', () => {
    expect(s.missingMints).toEqual(['M11']);
    expect(s.unlabelled).toEqual(['X99']);
    expect(s.total).toBe(12);
    // Dropping the unlabelled line changes nothing in any number.
    const without = parseResults(fx('results.jsonl').split('\n').slice(0, -2).join('\n'));
    const s2 = score({ labels, results: without, scope: null });
    expect(s2.unlabelled).toEqual([]);
    expect(s2.accuracy).toEqual(s.accuracy);
    expect(s2.bands).toEqual(s.bands);
  });

  it('per narrative accuracy', () => {
    const got = Object.fromEntries(
      s.perNarrative.map((p) => [p.slug, [p.accuracy.k, p.accuracy.n]]),
    );
    expect(got).toEqual({
      ai: [1, 2],
      animal: [2, 3],
      celebrity: [1, 2],
      political: [1, 1],
      culture_meme: [1, 1],
      gaming: [1, 1],
      derivative: [0, 1],
      utility: [0, 1],
    });
  });

  it('confusion table: rows are labels, columns are predictions, failed and missing are columns', () => {
    expect(s.confusion.columns).toEqual([
      'ai',
      'tech',
      'animal',
      'celebrity',
      'political',
      'culture_meme',
      'gaming',
      '(failed)',
      '(missing)',
    ]);
    const rows = Object.fromEntries(s.confusion.rows.map((r) => [r.label, r.counts]));
    expect(rows).toEqual({
      ai: { ai: 1, tech: 1 },
      animal: { animal: 2, culture_meme: 1 },
      celebrity: { celebrity: 1, political: 1 },
      political: { political: 1 },
      culture_meme: { culture_meme: 1 },
      gaming: { gaming: 1 },
      derivative: { '(failed)': 1 },
      utility: { '(missing)': 1 },
    });
    const cells = s.confusion.rows.flatMap((r) => Object.values(r.counts));
    expect(cells.reduce((a, b) => a + b, 0)).toBe(12);
  });

  it('confidence bands, with edges 0.5, 0.7 and 0.85 in the upper band', () => {
    expect(s.bands.classified).toBe(10);
    expect(s.bands.rows.map((b) => [b.name, b.n, b.accuracy.k, b.share])).toEqual([
      ['below 0.5', 1, 0, 0.1],
      ['0.5 to below 0.7', 2, 1, 0.2],
      ['0.7 to below 0.85', 3, 2, 0.3],
      ['0.85 and above', 4, 4, 0.4],
    ]);
    expect([s.bands.below07.k, s.bands.below07.n]).toEqual([1, 3]);
    expect([s.bands.atLeast07.k, s.bands.atLeast07.n]).toEqual([6, 7]);
  });

  it('secondaries', () => {
    expect(s.secondaries.asPrimary).toBe(7);
    expect(s.secondaries.asSecondaryOnly).toBe(2);
    expect([s.secondaries.anywhere.k, s.secondaries.anywhere.n]).toEqual([9, 12]);
  });

  it('parent precision and recall', () => {
    expect(s.parent).toMatchObject({ actual: 4, predicted: 5, truePositives: 2 });
    expect(s.parent.precision.value).toBeCloseTo(0.4, 10);
    expect(s.parent.recall.value).toBeCloseTo(0.5, 10);
  });

  it('disagreements carry mint, ticker, label, prediction, confidence and reason', () => {
    expect(s.disagreements).toEqual([
      {
        mint: 'M03',
        ticker: 'CCC',
        label: 'animal',
        prediction: 'culture_meme',
        confidence: 0.6,
        reason: 'frog meme',
        kind: 'wrong',
      },
      {
        mint: 'M05',
        ticker: 'EEE',
        label: 'ai',
        prediction: 'tech',
        confidence: 0.75,
        reason: 'infra project',
        kind: 'wrong',
      },
      {
        mint: 'M07',
        ticker: 'GGG',
        label: 'celebrity',
        prediction: 'political',
        confidence: 0.45,
        reason: 'politician name',
        kind: 'wrong',
      },
      {
        mint: 'M11',
        ticker: 'KKK',
        label: 'utility',
        prediction: '(missing)',
        confidence: null,
        reason: 'no line for this coin in the results file',
        kind: 'missing',
      },
      {
        mint: 'M12',
        ticker: 'LLL',
        label: 'derivative',
        prediction: '(failed)',
        confidence: null,
        reason: 'schema validation failed: reason: too long',
        kind: 'failed',
      },
    ]);
  });
});

describe('score: splits', () => {
  it('tune: 4 of 8, the other side of the split is not scored or called unlabelled', () => {
    const s = score({ labels, results, scope: mintsFor(split, 'tune') });
    expect([s.total, s.correct, s.failed, s.missing]).toEqual([8, 4, 1, 1]);
    expect(s.accuracy.low).toBeCloseTo(0.215, 3);
    expect(s.accuracy.high).toBeCloseTo(0.785, 3);
    expect(s.outOfScope).toBe(4);
    expect(s.unlabelled).toEqual(['X99']);
    expect(s.bands.rows.map((b) => b.n)).toEqual([0, 1, 2, 3]);
  });

  it('holdout: 3 of 4, and a holdout coin missing from the results is still wrong', () => {
    const s = score({ labels, results, scope: mintsFor(split, 'holdout') });
    expect([s.total, s.correct]).toEqual([4, 3]);
    expect(s.accuracy.low).toBeCloseTo(0.3006, 3);
    const fewer = parseResults(
      fx('results.jsonl')
        .split('\n')
        .filter((l) => !l.includes('"M10"'))
        .join('\n'),
    );
    const s2 = score({ labels, results: fewer, scope: mintsFor(split, 'holdout') });
    expect([s2.total, s2.correct, s2.missing]).toEqual([4, 2, 1]);
  });

  it('an empty scope gives no accuracy rather than NaN', () => {
    const s = score({ labels, results, scope: new Set() });
    expect(s.total).toBe(0);
    expect(s.accuracy.value).toBeNull();
    expect(s.bands.rows.every((b) => b.share === null)).toBe(true);
  });
});

describe('held-out coins are not listed unless asked', () => {
  const all = score({ labels, results, scope: null });
  const meta = {
    split: 'all' as const,
    splitFile: split,
    labelsPath: 'labels.csv',
    resultsPath: 'results.jsonl',
    showHoldout: false,
  };

  it('redact removes holdout mints from the per-coin lists and counts them', () => {
    const r = redact(all, new Set(split.holdout));
    expect(r.disagreements.map((d) => d.mint)).toEqual(['M03', 'M05', 'M11', 'M12']);
    expect(r.withheld).toEqual({ disagreements: 1, missing: 0 });
    // Totals still include them.
    expect(all.total).toBe(12);
  });

  it('the report and the disagreements file never mention a withheld coin', () => {
    const r = redact(all, new Set(split.holdout));
    const text = formatReport(all, r, meta);
    const csv = disagreementsCsv(r);
    const json = JSON.stringify(reportJson(all, r, meta));
    for (const m of ['M07', 'GGG', 'politician name']) {
      expect(text).not.toContain(m);
      expect(csv).not.toContain(m);
      expect(json).not.toContain(m);
    }
    expect(text).toContain('1 held-out disagreement(s) are not listed');
  });

  it('with nothing hidden the disagreement is listed', () => {
    const r = redact(all, new Set());
    expect(disagreementsCsv(r)).toContain('M07,GGG,celebrity,political,0.45,politician name');
  });

  it('a withheld missing coin is counted, not named', () => {
    const fewer = parseResults(
      fx('results.jsonl')
        .split('\n')
        .filter((l) => !l.includes('"M09"'))
        .join('\n'),
    );
    const s = score({ labels, results: fewer, scope: null });
    const r = redact(s, new Set(split.holdout));
    expect(r.missingMints).toEqual(['M11']);
    expect(r.withheld.missing).toBe(1);
    expect(formatReport(s, r, meta)).not.toContain('M09');
  });
});

describe('report', () => {
  it('prints the hand-worked numbers for the whole fixture', () => {
    const s = score({ labels, results, scope: null });
    const text = formatReport(s, redact(s, new Set()), {
      split: 'all',
      splitFile: null,
      labelsPath: 'labels.csv',
      resultsPath: 'results.jsonl',
      showHoldout: true,
    });
    expect(text).toContain('overall: 7/12 = 58.3% (95% interval 32.0% to 80.7%)');
    expect(text).toContain(
      'wrong: 5, of which classification failed: 1, missing from the results: 1',
    );
    expect(text).toContain('0.85 and above');
    expect(text).toContain('either:                      9/12 = 75.0% (95% interval');
    expect(text).toContain('precision: 2/5 = 40.0%');
    expect(text).toContain('recall:    2/4 = 50.0%');
    expect(text).toContain('in the results but not in the labels (left out of every number): 1');
  });

  it('csv quoting', () => {
    expect(csvLine(['a,b', 'say "hi"', null, 3])).toBe('"a,b","say ""hi""",,3');
  });
});
