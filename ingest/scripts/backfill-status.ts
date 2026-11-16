/**
 * The backfill status view. Reads only: the connection is opened with
 * `default_transaction_read_only = on`, so the database refuses any write.
 *
 *   pnpm -C ingest exec tsx scripts/backfill-status.ts \
 *     [--min-rough-peak USD] [--limit N] [--order peak|hash] [--include-no-price]
 *
 * With no options the selection is the one the last backfill run recorded. It needs DATABASE_URL
 * and makes no provider call.
 */
import { parseArgs } from 'node:util';
import { createReadOnlyDb, type SelectionSpec } from '@memecoinipedia/db';
import { collectStatus, formatStatus } from '../src/backfill/status.js';
import { secretsFromEnv } from '../src/worker/log.js';

function usage(message?: string): never {
  if (message) process.stderr.write(`${message}\n\n`);
  process.stderr.write(
    'Usage: backfill-status.ts [--min-rough-peak USD] [--limit N] [--order peak|hash] [--include-no-price]\n',
  );
  process.exit(message ? 2 : 0);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'min-rough-peak': { type: 'string' },
      limit: { type: 'string' },
      order: { type: 'string' },
      'include-no-price': { type: 'boolean' },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (values.help) usage();
  const url = process.env['DATABASE_URL'];
  if (!url) usage('DATABASE_URL is not set');
  if (values.order !== undefined && values.order !== 'peak' && values.order !== 'hash') {
    usage('--order is peak or hash');
  }
  const num = (name: string, v: string | undefined): number | undefined => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) usage(`${name} must be a positive number`);
    return n;
  };
  const given: Partial<SelectionSpec> = {
    ...(values['min-rough-peak'] !== undefined
      ? { minRoughPeakUsd: num('--min-rough-peak', values['min-rough-peak'])! }
      : {}),
    ...(values.limit !== undefined ? { limit: num('--limit', values.limit)! } : {}),
    ...(values.order !== undefined ? { order: values.order } : {}),
    ...(values['include-no-price'] !== undefined ? { includeNoPrice: true } : {}),
  };
  const db = createReadOnlyDb(url);
  try {
    const status = await collectStatus(
      db,
      Object.keys(given).length > 0 ? { selection: given } : {},
    );
    process.stdout.write(`${formatStatus(status)}\n`);
  } finally {
    await db.destroy();
  }
}

main().catch((err: unknown) => {
  let text = err instanceof Error ? err.message : String(err);
  for (const s of secretsFromEnv(process.env))
    if (s.length >= 6) text = text.split(s).join('[redacted]');
  process.stderr.write(`backfill-status failed: ${text}\n`);
  process.exit(1);
});
