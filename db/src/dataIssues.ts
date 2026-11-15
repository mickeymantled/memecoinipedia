import { sql, type Kysely } from 'kysely';
import type { Database } from './types.js';

/**
 * Adds a row to the data-issue queue unless the coin already has an unresolved
 * issue of the same kind (then nothing is written, so a stage that runs again
 * does not pile up duplicates). Returns the issue id and whether it is new.
 */
export async function recordDataIssue(
  db: Kysely<Database>,
  coinId: number,
  kind: string,
  detail?: unknown,
): Promise<{ id: number; created: boolean }> {
  return db.transaction().execute(async (trx) => {
    await sql`select pg_advisory_xact_lock(hashtext('data_issues'), ${coinId}::int)`.execute(trx);
    const open = await trx
      .selectFrom('data_issues')
      .select('id')
      .where('coin_id', '=', coinId)
      .where('kind', '=', kind)
      .where('resolved_at', 'is', null)
      .orderBy('id')
      .executeTakeFirst();
    if (open) return { id: open.id, created: false };
    const row = await trx
      .insertInto('data_issues')
      .values({
        coin_id: coinId,
        kind,
        detail: detail === undefined ? null : JSON.stringify(detail),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { id: row.id, created: true };
  });
}
