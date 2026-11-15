import { csvLine } from './csv.js';
import type { Proportion, Redacted, Score } from './score.js';
import type { SplitFile, SplitName } from './split.js';

export interface ReportMeta {
  split: SplitName;
  /** The split file in use, if one was read. */
  splitFile: SplitFile | null;
  labelsPath: string;
  resultsPath: string;
  /** True when the held-out coins may be listed one by one. */
  showHoldout: boolean;
}

function pct(x: number | null): string {
  return x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`;
}

/** `7/12 = 58.3% (95% interval 31.9% to 80.7%)`, or `0/0 = n/a`. */
function prop(p: Proportion, interval = true): string {
  const head = `${p.k}/${p.n} = ${pct(p.value)}`;
  return interval && p.value !== null
    ? `${head} (95% interval ${pct(p.low)} to ${pct(p.high)})`
    : head;
}

function table(rows: string[][], rightFrom = 1): string[] {
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => r[c]!.length)));
  return rows.map((r) =>
    r
      .map((cell, c) => (c < rightFrom ? cell.padEnd(widths[c]!) : cell.padStart(widths[c]!)))
      .join('  ')
      .trimEnd(),
  );
}

/** The plain-text report. Holdout coins appear one by one only if `r` still contains them. */
export function formatReport(s: Score, r: Redacted, meta: ReportMeta): string {
  const out: string[] = [];
  const ind = (lines: string[]) => lines.map((l) => `  ${l}`);

  out.push(`Eval of ${meta.resultsPath} against ${meta.labelsPath}`);
  out.push(`Split: ${meta.split}, ${s.total} labelled coins`);
  if (meta.splitFile) {
    out.push(`Split file: seed ${meta.splitFile.seed}, made ${meta.splitFile.created_at}`);
  }
  out.push('');

  out.push('Primary narrative accuracy (exact match of the slug)');
  out.push(`  overall: ${prop(s.accuracy)}`);
  out.push(
    `  wrong: ${s.total - s.correct}, of which classification failed: ${s.failed}, missing from the results: ${s.missing}`,
  );
  out.push('  A failed or missing coin counts as wrong. Intervals are Wilson.');
  out.push('');

  out.push('Accuracy per narrative (by the label)');
  out.push(
    ...ind(
      table([
        ['narrative', 'correct', 'of', 'accuracy'],
        ...s.perNarrative.map((p) => [
          p.slug,
          String(p.accuracy.k),
          String(p.accuracy.n),
          pct(p.accuracy.value),
        ]),
      ]),
    ),
  );
  out.push('');

  out.push('Confusion table (rows: label, columns: prediction)');
  const cols = s.confusion.columns;
  out.push(
    ...ind(
      table([
        ['label', ...cols],
        ...s.confusion.rows.map((row) => [
          row.label,
          ...cols.map((c) => (row.counts[c] ? String(row.counts[c]) : '.')),
        ]),
      ]),
    ),
  );
  out.push('');

  out.push(`Accuracy by the model's confidence (${s.bands.classified} classified coins)`);
  out.push(
    ...ind(
      table([
        ['band', 'coins', 'share', 'correct', 'accuracy'],
        ...s.bands.rows.map((b) => [
          b.name,
          String(b.n),
          pct(b.share),
          String(b.accuracy.k),
          pct(b.accuracy.value),
        ]),
      ]),
    ),
  );
  out.push(`  below 0.7:       ${prop(s.bands.below07, false)}`);
  out.push(`  0.7 and above:   ${prop(s.bands.atLeast07, false)}`);
  out.push(
    `  Shares are of the classified coins; ${s.total - s.bands.classified} failed or missing coin(s) have no confidence.`,
  );
  out.push('');

  out.push("Label's primary narrative among the model's primary and secondaries");
  out.push(`  as the model's primary:      ${s.secondaries.asPrimary}/${s.secondaries.n}`);
  out.push(`  only among its secondaries:  ${s.secondaries.asSecondaryOnly}/${s.secondaries.n}`);
  out.push(`  either:                      ${prop(s.secondaries.anywhere)}`);
  out.push('');

  out.push('Parent (parent_address against parent_mint)');
  out.push(
    `  labels with a parent: ${s.parent.actual}, results naming a parent: ${s.parent.predicted}`,
  );
  out.push(`  precision: ${prop(s.parent.precision, false)}`);
  out.push(`  recall:    ${prop(s.parent.recall, false)}`);
  out.push('');

  out.push('Coins not in the denominator or not in the results');
  out.push(`  labelled, missing from the results (counted wrong): ${s.missing}`);
  for (const m of r.missingMints) out.push(`    ${m}`);
  if (r.withheld.missing > 0) {
    out.push(`    ${r.withheld.missing} held-out coin(s) not listed (use --show-holdout)`);
  }
  out.push(
    `  in the results but not in the labels (left out of every number): ${s.unlabelled.length}`,
  );
  for (const m of s.unlabelled) out.push(`    ${m}`);
  if (s.outOfScope > 0) {
    out.push(
      `  in the results, labelled, outside the ${meta.split} split (not scored): ${s.outOfScope}`,
    );
  }
  out.push('');

  out.push(`Disagreements: ${s.disagreements.length}`);
  if (r.withheld.disagreements > 0) {
    out.push(
      `  ${r.withheld.disagreements} held-out disagreement(s) are not listed or written (use --show-holdout)`,
    );
  }
  return `${out.join('\n')}\n`;
}

/** The same numbers as JSON. Per-coin lists follow the same redaction as the text report. */
export function reportJson(s: Score, r: Redacted, meta: ReportMeta): unknown {
  return {
    results: meta.resultsPath,
    labels: meta.labelsPath,
    split: meta.split,
    split_file: meta.splitFile
      ? { seed: meta.splitFile.seed, created_at: meta.splitFile.created_at }
      : null,
    show_holdout: meta.showHoldout,
    labelled: s.total,
    correct: s.correct,
    failed: s.failed,
    missing: s.missing,
    accuracy: s.accuracy,
    per_narrative: s.perNarrative.map((p) => ({ narrative: p.slug, ...p.accuracy })),
    confusion: s.confusion,
    confidence_bands: {
      classified: s.bands.classified,
      bands: s.bands.rows.map((b) => ({ band: b.name, coins: b.n, share: b.share, ...b.accuracy })),
      below_0_7: s.bands.below07,
      at_least_0_7: s.bands.atLeast07,
    },
    secondaries: s.secondaries,
    parent: s.parent,
    missing_mints: r.missingMints,
    unlabelled_mints: s.unlabelled,
    out_of_scope: s.outOfScope,
    withheld: r.withheld,
    disagreements: r.disagreements.length,
  };
}

export const DISAGREEMENT_COLUMNS = [
  'mint',
  'ticker',
  'label',
  'prediction',
  'confidence',
  'reason',
];

/** The disagreements as CSV for review. Failed and missing coins have `(failed)` / `(missing)`. */
export function disagreementsCsv(r: Redacted): string {
  const lines = [csvLine(DISAGREEMENT_COLUMNS)];
  for (const d of r.disagreements) {
    lines.push(csvLine([d.mint, d.ticker, d.label, d.prediction, d.confidence, d.reason]));
  }
  return `${lines.join('\n')}\n`;
}
