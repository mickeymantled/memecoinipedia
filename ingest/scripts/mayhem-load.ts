/**
 * Loads the Mayhem Mode flag of graduates already in the database (issue #102) from the two-column
 * file that `ingest/sql/dune/mayhem-graduates.sql` produces (mint, is_mayhem_mode).
 *
 *   pnpm -C ingest exec tsx scripts/mayhem-load.ts --file FILE            dry run: prints counts
 *   pnpm -C ingest exec tsx scripts/mayhem-load.ts --file FILE --confirm  writes
 *
 * It asks no provider and inserts no coin. A true in the database stays true; a false only fills
 * an empty flag. The dry run opens the database read-only and prints what would change. Needs
 * DATABASE_URL.
 */
import { parseArgs } from 'node:util';
import { createDb, createReadOnlyDb } from '@memecoinipedia/db';
import { formatMayhemReport, loadMayhemFlags } from '../src/backfill/mayhem.js';
import { secretsFromEnv } from '../src/worker/log.js';

function usage(message?: string): never {
  if (message) process.stderr.write(`${message}\n\n`);
  process.stderr.write('Usage: mayhem-load.ts --file FILE [--confirm]\n');
  process.exit(message ? 2 : 0);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      file: { type: 'string' },
      confirm: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (values.help) usage();
  if (!values.file) usage('--file FILE is required');
  const url = process.env['DATABASE_URL'];
  if (!url) usage('DATABASE_URL is not set');
  const db = values.confirm ? createDb(url, { max: 2 }) : createReadOnlyDb(url);
  try {
    const report = await loadMayhemFlags({ file: values.file, confirm: values.confirm, db });
    process.stdout.write(`${formatMayhemReport(report)}\n`);
  } finally {
    await db.destroy();
  }
}

main().catch((err: unknown) => {
  let text = err instanceof Error ? err.message : String(err);
  for (const s of secretsFromEnv(process.env))
    if (s.length >= 6) text = text.split(s).join('[redacted]');
  process.stderr.write(`mayhem-load failed: ${text}\n`);
  process.exit(1);
});
