/**
 * `live health` against a throwaway database, with a fake clock: each alert fires from rows the
 * live process writes, and stays quiet just inside its limit. The lock is a real advisory lock
 * held on another connection. Nothing waits on real time and no provider is reached.
 */
import {
  acquirePipelineLock,
  createRun,
  recordUsageSample,
  setLiveState,
  startRun,
  type PipelineLock,
} from '@memecoinipedia/db';
import { createTestDatabase, type TestDatabase } from '@memecoinipedia/db/testing';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  DEFAULT_HEALTH_LIMITS as L,
  runHealth,
  type HealthCheck,
  type HealthReport,
} from '../../src/live/health.js';
import {
  STATE_LAST_DISCOVERY,
  STATE_LAST_WATCH,
  STATE_REFRESH,
  STATE_SETTINGS,
} from '../../src/live/constants.js';
import { adminUrl, describeDb, FakeClock } from './helpers.js';

let t: TestDatabase;
let lock: PipelineLock | undefined;
const clock = new FakeClock(Date.parse('2026-11-16T12:00:00.000Z'));
const now = () => clock.now();
const ago = (seconds: number): Date => new Date(clock.ms - seconds * 1000);
let runId = 0;
let n = 0;

async function reset(): Promise<void> {
  await sql`truncate coins, ingest_runs, live_state, provider_usage, provider_usage_samples restart identity cascade`.execute(
    t.db,
  );
}

/** A healthy database at the clock's now: a live run with a fresh heartbeat, discovery, a priced watched coin. */
async function healthyWorld(): Promise<void> {
  clock.set('2026-11-16T12:00:00.000Z');
  runId = await createRun(t.db, { kind: 'live', params: {} });
  await startRun(t.db, runId, ago(3600));
  await setLiveState(t.db, STATE_SETTINGS, { maxCodexUnitsPerDay: 1000, runId }, ago(3600));
  await recordUsageSample(t.db, runId, { provider: 'codex', requests: 1, units: 100 }, ago(10));
  await setLiveState(
    t.db,
    STATE_LAST_DISCOVERY,
    { at: ago(60).toISOString(), status: 'ok', found: 0 },
    ago(60),
  );
  await setLiveState(
    t.db,
    STATE_REFRESH,
    { day: 'day:2026-11-16', done: false, afterId: 0 },
    ago(60),
  );
  await watchedCoin({ priced: 30 });
  await setLastWatch(30, 30);
}

/** The loop's own record: when the last pass ended and when the last clean one did (seconds ago). */
async function setLastWatch(endedAgo: number, okAgo: number | null): Promise<void> {
  await setLiveState(
    t.db,
    STATE_LAST_WATCH,
    { endedAt: ago(endedAgo).toISOString(), okAt: okAgo === null ? null : ago(okAgo).toISOString() },
    ago(endedAgo),
  );
}

