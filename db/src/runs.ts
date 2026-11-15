import type { Kysely } from 'kysely';
import type { Database } from './types.js';

/**
 * `ingest_runs` and `provider_usage`: one row per run with the cost estimate
 * made before it started and the usage recorded while it ran.
 */

export type RunStatus = 'planned' | 'running' | 'done' | 'failed' | 'stopped';

export interface RunRecord {
  id: number;
  kind: string;
  status: RunStatus;
  params: unknown;
  estimate: unknown;
  actual: unknown;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export async function createRun(
  db: Kysely<Database>,
  run: { kind: string; params?: unknown; estimate?: unknown },
): Promise<number> {
  const row = await db
    .insertInto('ingest_runs')
    .values({
      kind: run.kind,
      params: run.params === undefined ? null : JSON.stringify(run.params),
      estimate: run.estimate === undefined ? null : JSON.stringify(run.estimate),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export async function startRun(db: Kysely<Database>, runId: number, now: Date): Promise<void> {
  await db
    .updateTable('ingest_runs')
    .set({ status: 'running', started_at: now })
    .where('id', '=', runId)
    .execute();
}

export async function finishRun(
  db: Kysely<Database>,
  runId: number,
  result: { status: 'done' | 'failed' | 'stopped'; actual?: unknown; now: Date },
): Promise<void> {
  await db
    .updateTable('ingest_runs')
    .set({
      status: result.status,
      finished_at: result.now,
      ...(result.actual === undefined ? {} : { actual: JSON.stringify(result.actual) }),
    })
    .where('id', '=', runId)
    .execute();
}

export async function getRun(db: Kysely<Database>, runId: number): Promise<RunRecord | null> {
  const r = await db
    .selectFrom('ingest_runs')
    .selectAll()
    .where('id', '=', runId)
    .executeTakeFirst();
  if (!r) return null;
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    params: r.params,
    estimate: r.estimate,
    actual: r.actual,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

export interface UsageEntry {
  provider: string;
  requests: number;
  /** Provider units: credits for Helius, compute units for Codex.io, 0 where there are none. */
  units: number;
}

/**
 * Sets the run's usage for a provider to these totals (not an increment), so a
 * periodic flush of running totals is safe to repeat.
 */
export async function recordUsage(
  db: Kysely<Database>,
  runId: number,
  entry: UsageEntry,
  now: Date,
): Promise<void> {
  await db
    .insertInto('provider_usage')
    .values({
      run_id: runId,
      provider: entry.provider,
      requests: entry.requests,
      units: entry.units,
      updated_at: now,
    })
    .onConflict((oc) =>
      oc.columns(['run_id', 'provider']).doUpdateSet({
        requests: entry.requests,
        units: entry.units,
        updated_at: now,
      }),
    )
    .execute();
}

export async function getUsage(db: Kysely<Database>, runId: number): Promise<UsageEntry[]> {
  const rows = await db
    .selectFrom('provider_usage')
    .select(['provider', 'requests', 'units'])
    .where('run_id', '=', runId)
    .orderBy('provider')
    .execute();
  return rows.map((r) => ({ provider: r.provider, requests: r.requests, units: r.units }));
}
