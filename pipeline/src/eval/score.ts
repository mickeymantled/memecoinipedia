import { DEFAULT_NARRATIVES, type Narrative } from '../classify/schema.js';
import type { Label } from './labels.js';
import type { ResultsLoad } from './results.js';

/** z for a 95% interval. */
const Z95 = 1.96;

export interface Proportion {
  k: number;
  n: number;
  /** k / n; null when n is 0. */
  value: number | null;
  /** Wilson 95% interval; null when n is 0. */
  low: number | null;
  high: number | null;
}

/** k out of n with its Wilson score interval at 95%. */
export function proportion(k: number, n: number): Proportion {
  if (n === 0) return { k, n, value: null, low: null, high: null };
  const p = k / n;
  const z2 = Z95 * Z95;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (Z95 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { k, n, value: p, low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

/** Confidence bands on the model's confidence: lower bound included, upper bound excluded. */
export const BANDS = [
  { name: 'below 0.5', min: 0, max: 0.5 },
  { name: '0.5 to below 0.7', min: 0.5, max: 0.7 },
  { name: '0.7 to below 0.85', min: 0.7, max: 0.85 },
  { name: '0.85 and above', min: 0.85, max: Infinity },
] as const;

export const FAILED_COLUMN = '(failed)';
export const MISSING_COLUMN = '(missing)';

export type DisagreementKind = 'wrong' | 'failed' | 'missing';

export interface Disagreement {
  mint: string;
  ticker: string;
  label: string;
  /** The predicted slug, or `(failed)` or `(missing)`. */
  prediction: string;
  confidence: number | null;
  reason: string;
  kind: DisagreementKind;
}

export interface Score {
  /** Labelled coins in scope: the denominator of every headline number. */
  total: number;
  correct: number;
  /** Coins whose classification failed: counted wrong. */
  failed: number;
  /** Labelled coins with no line in the results: counted wrong. */
  missing: number;
  accuracy: Proportion;
  perNarrative: Array<{ slug: string; accuracy: Proportion }>;
  confusion: { columns: string[]; rows: Array<{ label: string; counts: Record<string, number> }> };
  bands: {
    /** Coins that have a model confidence (all but failed and missing). */
    classified: number;
    rows: Array<{ name: string; n: number; share: number | null; accuracy: Proportion }>;
    /** The same coins cut at 0.7, the second-pass threshold. */
    below07: Proportion;
    atLeast07: Proportion;
  };
  secondaries: {
    n: number;
    /** The label's primary is the model's primary. */
    asPrimary: number;
    /** It is not the primary but is among the model's secondaries. */
    asSecondaryOnly: number;
    /** Either of the above. */
    anywhere: Proportion;
  };
  parent: {
    /** Labels with a parent_mint. */
    actual: number;
    /** Results (not failed) that name a parent_address. */
    predicted: number;
    /** Predicted equals the label's parent_mint. */
    truePositives: number;
    precision: Proportion;
    recall: Proportion;
  };
  disagreements: Disagreement[];
  /** Labelled coins in scope with no result, in label order. */
  missingMints: string[];
  /** Result mints that are in no label. Left out of every number. */
  unlabelled: string[];
  /** Result mints that are labelled but outside the scope (other side of the split). */
  outOfScope: number;
}

export interface ScoreInput {
  labels: readonly Label[];
  results: ResultsLoad;
  /** Mints in scope; null scores every label. */
  scope: ReadonlySet<string> | null;
  narratives?: readonly Narrative[];
}

/** Scores a results file against labels. Pure: no file is read. */
export function score(input: ScoreInput): Score {
  const narratives = input.narratives ?? DEFAULT_NARRATIVES;
  const scoped = input.labels.filter((l) => input.scope === null || input.scope.has(l.mint));
  const labelled = new Set(input.labels.map((l) => l.mint));
  const inScope = new Set(scoped.map((l) => l.mint));

  let correct = 0;
  let failed = 0;
  const missingMints: string[] = [];
  const disagreements: Disagreement[] = [];
  const perCount = new Map<string, { k: number; n: number }>();
  const confusion = new Map<string, Record<string, number>>();
  const columnSet = new Set<string>();
  const bandN = BANDS.map(() => 0);
  const bandK = BANDS.map(() => 0);
  let classified = 0;
  const below = { k: 0, n: 0 };
  const atLeast = { k: 0, n: 0 };
  let asPrimary = 0;
  let asSecondaryOnly = 0;
  let parentActual = 0;
  let parentPredicted = 0;
  let parentTrue = 0;

  for (const l of scoped) {
    const r = input.results.byMint.get(l.mint);
    const per = perCount.get(l.primary) ?? { k: 0, n: 0 };
    per.n += 1;
    perCount.set(l.primary, per);
    if (l.parentMint !== null) parentActual += 1;

    let prediction: string;
    let hit = false;
    if (!r) {
      prediction = MISSING_COLUMN;
      missingMints.push(l.mint);
      disagreements.push({
        mint: l.mint,
        ticker: l.ticker,
        label: l.primary,
        prediction,
        confidence: null,
        reason: 'no line for this coin in the results file',
        kind: 'missing',
      });
    } else if (r.kind === 'failed') {
      prediction = FAILED_COLUMN;
      failed += 1;
      disagreements.push({
        mint: l.mint,
        ticker: l.ticker,
        label: l.primary,
        prediction,
        confidence: null,
        reason: r.error,
        kind: 'failed',
      });
    } else {
      prediction = r.primary;
      hit = r.primary === l.primary;
      classified += 1;
      const b = BANDS.findIndex((x) => r.confidence >= x.min && r.confidence < x.max);
      bandN[b]! += 1;
      if (hit) bandK[b]! += 1;
      const side = r.confidence < 0.7 ? below : atLeast;
      side.n += 1;
      if (hit) side.k += 1;
      if (hit) asPrimary += 1;
      else if (r.secondaries.includes(l.primary)) asSecondaryOnly += 1;
      if (r.parentAddress !== null) {
        parentPredicted += 1;
        if (r.parentAddress === l.parentMint) parentTrue += 1;
      }
      if (!hit) {
        disagreements.push({
          mint: l.mint,
          ticker: l.ticker,
          label: l.primary,
          prediction,
          confidence: r.confidence,
          reason: r.reason,
          kind: 'wrong',
        });
      }
    }
    if (hit) {
      correct += 1;
      per.k += 1;
    }
    columnSet.add(prediction);
    const row = confusion.get(l.primary) ?? {};
    row[prediction] = (row[prediction] ?? 0) + 1;
    confusion.set(l.primary, row);
  }

  const order = (slug: string) => {
    const i = narratives.findIndex((n) => n.slug === slug);
    return i < 0 ? narratives.length : i;
  };
  const bySlug = (a: string, b: string) => order(a) - order(b) || a.localeCompare(b);
  const columns = [...columnSet].sort((a, b) => {
    const special = (s: string) => (s === FAILED_COLUMN ? 2 : s === MISSING_COLUMN ? 3 : 0);
    return special(a) - special(b) || bySlug(a, b);
  });
  const labelSlugs = [...perCount.keys()].sort(bySlug);

  const unlabelled: string[] = [];
  let outOfScope = 0;
  for (const mint of input.results.byMint.keys()) {
    if (!labelled.has(mint)) unlabelled.push(mint);
    else if (!inScope.has(mint)) outOfScope += 1;
  }

  return {
    total: scoped.length,
    correct,
    failed,
    missing: missingMints.length,
    accuracy: proportion(correct, scoped.length),
    perNarrative: labelSlugs.map((slug) => ({
      slug,
      accuracy: proportion(perCount.get(slug)!.k, perCount.get(slug)!.n),
    })),
    confusion: {
      columns,
      rows: labelSlugs.map((label) => ({ label, counts: confusion.get(label)! })),
    },
    bands: {
      classified,
      rows: BANDS.map((b, i) => ({
        name: b.name,
        n: bandN[i]!,
        share: classified === 0 ? null : bandN[i]! / classified,
        accuracy: proportion(bandK[i]!, bandN[i]!),
      })),
      below07: proportion(below.k, below.n),
      atLeast07: proportion(atLeast.k, atLeast.n),
    },
    secondaries: {
      n: scoped.length,
      asPrimary,
      asSecondaryOnly,
      anywhere: proportion(asPrimary + asSecondaryOnly, scoped.length),
    },
    parent: {
      actual: parentActual,
      predicted: parentPredicted,
      truePositives: parentTrue,
      precision: proportion(parentTrue, parentPredicted),
      recall: proportion(parentTrue, parentActual),
    },
    disagreements,
    missingMints,
    unlabelled,
    outOfScope,
  };
}

/** What a report may show without leaking the held-out coins one by one. */
export interface Redacted {
  disagreements: Disagreement[];
  missingMints: string[];
  /** How many held-out coins were left out of each list above. */
  withheld: { disagreements: number; missing: number };
}

/** Removes the `hidden` mints from the per-coin lists and counts what was removed. */
export function redact(s: Score, hidden: ReadonlySet<string>): Redacted {
  const disagreements = s.disagreements.filter((d) => !hidden.has(d.mint));
  const missingMints = s.missingMints.filter((m) => !hidden.has(m));
  return {
    disagreements,
    missingMints,
    withheld: {
      disagreements: s.disagreements.length - disagreements.length,
      missing: s.missingMints.length - missingMints.length,
    },
  };
}
