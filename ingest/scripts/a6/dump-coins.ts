/**
 * Dumps what the dev database holds for each coin of the review list into one
 * JSON file per coin, so the rest of the review runs offline. Read only: the
 * connection is opened with default_transaction_read_only on, and nothing is
 * written to the database.
 *
 *   node --env-file=.env --import tsx ingest/scripts/a6/dump-coins.ts \
 *     --list ingest/reports/a6-review-list-2026-11-15.csv --out DIR
 *
 * Each file: the coin row (metrics, flags, status), pools, the candles-stage
 * detail, candle coverage, open data issues and every stored bar.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { sql } from 'kysely';
import { createDb, getBars } from '@memecoinipedia/db';

function parseCsv(text: string): Record<string, string>[] {
  const [head, ...rows] = text.trim().split('\n');
  const cols = head!.split(',');
  return rows.map((r) => {
    const cells = r.split(',');
    return Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? '']));
  });
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { list: { type: 'string' }, out: { type: 'string' } },
    strict: true,
  });
  if (!values.list || !values.out) throw new Error('Usage: --list CSV --out DIR');
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is not set');
  const mints = parseCsv(await readFile(values.list, 'utf8')).map((r) => r['mint']!);
  const outDir = values.out;
  await mkdir(outDir, { recursive: true });
  const db = createDb(url);
  try {
    await sql`set default_transaction_read_only = on`.execute(db);
    // A pool of connections would not all carry the setting; use one transaction that is read only.
    await db.transaction().setAccessMode('read only').execute(async (trx) => {
      for (const mint of mints) {
        const coin = await trx
          .selectFrom('coins')
          .selectAll()
          .where('address', '=', mint)
          .executeTakeFirst();
        if (!coin) {
          process.stderr.write(`not in database: ${mint}\n`);
          continue;
        }
        const pools = await trx
          .selectFrom('pools')
          .selectAll()
          .where('coin_id', '=', coin.id)
          .orderBy('id')
          .execute();
        const stages = await trx
          .selectFrom('coin_stages')
          .select(['stage', 'status', 'detail', 'last_error'])
          .where('coin_id', '=', coin.id)
          .execute();
        const issues = await trx
          .selectFrom('data_issues')
          .select(['kind', 'detail', 'resolved_at'])
          .where('coin_id', '=', coin.id)
          .execute();
        const poolOut = [];
        for (const p of pools) {
          const coverage = await trx
            .selectFrom('candle_coverage')
            .selectAll()
            .where('pool_id', '=', p.id)
            .execute();
          const bars: Record<string, unknown> = {};
          for (const res of [60, 3600, 86400] as const) {
            bars[String(res)] = await getBars(trx as never, p.id, res);
          }
          poolOut.push({ pool: p, coverage, bars });
        }
        const slim = { ...coin, metadata_raw: undefined, description: undefined };
        await writeFile(
          join(outDir, `${mint}.json`),
          JSON.stringify({ coin: slim, pools: poolOut, stages, issues }),
        );
      }
    });
  } finally {
    await db.destroy();
  }
}

main().catch((err: unknown) => {
  const url = process.env['DATABASE_URL'] ?? '';
  let text = err instanceof Error ? err.message : String(err);
  if (url.length >= 6) text = text.split(url).join('[redacted]');
  process.stderr.write(`dump-coins failed: ${text}\n`);
  process.exit(1);
});