async function watchedCoin(o: { priced: number | null; graduated?: number }): Promise<number> {
  const r = await t.db
    .insertInto('coins')
    .values({
      chain: 'solana',
      address: `W${++n}`,
      graduated_at: ago(o.graduated ?? 3600),
      current_refreshed_at: o.priced === null ? null : ago(o.priced),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return r.id;
}

async function stageRow(
  coinId: number,
  o: {
    stage?: 'candles' | 'metrics' | 'metadata' | 'metadata_file';
    status: 'pending' | 'running' | 'done' | 'failed';
    startedAt?: Date;
    finishedAt?: Date;
    updatedAt?: Date;
    error?: string;
  },
): Promise<void> {
  await t.db
    .insertInto('coin_stages')
    .values({
      coin_id: coinId,
      stage: o.stage ?? 'candles',
      status: o.status,
      started_at: o.startedAt ?? null,
      finished_at: o.finishedAt ?? null,
      updated_at: o.updatedAt ?? now(),
      last_error: o.error ?? null,
    })
    .execute();
}

async function plainCoin(): Promise<number> {
  const r = await t.db
    .insertInto('coins')
    .values({ chain: 'solana', address: `P${++n}` })
    .returning('id')
    .executeTakeFirstOrThrow();
  return r.id;
}

const check = (r: HealthReport, name: string): HealthCheck => {
  const c = r.checks.find((x) => x.name === name);
  if (!c) throw new Error(`no check ${name}: ${r.checks.map((x) => x.name).join(', ')}`);
  return c;
};
const health = (opts = {}) => runHealth(t.db, now(), L, opts);

async function holdLock(kind: 'live' | 'backfill' = 'live'): Promise<void> {
  lock = await acquirePipelineLock(t.url, kind);
}

describeDb('live health on a throwaway database', () => {
  beforeAll(async () => {
    t = await createTestDatabase(adminUrl!);
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    await reset();
  });
  afterEach(async () => {
    await lock?.release();
    lock = undefined;
  });

  it('a healthy database gives no alert and no warn', async () => {
    await healthyWorld();
    await holdLock();
    const r = await health();
    expect(r.checks.filter((c) => c.level !== 'ok')).toEqual([]);
    expect(r.status).toBe('ok');
  });

  it('a database the live process never ran in says so, as a warn', async () => {
    const r = await health();
    expect(r.checks).toHaveLength(1);
    expect(r.checks[0]).toMatchObject({ name: 'process', level: 'warn' });
    expect(r.status).toBe('warn');
  });

  // ---------------------------------------------------------------- 1. process
  it('process: alerts with no lock held; quiet with the lock and a fresh heartbeat', async () => {
    await healthyWorld();
    expect(check(await health(), 'process').level).toBe('alert');
    await holdLock();
    expect(check(await health(), 'process').level).toBe('ok');
  });

  it('process: a heartbeat just inside the alert limit does not alert, one past it does', async () => {
    await healthyWorld();
    await holdLock();
    await t.db.deleteFrom('provider_usage_samples').execute();
    await recordUsageSample(
      t.db,
      runId,
      { provider: 'codex', requests: 1, units: 1 },
      ago(L.heartbeatAlertSeconds - 5),
    );
    expect(check(await health(), 'process').level).toBe('warn');
    await recordUsageSample(
      t.db,
      runId,
      { provider: 'jupiter', requests: 1, units: 0 },
      ago(L.heartbeatAlertSeconds - 5),
    );
    clock.advance(10_000);
    expect(check(await health(), 'process').level).toBe('alert');
  });

  it('process: a backfill holding the lock is a warn', async () => {
    await healthyWorld();
    await holdLock('backfill');
    expect(check(await health(), 'process').level).toBe('warn');
  });

  // -------------------------------------------------------------- 2. discovery
  it('discovery: alerts past the limit, quiet just inside it', async () => {
    await healthyWorld();
    await holdLock();
    const set = (age: number) =>
      setLiveState(
        t.db,
        STATE_LAST_DISCOVERY,
        { at: ago(age).toISOString(), status: 'ok', found: 0 },
        ago(age),
      );
    await set(L.discoveryAlertSeconds - 1);
    expect(check(await health(), 'discovery').level).toBe('warn');
    await set(L.discoveryAlertSeconds);
    expect(check(await health(), 'discovery').level).toBe('alert');
  });

  // ------------------------------------------------------------- 3. watch loop
  it('watch: alerts when the last pass ended long ago, quiet just inside', async () => {
    await healthyWorld();
    await holdLock();
    await setLastWatch(L.watchPassAlertSeconds - 1, 30);
    expect(check(await health(), 'watch').level).toBe('warn');
    await setLastWatch(L.watchPassAlertSeconds, 30);
    expect(check(await health(), 'watch').level).toBe('alert');
    await setLastWatch(L.watchPassWarnSeconds - 1, 30);
    expect(check(await health(), 'watch').level).toBe('ok');
    await setLastWatch(L.watchPassWarnSeconds, 30);
    expect(check(await health(), 'watch').level).toBe('warn');
  });

  it('watch:prices: alerts when only failed passes ended lately, quiet just inside', async () => {
    await healthyWorld();
    await holdLock();
    const limit = L.watchAlertIntervals * 600; // a coin under 3 days old is watched
    // The loop runs (last pass 10 s ago) but no pass has gone without a failed request.
    await setLastWatch(10, limit - 1);
    let r = await health();
    expect(check(r, 'watch').level).toBe('ok');
    expect(check(r, 'watch:prices').level).toBe('warn');
    await setLastWatch(10, limit);
    r = await health();
    expect(check(r, 'watch').level).toBe('ok');
    expect(check(r, 'watch:prices').level).toBe('alert');
    await setLastWatch(10, L.watchWarnIntervals * 600 - 1);
    expect(check(await health(), 'watch:prices').level).toBe('ok');
  });

  it('watch: a loop that stopped is told apart from Jupiter not answering', async () => {
    await healthyWorld();
    await holdLock();
    // Stopped: both lines old.
    await setLastWatch(L.watchPassAlertSeconds, L.watchPassAlertSeconds);
    let r = await health();
    expect(check(r, 'watch').level).toBe('alert');
    expect(check(r, 'watch').figure).toContain('last pass ended');
    // Running but failing: the first line is quiet, the second alerts.
    await setLastWatch(5, L.watchAlertIntervals * 600);
    r = await health();
    expect(check(r, 'watch').level).toBe('ok');
    expect(check(r, 'watch:prices').level).toBe('alert');
  });

  it('watch: before the first write it is a warn, and a pass with nothing due still writes it', async () => {
    await healthyWorld();
    await holdLock();
    await t.db.deleteFrom('live_state').where('key', '=', STATE_LAST_WATCH).execute();
    const r = await health();
    expect(check(r, 'watch').level).toBe('warn');
    expect(check(r, 'watch').figure).toContain('no watch pass recorded yet');
    expect(r.checks.find((c) => c.name === 'watch:prices')).toBeUndefined();
    expect(r.status).toBe('warn');
  });

  it('watch: a record left by an earlier process counts from this run start', async () => {
    await healthyWorld(); // the run started 3600 s ago
    await holdLock();
    await t.db
      .updateTable('ingest_runs')
      .set({ started_at: ago(5) })
      .execute();
    await setLastWatch(3000, 3000);
    const c = check(await health(), 'watch');
    expect(c.level).toBe('ok');
    expect(c.figure).toContain('no watch pass in this run yet');
  });

  // --------------------------------------------------------- 4. stalled queue
  it('queue: a stage running past twice its timeout alerts, just inside does not', async () => {
    await healthyWorld();
    await holdLock();
    const id = await plainCoin();
    await stageRow(id, { status: 'running', startedAt: ago(2 * 600 - 1) });
    expect(check(await health(), 'queue:candles:running').level).toBe('warn');
    await t.db
      .updateTable('coin_stages')
      .set({ started_at: ago(2 * 600) })
      .execute();
    expect(check(await health(), 'queue:candles:running').level).toBe('alert');
  });

  it('queue: waiting work with nothing finishing alerts; quiet just inside, and quiet while work finishes', async () => {
    await healthyWorld();
    await holdLock();
    const waiting = await watchedCoin({ priced: 30 });
    const done = await plainCoin();
    await stageRow(waiting, { status: 'pending', updatedAt: ago(L.waitingAlertSeconds) });
    await stageRow(done, {
      status: 'done',
      startedAt: ago(L.waitingAlertSeconds + 100),
      finishedAt: ago(L.waitingAlertSeconds - 1),
    });
    expect(check(await health(), 'queue:candles:waiting').level).toBe('warn');
    await t.db
      .updateTable('coin_stages')
      .set({ finished_at: ago(L.waitingAlertSeconds) })
      .where('status', '=', 'done')
      .execute();
    expect(check(await health(), 'queue:candles:waiting').level).toBe('alert');
    await t.db
      .updateTable('coin_stages')
      .set({ finished_at: ago(5) })
      .where('status', '=', 'done')
      .execute();
    expect(check(await health(), 'queue:candles:waiting').level).toBe('ok');
  });

  // ------------------------------------------------------------- 5. failures
  it('failures: alerts at the count and share; one fewer does not', async () => {
    await healthyWorld();
    await holdLock();
    const mk = async (failed: number, done: number) => {
      await t.db.deleteFrom('coin_stages').execute();
      for (let i = 0; i < failed; i++)
        await stageRow(await plainCoin(), {
          status: 'failed',
          finishedAt: ago(3600),
          error: 'price_error: token 123 has no price',
        });
      for (let i = 0; i < done; i++)
        await stageRow(await plainCoin(), { status: 'done', finishedAt: ago(3600) });
    };
    await mk(L.failureAlertCount, 20);
    expect(check(await health(), 'failures:candles:price_error').level).toBe('alert');
    await mk(L.failureAlertCount - 1, 20);
    expect(check(await health(), 'failures:candles:price_error').level).toBe('warn');
    // Failures older than 24 hours are not counted.
    await t.db
      .updateTable('coin_stages')
      .set({ finished_at: ago(25 * 3600) })
      .execute();
    expect(check(await health(), 'failures').level).toBe('ok');
  });

  // ------------------------------------------------------------- 6. providers
  it('providers: Codex.io units against the day ceiling alert at 95 percent, not just under', async () => {
    await healthyWorld();
    await holdLock();
    await t.db.deleteFrom('provider_usage_samples').execute();
    await recordUsageSample(t.db, runId, { provider: 'codex', requests: 9, units: 949 }, ago(5));
    expect(check(await health(), 'provider:codex:day').level).toBe('warn');
    await recordUsageSample(t.db, runId, { provider: 'codex', requests: 10, units: 950 }, ago(4));
    expect(check(await health(), 'provider:codex:day').level).toBe('alert');
  });

  it('providers: the month check runs only with an allowance', async () => {
    await healthyWorld();
    await holdLock();
    await t.db.deleteFrom('provider_usage_samples').execute();
    await recordUsageSample(t.db, runId, { provider: 'codex', requests: 9, units: 960 }, ago(5));
    expect((await health()).checks.map((c) => c.name)).not.toContain('provider:codex:month');
    expect(check(await health({ monthlyCodexUnits: 1000 }), 'provider:codex:month').level).toBe(
      'alert',
    );
    expect(check(await health({ monthlyCodexUnits: 1100 }), 'provider:codex:month').level).toBe(
      'warn',
    );
  });

  it('providers: Jupiter pauses are read by their provider name, when that row exists', async () => {
    await healthyWorld();
    await holdLock();
    expect((await health()).checks.map((c) => c.name)).not.toContain('provider:jupiter:pauses');
    await t.db
      .insertInto('provider_usage')
      .values({
        run_id: runId,
        provider: 'jupiter_pause',
        requests: L.jupiterPauseAlert - 1,
        units: 0,
      })
      .execute();
    await recordUsageSample(
      t.db,
      runId,
      { provider: 'jupiter_pause', requests: L.jupiterPauseAlert - 1, units: 0 },
      ago(5),
    );
    expect(check(await health(), 'provider:jupiter:pauses').level).toBe('warn');
    await recordUsageSample(
      t.db,
      runId,
      { provider: 'jupiter_pause', requests: L.jupiterPauseAlert, units: 0 },
      ago(4),
    );
    expect(check(await health(), 'provider:jupiter:pauses').level).toBe('alert');
  });

  // --------------------------------------------------------- 7. daily refresh
  it("refresh: alerts when yesterday's did not finish, quiet when it did", async () => {
    await healthyWorld();
    await holdLock();
    clock.set('2026-11-16T00:30:00.000Z');
    // Re-time the rows so nothing else alerts at the new time.
    await setLastWatch(30, 30);
    await setLiveState(
      t.db,
      STATE_LAST_DISCOVERY,
      { at: ago(60).toISOString(), status: 'ok', found: 0 },
      ago(60),
    );
    await recordUsageSample(t.db, runId, { provider: 'codex', requests: 2, units: 101 }, ago(5));
    await setLiveState(t.db, STATE_REFRESH, { day: 'day:2026-11-15', done: false }, ago(3600));
    expect(check(await health(), 'refresh:yesterday').level).toBe('alert');
    await setLiveState(t.db, STATE_REFRESH, { day: 'day:2026-11-15', done: true }, ago(3600));
    const r = await health();
    expect(check(r, 'refresh:yesterday').level).toBe('ok');
    expect(check(r, 'refresh:today').level).toBe('ok'); // not yet 01:00 UTC
  });

  it("refresh: alerts when today's has not started by the hour, quiet one minute before", async () => {
    await healthyWorld();
    await holdLock();
    const retime = async (iso: string) => {
      clock.set(iso);
      await setLastWatch(30, 30);
      await recordUsageSample(t.db, runId, { provider: 'codex', requests: 2, units: 101 }, ago(5));
      await setLiveState(
        t.db,
        STATE_LAST_DISCOVERY,
        { at: ago(60).toISOString(), status: 'ok', found: 0 },
        ago(60),
      );
    };
    await setLiveState(t.db, STATE_REFRESH, { day: 'day:2026-11-15', done: true }, now());
    await retime('2026-11-16T00:59:00.000Z');
    expect(check(await health(), 'refresh:today').level).toBe('ok');
    await retime('2026-11-16T01:00:00.000Z');
    expect(check(await health(), 'refresh:today').level).toBe('alert');
  });

  // -------------------------------------------------- read-only, lock-free
  async function fingerprint(): Promise<Record<string, { rows: number; hash: string }>> {
    const tables = await sql<{ table_name: string }>`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`.execute(
      t.db,
    );
    const out: Record<string, { rows: number; hash: string }> = {};
    for (const { table_name } of tables.rows) {
      const r = await sql<{ rows: string; hash: string | null }>`
        select count(*)::text as rows,
               md5(coalesce(string_agg(x::text, '|' order by x::text), '')) as hash
        from ${sql.table(table_name)} x`.execute(t.db);
      out[table_name] = { rows: Number(r.rows[0]!.rows), hash: r.rows[0]!.hash ?? '' };
    }
    return out;
  }

  it('writes nothing in any table, and works while another connection holds the pipeline lock', async () => {
    await healthyWorld();
    await holdLock();
    await stageRow(await watchedCoin({ priced: 30 }), { status: 'pending', updatedAt: ago(100) });
    const before = await fingerprint();
    expect(Object.keys(before).length).toBeGreaterThan(10);
    const r = await health({ monthlyCodexUnits: 5000 });
    expect(r.checks.length).toBeGreaterThan(8);
    expect(check(r, 'process').figure).toContain('holds the lock');
    expect(await fingerprint()).toEqual(before);
    // The lock is still held by the other connection, and was never taken or released by health.
    const held = await sql<{
      n: string;
    }>`select count(*)::text as n from pg_locks where locktype = 'advisory' and database = (select oid from pg_database where datname = current_database())`.execute(
      t.db,
    );
    expect(Number(held.rows[0]!.n)).toBe(1);
  });

  it('the transaction is read-only: a write inside it is refused by the database', async () => {
    await expect(
      t.db
        .transaction()
        .setAccessMode('read only')
        .execute((trx) =>
          trx
            .insertInto('live_state')
            .values({ key: 'x', value: JSON.stringify({}), updated_at: new Date() })
            .execute(),
        ),
    ).rejects.toThrow(/read-only/);
  });
});

// -------------------------------------------------------------- the command
const run = promisify(execFile);
const TSX = fileURLToPath(new URL('../../node_modules/.bin/tsx', import.meta.url));
const SCRIPT = fileURLToPath(new URL('../../scripts/live.ts', import.meta.url));

async function cli(args: string[], env: Record<string, string> = {}) {
  try {
    const r = await run(TSX, [SCRIPT, ...args], {
      env: { PATH: process.env['PATH'] ?? '', USER: process.env['USER'] ?? '', ...env },
      timeout: 60_000,
    });
    return { code: 0, out: r.stdout, err: r.stderr };
  } catch (e) {
    const x = e as { code: number; stdout: string; stderr: string };
    return { code: x.code, out: x.stdout, err: x.stderr };
  }
}

it('live.ts --help lists health', async () => {
  const r = await cli(['--help']);
  expect(r.code).toBe(0);
  expect(r.err).toContain('live.ts health');
});

it('health without DATABASE_URL is a usage error, exit 2', async () => {
  const r = await cli(['health']);
  expect(r.code).toBe(2);
  expect(r.err).toContain('DATABASE_URL is not set');
});

it('health with an unknown limit is a usage error, exit 2', async () => {
  const r = await cli(['health', '--limit', 'nope=1'], { DATABASE_URL: 'postgres://localhost/x' });
  expect(r.code).toBe(2);
  expect(r.err).toContain('unknown limit');
});

describeDb('live.ts health, as a process', () => {
  let c: TestDatabase;
  beforeAll(async () => {
    c = await createTestDatabase(adminUrl!);
  }, 60_000);
  afterAll(async () => {
    await c?.drop();
  });

  it('prints the never-run line and exits 0; --json prints one object', async () => {
    const r = await cli(['health'], { DATABASE_URL: c.url });
    expect(r.code).toBe(0);
    expect(r.out).toContain('warn  process: the live process has never run');
    const j = await cli(['health', '--json'], { DATABASE_URL: c.url });
    const obj = JSON.parse(j.out) as { status: string; checks: unknown[] };
    expect(obj.status).toBe('warn');
    expect(obj.checks).toHaveLength(1);
  });

  it('exits 1 when a check alerts, and 2 for a database it cannot reach', async () => {
    const id = await createRun(c.db, { kind: 'live', params: {} });
    await startRun(c.db, id, new Date(Date.now() - 3 * 3600 * 1000));
    const r = await cli(['health'], { DATABASE_URL: c.url });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/alert process: no process holds the pipeline lock/);
    const dead = new URL(c.url);
    dead.port = '1';
    const bad = await cli(['health'], { DATABASE_URL: dead.toString() });
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('cannot read the database');
    expect(bad.err).not.toContain('migrate');
  });
});

describeDb('live.ts health on a database that is behind on migrations', () => {
  it('says migrations are behind, names the migrate command, and exits 2', async () => {
    const bare = await createTestDatabase(adminUrl!, { migrate: false });
    try {
      const r = await cli(['health'], { DATABASE_URL: bare.url });
      expect(r.code).toBe(2);
      expect(r.err).toContain('cannot read the database');
      expect(r.err).toContain('migrations have not all been applied');
      expect(r.err).toContain('pnpm --filter @memecoinipedia/db migrate');
    } finally {
      await bare.drop();
    }
  }, 60_000);
});
