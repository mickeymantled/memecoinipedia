import type { Kysely } from 'kysely';
import type { Database } from './types.js';

/**
 * The data-issue queue (table `data_issues`), one helper.
 *
 * Ownership rule: an issue belongs to the stage that wrote it, and a stage that
 * runs again replaces only its own. A stage names the kinds it owns; the helper
 * replaces that coin's open issues of those kinds in one transaction. Open
 * issues of other kinds (another stage's) and resolved issues are never
 * touched, so metadata's issues survive a candles run and the reverse.
 */
export interface NewIssue {
  kind: string;
  detail?: unknown;
}

/** JSON with object keys sorted, so two values compare equal whatever order a database returned them in. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
const detailKey = (detail: unknown): string =>
  canonical(detail === undefined ? null : JSON.parse(JSON.stringify(detail)));

/**
 * Replaces a coin's open issues whose kind is in `ownedKinds` with `issues`, so
 * running a stage again does not pile up duplicates. Issues of other kinds, and
 * resolved ones, are untouched. Every kind in `issues` must be in `ownedKinds`.
 *
 * Idempotent: an open owned issue that already has the same kind and the same
 * detail as a wanted one stays as it is (same row, same `created_at`), so
 * recording the same result again changes nothing. Open owned issues with no
 * match are deleted and wanted issues with no match are inserted.
 */
export async function replaceCoinIssues(
  db: Kysely<Database>,
  coinId: number,
  ownedKinds: readonly string[],
  issues: readonly NewIssue[],
): Promise<void> {
  const stray = issues.filter((i) => !ownedKinds.includes(i.kind));
  if (stray.length > 0) {
    throw new Error(
      `Issue kind(s) not owned by the caller: ${[...new Set(stray.map((i) => i.kind))].join(', ')}`,
    );
  }
  await db.transaction().execute(async (trx) => {
    const open =
      ownedKinds.length === 0
        ? []
        : await trx
            .selectFrom('data_issues')
            .select(['id', 'kind', 'detail'])
            .where('coin_id', '=', coinId)
            .where('kind', 'in', [...ownedKinds])
            .where('resolved_at', 'is', null)
            .orderBy('id')
            .forUpdate()
            .execute();
    const unmatched = [...open];
    const toInsert: NewIssue[] = [];
    for (const issue of issues) {
      const key = detailKey(issue.detail);
      const at = unmatched.findIndex((r) => r.kind === issue.kind && detailKey(r.detail) === key);
      if (at >= 0) unmatched.splice(at, 1);
      else toInsert.push(issue);
    }
    if (unmatched.length > 0) {
      await trx
        .deleteFrom('data_issues')
        .where(
          'id',
          'in',
          unmatched.map((r) => r.id),
        )
        .execute();
    }
    if (toInsert.length > 0) {
      await trx
        .insertInto('data_issues')
        .values(
          toInsert.map((i) => ({
            coin_id: coinId,
            kind: i.kind,
            detail: i.detail === undefined ? null : JSON.stringify(i.detail),
          })),
        )
        .execute();
    }
  });
}
