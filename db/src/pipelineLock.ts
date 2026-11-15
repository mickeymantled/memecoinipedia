import { sql } from 'kysely';
import { createDb } from './client.js';

/**
 * One pipeline process per database.
 *
 * `backfill run` (confirmed runs) and `live run` both feed and drain the same stage queues, and
 * two processes on the same queues take each other's jobs. So each takes this Postgres advisory
 * lock, on a connection of its own, for as long as it runs. `pg_try_advisory_lock` is a session
 * lock: a process that dies loses its connection and so releases the lock without any cleanup.
 * Advisory locks are scoped to the database, so a test database has its own.
 *
 * The lock is the truth. A row in `live_state` (key `pipeline_lock`) says which kind of process
 * took it and when, so the refusal can name the holder; after a crash that row may be stale, and
 * the next process to take the lock overwrites it.
 */

/** The advisory-lock key. Any constant would do; this one is not used anywhere else. */
export const PIPELINE_LOCK_KEY = 7_302_461_001;
export const PIPELINE_LOCK_STATE_KEY = 'pipeline_lock';

export type PipelineProcessKind = 'live' | 'backfill';

export interface PipelineLockHolder {
  kind: PipelineProcessKind | string;
  pid: number | null;
  since: string | null;
}

export class PipelineLockError extends Error {
  /** What the hint row says about the holder; null when there is none. */
  readonly holder: PipelineLockHolder | null;
  constructor(wanted: PipelineProcessKind, holder: PipelineLockHolder | null) {
    const who = holder
      ? `a \`${holder.kind} run\` process appears to hold it` +
        `${holder.pid !== null ? ` (pid ${holder.pid}` : ' ('}${
          holder.since ? `${holder.pid !== null ? ', ' : ''}since ${holder.since}` : ''
        })`
      : 'another pipeline process (a backfill run or a live run) is running';
    super(
      `Cannot start a ${wanted} run: ${who}. Only one pipeline process may run per database; ` +
        'stop it, or wait for it to finish, and start this one again.',
    );
    this.name = 'PipelineLockError';
    this.holder = holder;
  }
}

export interface PipelineLock {
  /** Releases the lock and closes its connection. Safe to call twice. */
  release(): Promise<void>;
}

/**
 * Takes the lock or throws `PipelineLockError`. The connection that holds it is opened here and
 * stays open until `release()`.
 */
export async function acquirePipelineLock(
  connectionString: string,
  kind: PipelineProcessKind,
  opts: { now?: Date; pid?: number } = {},
): Promise<PipelineLock> {
  // Two connections: one is held for the lock, the other writes and reads the hint row.
  const db = createDb(connectionString, { max: 2 });
  let releaseHeld!: () => void;
  const mayRelease = new Promise<void>((resolve) => {
    releaseHeld = resolve;
  });
  let heldDone: Promise<unknown> = Promise.resolve();
  const outcome = new Promise<boolean>((resolve, reject) => {
    heldDone = db
      .connection()
      .execute(async (conn) => {
        const r = await sql<{
          ok: boolean;
        }>`select pg_try_advisory_lock(${PIPELINE_LOCK_KEY}) as ok`.execute(conn);
        const ok = r.rows[0]?.ok === true;
        resolve(ok);
        if (!ok) return;
        await mayRelease;
        await sql`select pg_advisory_unlock(${PIPELINE_LOCK_KEY})`.execute(conn);
      })
      .catch(reject);
  });

  let got: boolean;
  try {
    got = await outcome;
  } catch (err) {
    await db.destroy().catch(() => undefined);
    throw err;
  }
  if (!got) {
    let holder: PipelineLockHolder | null = null;
    try {
      const row = await db
        .selectFrom('live_state')
        .select('value')
        .where('key', '=', PIPELINE_LOCK_STATE_KEY)
        .executeTakeFirst();
      const v = row?.value as Partial<PipelineLockHolder> | undefined;
      if (v && typeof v.kind === 'string') {
        holder = { kind: v.kind, pid: v.pid ?? null, since: v.since ?? null };
      }
    } catch {
      // No hint (the table may not exist yet): the message just says another process runs.
    }
    await db.destroy().catch(() => undefined);
    throw new PipelineLockError(kind, holder);
  }

  const now = opts.now ?? new Date();
  const hint = { kind, pid: opts.pid ?? process.pid, since: now.toISOString() };
  try {
    await db
      .insertInto('live_state')
      .values({ key: PIPELINE_LOCK_STATE_KEY, value: JSON.stringify(hint), updated_at: now })
      .onConflict((oc) =>
        oc.column('key').doUpdateSet({ value: JSON.stringify(hint), updated_at: now }),
      )
      .execute();
  } catch {
    // The hint is only for the refusal message; the lock is held either way.
  }

  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      try {
        await db.deleteFrom('live_state').where('key', '=', PIPELINE_LOCK_STATE_KEY).execute();
      } catch {
        // Nothing to clean up if the table is gone.
      }
      releaseHeld();
      await heldDone.catch(() => undefined);
      await db.destroy().catch(() => undefined);
    },
  };
}
