/**
 * Evaluates the parent-candidate provider against hand-checked pairs. Read-only.
 *
 *   tsx --env-file=.env pipeline/scripts/parent-candidates-eval.ts --pairs pairs.csv [--chain solana]
 *
 * pairs.csv has `child_address,parent_address` per line (a header line is fine). For each pair it
 * prints the rank of the true parent among the candidates, or "missing", then recall at 1, 3 and
 * 10. Reads DATABASE_URL; everything runs in one read-only transaction.
 */
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createDb } from '@memecoinipedia/db';
import { evaluateParentPairs, formatEval, parsePairsCsv } from '../src/classify/parent-eval.js';

function fail(msg: string): never {
  process.stderr.write(`${msg}\n`);
  process.exit(2);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { pairs: { type: 'string' }, chain: { type: 'string', default: 'solana' } },
    strict: true,
  });
  if (!values.pairs) fail('--pairs FILE is required.');
  const url = process.env['DATABASE_URL'];
  if (!url) fail('DATABASE_URL is not set.');
  const pairs = parsePairsCsv(await readFile(values.pairs, 'utf8'));
  const db = createDb(url);
  try {
    const summary = await evaluateParentPairs(db, pairs, { chain: values.chain });
    process.stdout.write(`${formatEval(summary)}\n`);
  } finally {
    await db.destroy();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : 'failed'}\n`);
  process.exit(1);
});
