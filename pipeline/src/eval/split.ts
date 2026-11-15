import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { Label } from './labels.js';
import type { Problem } from './narratives.js';

/** `/research/evals/split.json`: which labelled mints are for tuning and which are held out. */
export const splitSchema = z
  .object({
    seed: z.number().int().nonnegative(),
    created_at: z.string().min(1),
    tune: z.array(z.string().min(1)),
    holdout: z.array(z.string().min(1)),
  })
  .strict()
  .superRefine((s, ctx) => {
    const seen = new Set<string>();
    for (const m of [...s.tune, ...s.holdout]) {
      if (seen.has(m)) {
        ctx.addIssue({ code: 'custom', message: `mint ${m} appears more than once in the split` });
      }
      seen.add(m);
    }
  });
export type SplitFile = z.infer<typeof splitSchema>;

export type SplitName = 'tune' | 'holdout' | 'all';

/** mulberry32: a small seeded generator, so the same seed gives the same split anywhere. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Splits `total` across groups in proportion to their sizes (largest remainder; ties go to the
 * earlier group). Never gives a group more than its size.
 */
export function allocate(sizes: readonly number[], total: number): number[] {
  const sum = sizes.reduce((a, b) => a + b, 0);
  if (total > sum) throw new Error(`cannot take ${total} from ${sum}`);
  const exact = sizes.map((s) => (sum === 0 ? 0 : (s * total) / sum));
  const out = exact.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = exact
    .map((e, i) => ({ i, frac: e - Math.floor(e) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (left === 0) break;
    if (out[i]! < sizes[i]!) {
      out[i]! += 1;
      left--;
    }
  }
  return out;
}

export interface CreateSplitOptions {
  tune: number;
  holdout: number;
  seed: number;
  /** ISO timestamp recorded in the file. */
  createdAt: string;
}

/**
 * Stratified by the label's primary narrative: each narrative contributes to the held-out set, and
 * to the tuning set, in proportion to its share of the labels. If there are more labels than
 * `tune + holdout`, the rest are in neither list. The same labels, sizes and seed always give the
 * same lists.
 */
export function createSplit(labels: readonly Label[], o: CreateSplitOptions): SplitFile {
  const wanted = o.tune + o.holdout;
  if (!Number.isInteger(o.tune) || !Number.isInteger(o.holdout) || o.tune < 0 || o.holdout < 0) {
    throw new Error('tune and holdout must be non-negative integers');
  }
  if (!Number.isInteger(o.seed) || o.seed < 0)
    throw new Error('seed must be a non-negative integer');
  if (wanted > labels.length) {
    throw new Error(
      `${o.tune} tune + ${o.holdout} holdout needs ${wanted} labelled coins, the labels have ${labels.length}`,
    );
  }
  const strata = new Map<string, string[]>();
  for (const l of labels) strata.set(l.primary, [...(strata.get(l.primary) ?? []), l.mint]);
  const slugs = [...strata.keys()].sort();
  const random = rng(o.seed);
  const shuffled = slugs.map((s) => {
    const mints = [...strata.get(s)!].sort();
    for (let i = mints.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [mints[i], mints[j]] = [mints[j]!, mints[i]!];
    }
    return mints;
  });
  const taken = allocate(
    shuffled.map((m) => m.length),
    wanted,
  );
  const heldOut = allocate(taken, o.holdout);
  const tune: string[] = [];
  const holdout: string[] = [];
  shuffled.forEach((mints, i) => {
    const chosen = mints.slice(0, taken[i]);
    holdout.push(...chosen.slice(0, heldOut[i]));
    tune.push(...chosen.slice(heldOut[i]));
  });
  return {
    seed: o.seed,
    created_at: o.createdAt,
    tune: tune.sort(),
    holdout: holdout.sort(),
  };
}

/** Parses split.json text. Throws with a readable message when it is malformed. */
export function parseSplit(text: string): SplitFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error('split file is not valid JSON', { cause: err });
  }
  const r = splitSchema.safeParse(raw);
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`split file is invalid: ${msg.join('; ')}`);
  }
  return r.data;
}

/** Split mints that have no label. A stale split would otherwise shrink a denominator silently. */
export function checkSplit(split: SplitFile, labels: readonly Label[]): Problem[] {
  const known = new Set(labels.map((l) => l.mint));
  return [...split.tune, ...split.holdout]
    .filter((m) => !known.has(m))
    .map((m) => ({ line: 0, message: `split lists ${m}, which has no label` }));
}

/** The mints in scope for `--split`, or null for every label. */
export function mintsFor(split: SplitFile | null, name: SplitName): Set<string> | null {
  if (name === 'all') return null;
  if (!split) throw new Error(`--split ${name} needs a split file`);
  return new Set(name === 'tune' ? split.tune : split.holdout);
}

/** Writes the split file. Refuses to replace an existing one (flag `wx`). */
export async function writeSplitFile(path: string, split: SplitFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, `${JSON.stringify(split, null, 2)}\n`, { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(
        `${path} already exists; the split is made once. Delete it by hand to start over.`,
        { cause: err },
      );
    }
    throw err;
  }
}
