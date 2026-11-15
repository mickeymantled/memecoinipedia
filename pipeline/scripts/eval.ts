/**
 * The classification eval: score a classifier run against the hand labels.
 *
 *   tsx pipeline/scripts/eval.ts score --results results.jsonl [options]
 *   tsx pipeline/scripts/eval.ts make-split --seed N [options]
 *   tsx pipeline/scripts/eval.ts research [DIR]
 *
 * No network, no database, no .env.
 *
 * score
 *   --results FILE        what `classify.ts --out FILE` wrote (required)
 *   --labels FILE         default research/evals/labels.csv
 *   --split-file FILE     default research/evals/split.json
 *   --split tune|holdout|all   which labelled coins to score (default tune)
 *   --show-holdout        list held-out coins one by one (stdout and the disagreements file).
 *                         Without it only their totals are printed.
 *   --json FILE           the same numbers as JSON
 *   --disagreements FILE  default <results>.disagreements.csv (held-out rows only with --show-holdout)
 *   Prints a plain-text report to stdout. Exits 2 when an input file has a problem; the problems
 *   are printed with their line numbers and nothing is scored.
 *
 * make-split
 *   Creates the split file once from the labels, stratified by primary narrative.
 *   --seed N (required)   --tune 120   --holdout 80   --labels FILE   --split-file FILE
 *   Refuses to overwrite an existing split file. Writes only when you run it.
 *
 * research
 *   Validates research/narratives/batch-*.json and says what it loaded and what it rejected.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  checkSplit,
  createSplit,
  disagreementsCsv,
  formatReport,
  loadResearchDir,
  mintsFor,
  parseLabels,
  parseResults,
  parseSplit,
  redact,
  reportJson,
  score,
  writeSplitFile,
  type Problem,
  type SplitFile,
  type SplitName,
} from '../src/eval/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_LABELS = join(ROOT, 'research', 'evals', 'labels.csv');
const DEFAULT_SPLIT = join(ROOT, 'research', 'evals', 'split.json');
const DEFAULT_RESEARCH = join(ROOT, 'research', 'narratives');

function fail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

function failProblems(file: string, problems: Problem[]): never {
  for (const p of problems) console.error(`${file}${p.line > 0 ? `:${p.line}` : ''}: ${p.message}`);
  console.error(`${problems.length} problem(s) in ${file}; nothing was scored.`);
  process.exit(2);
}

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') fail(`${path}: no such file`);
    throw err;
  }
}

async function loadLabels(path: string) {
  const { labels, problems } = parseLabels(await readText(path));
  if (problems.length > 0) failProblems(path, problems);
  return labels;
}

async function readSplit(path: string, required: boolean): Promise<SplitFile | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    if (required) fail(`${path}: no split file; create one with the make-split command`);
    return null;
  }
  try {
    return parseSplit(text);
  } catch (err) {
    return fail(`${path}: ${(err as Error).message}`);
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const options = {
    results: { type: 'string' },
    labels: { type: 'string', default: DEFAULT_LABELS },
    'split-file': { type: 'string', default: DEFAULT_SPLIT },
    split: { type: 'string', default: 'tune' },
    'show-holdout': { type: 'boolean', default: false },
    json: { type: 'string' },
    disagreements: { type: 'string' },
    seed: { type: 'string' },
    tune: { type: 'string', default: '120' },
    holdout: { type: 'string', default: '80' },
  } as const;
  let parsed;
  try {
    parsed = parseArgs({ args: rest, options, allowPositionals: true });
  } catch (err) {
    return fail((err as Error).message);
  }
  const { values: a, positionals } = parsed;
  const labelsPath = a.labels;
  const splitPath = a['split-file'];

  if (command === 'make-split') {
    if (a.seed === undefined) fail('make-split needs --seed N');
    const toInt = (name: string, v: string) => {
      if (!/^\d+$/.test(v)) fail(`--${name} must be a non-negative integer, got "${v}"`);
      return Number(v);
    };
    const labels = await loadLabels(labelsPath);
    let split: SplitFile;
    try {
      split = createSplit(labels, {
        seed: toInt('seed', a.seed),
        tune: toInt('tune', a.tune),
        holdout: toInt('holdout', a.holdout),
        createdAt: new Date().toISOString(),
      });
      await writeSplitFile(splitPath, split);
    } catch (err) {
      return fail((err as Error).message);
    }
    console.log(
      `wrote ${splitPath}: ${split.tune.length} tune, ${split.holdout.length} holdout, seed ${split.seed}`,
    );
    return;
  }

  if (command === 'research') {
    const dir = positionals[0] ?? DEFAULT_RESEARCH;
    const load = await loadResearchDir(dir).catch((err: unknown) =>
      fail(`${dir}: ${(err as Error).message}`),
    );
    console.log(`${load.byMint.size} entries loaded from ${dir}`);
    for (const p of load.problems) {
      console.log(
        `rejected ${p.file} entry ${p.index ?? '-'} (${p.mint ?? 'no mint'}): ${p.message}`,
      );
    }
    console.log(`${load.problems.length} rejected`);
    if (load.problems.length > 0) process.exitCode = 1;
    return;
  }

  if (command === 'score') {
    if (a.results === undefined) fail('score needs --results FILE');
    if (a.split !== 'tune' && a.split !== 'holdout' && a.split !== 'all') {
      fail(`--split must be tune, holdout or all, got "${a.split}"`);
    }
    const splitName: SplitName = a.split;
    const labels = await loadLabels(labelsPath);
    const split = await readSplit(splitPath, splitName !== 'all');
    if (split) {
      const stale = checkSplit(split, labels);
      if (stale.length > 0) failProblems(splitPath, stale);
    }
    const results = parseResults(await readText(a.results));
    if (results.problems.length > 0) failProblems(a.results, results.problems);

    const s = score({ labels, results, scope: mintsFor(split, splitName) });
    const hidden = new Set(a['show-holdout'] ? [] : (split?.holdout ?? []));
    const shown = redact(s, hidden);
    const meta = {
      split: splitName,
      splitFile: split,
      labelsPath,
      resultsPath: a.results,
      showHoldout: a['show-holdout'],
    };
    process.stdout.write(formatReport(s, shown, meta));

    const disagreementsPath = a.disagreements ?? `${a.results}.disagreements.csv`;
    await writeFile(disagreementsPath, disagreementsCsv(shown));
    console.log(`Disagreements written to ${disagreementsPath}`);
    if (a.json !== undefined) {
      await writeFile(a.json, `${JSON.stringify(reportJson(s, shown, meta), null, 2)}\n`);
      console.log(`JSON written to ${a.json}`);
    }
    return;
  }

  fail('usage: eval.ts score|make-split|research (see the comment at the top of this file)');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
