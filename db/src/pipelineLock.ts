import pg from 'pg';
import { sql, type Kysely } from 'kysely';
import { createDb } from './client.js';
import type { Database } from './types.js';

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
  /** The Postgres backend (session) pid that holds the lock. */
  readonly backendPid: number;
  /**
   * True while this process still holds the lock: the connection is open and the database lists
   * the advisory lock against its session. False once the connection dropped (the database
   * released the lock with it), or when the check itself cannot be made. Never throws.
   */
  isHeld(): Promise<boolean>;
  /** Releases the lock and closes its connection. Safe to call twice, and after a loss. */
  release(): Promise<void>;
}

/** The process lost the lock while it ran: its connection to the database dropped. */
export class PipelineLockLostError extends Error {
  constructor(kind: PipelineProcessKind) {
    super(
      `The pipeline lock was lost: the database connection holding it dropped while the ${kind} run was ` +
        'running, so another pipeline process could now start. This run took no new work, let the jobs ' +
        'in flight finish, and is exiting. Check that no other pipeline process is running, then start it again.',
    );
    this.name = 'PipelineLockLostError';
  }
}

/** How often a runner checks that it still holds the lock (the live process: every scheduler tick). */
export const PIPELINE_LOCK_CHECK_SECONDS = 15;

/** pg_locks lists a bigint advisory key as two int4 halves. */
const LOCK_CLASSID = Math.floor(PIPELINE_LOCK_KEY / 2 ** 32);
const LOCK_OBJID = PIPELINE_LOCK_KEY % 2 ** 32;

/**
 * True when some session holds the pipeline lock. A read of `pg_locks`: it takes nothing, so it
 * works beside the process that holds the lock, and inside a read-only transaction.
 */
export async function isPipelineLockHeld(db: Kysely<Database>): Promise<boolean> {
  const r = await sql<{ held: boolean }>`
    select exists (select 1 from pg_locks
      where locktype = 'advisory'
        and database = (select oid from pg_database where datname = current_database())
        and classid = ${LOCK_CLASSID}::oid
        and objid = ${LOCK_OBJID}::oid and objsubid = 1) as held
  `.execute(db);
  return r.rows[0]?.held === true;
}

/**
 * Takes the lock or throws `PipelineLockError`. The connection that holds it is opened here
 * (a plain `pg` client of its own, never shared) and stays open until `release()`.
 */
export async function acquirePipelineLock(
  connectionString: string,
  kind: PipelineProcessKind,
  opts: { now?: Date; pid?: number } = {},
): Promise<PipelineLock> {
  // One connection holds the lock; a one-connection pool writes and reads the hint row.
  const hintDb = createDb(connectionString, { max: 1 });
  const client = new pg.Client({ connectionString });
  let dropped = false;
  // A dropped connection emits 'error' (or just 'end'); without a listener the first would crash
  // the process. The next `isHeld()` reports it.
  client.on('error', () => {
    dropped = true;
  });
  client.on('end', () => {
    dropped = true;
  });
  const closeAll = async () => {
    await client.end().catch(() => undefined);
    await hintDb.destroy().catch(() => undefined);
  };

  let got: boolean;
  let backendPid: number;
  try {
    await client.connect();
    const r = await client.query<{ ok: boolean; pid: number }>(
      'select pg_try_advisory_lock($1) as ok, pg_backend_pid() as pid',
      [PIPELINE_LOCK_KEY],
    );
    got = r.rows[0]?.ok === true;
    backendPid = Number(r.rows[0]?.pid ?? 0);
  } catch (err) {
    await closeAll();
    throw err;
  }
  if (!got) {
    let holder: PipelineLockHolder | null = null;
    try {
      const row = await hintDb
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
    await closeAll();
    throw new PipelineLockError(kind, holder);
  }

  const now = opts.now ?? new Date();
  const hint = { kind, pid: opts.pid ?? process.pid, since: now.toISOString() };
  try {
    await hintDb
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
    backendPid,
    async isHeld() {
      if (released || dropped) return false;
      try {
        const r = await client.query<{ held: boolean }>(
          `select exists (select 1 from pg_locks
             where locktype = 'advisory' and pid = pg_backend_pid()
               and classid = $1::oid and objid = $2::oid and objsubid = 1) as held`,
          [LOCK_CLASSID, LOCK_OBJID],
        );
        return r.rows[0]?.held === true;
      } catch {
        dropped = true;
        return false;
      }
    },
    async release() {
      if (released) return;
      released = true;
      // After a loss the hint may already be a new holder's: leave it.
      if (!dropped) {
        try {
          await hintDb
            .deleteFrom('live_state')
            .where('key', '=', PIPELINE_LOCK_STATE_KEY)
            .execute();
        } catch {
          // Nothing to clean up if the table is gone.
        }
      }
      // Ending the connection releases the session lock.
      await closeAll();
    },
  };
}
