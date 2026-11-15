/**
 * The process around the loops: the one-process-per-database lock in both directions, the dry run,
 * and `runLive` itself with the real queue worker. No provider request.
 */
import {
  acquirePipelineLock,
  createReadOnlyDb,
  getLiveState,
  PipelineLockError,
} from '@memecoinipedia/db';
import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import { runBackfill } from '../../src/backfill/run.js';
import { STATE_SETTINGS } from '../../src/live/constants.js';
import { formatLivePlan, predictLoad } from '../../src/live/plan.js';
import { runLive, type LiveOptions } from '../../src/live/run.js';
import { seededDatabase, type Fixture } from '../backfill/helpers.js';
import { captureLog, describeDb, liveFixture, worldCoin, type LiveFixture } from './helpers.js';

let fx: LiveFixture | undefined;
let seeded: Fixture | undefined;
afterEach(async () => {
  await fx?.cleanup();
  await seeded?.cleanup();
  fx = undefined;
  seeded = undefined;
});

/** Options for `runLive` on the fixture's database and simulated clients. */
function liveOptions(
  f: LiveFixture,
  over: Partial<LiveOptions> = {},
): LiveOptions & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    confirm: true,
    env: { DATABASE_URL: f.t.url },
    log: captureLog().log,
    out: (t) => lines.push(t),
    db: f.db,
    clients: f.clients,
    tickSeconds: 0.01,
    maxTicks: 1,
    ...over,
  };
}

describeDb('one pipeline process per database', () => {
  it('live run refuses to start while backfill run holds the lock, and says which', async () => {
    fx = await liveFixture();
    const f = fx;
    const held = await acquirePipelineLock(f.t.url, 'backfill', { pid: 777 });
    try {
      const o = liveOptions(f);
      const err = await runLive(o).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(PipelineLockError);
      expect((err as Error).message).toMatch(
        /Cannot start a live run: a `backfill run` process appears to hold it \(pid 777/,
      );
      // Nothing was started: no run row, no request.
      const runs = await sql<{
        n: string;
      }>`select count(*)::text as n from ingest_runs where kind = 'live' and id <> ${f.runId}`.execute(
        f.db,
      );
      expect(runs.rows[0]!.n).toBe('0');
      expect(f.world.stats.filterRequests).toBe(0);
    } finally {
      await held.release();
    }
  });

  it('backfill run refuses to start while live run holds the lock', async () => {
    seeded = await seededDatabase(60);
    const f = seeded;
    const held = await acquirePipelineLock(f.t.url, 'live', { pid: 888 });
    try {
      await expect(
        runBackfill({
          selection: {
            chain: 'solana',
            minRoughPeakUsd: 30_000,
            includeNoPrice: false,
            order: 'hash',
            limit: null,
          },
          codexRps: 10_000,
          maxCodexUnits: 1_000_000,
          confirm: true,
          env: { DATABASE_URL: f.t.url },
          log: captureLog().log,
          out: () => {},
          db: f.t.db,
        }),
      ).rejects.toThrow(
        /Cannot start a backfill run: a `live run` process appears to hold it \(pid 888/,
      );
    } finally {
      await held.release();
    }
  });

  it('a dry run of either takes no lock', async () => {
    fx = await liveFixture();
    const f = fx;
    const held = await acquirePipelineLock(f.t.url, 'backfill');
    try {
      const o = liveOptions(f, { confirm: false });
      const report = await runLive(o);
      expect(report.status).toBe('dry_run');
    } finally {
      await held.release();
    }
  });

  it('runs on the real queue worker, holds the lock while it runs and releases it when it stops', async () => {
    fx = await liveFixture();
    const f = fx;
    // One coin already known and over the line: the first tick triggers it.
    const c = worldCoin(5, f.clock.sec - 600, () => 120_000);
    f.world.add(c);
    await f.db
      .insertInto('coins')
      .values({ chain: 'solana', address: c.mint, graduated_at: new Date(c.migratedAt * 1000) })
      .execute();
    await f.db
      .insertInto('coin_stages')
      .values({ coin_id: 1, stage: 'discovered', status: 'done' })
      .execute();
    const o = liveOptions(f, { now: f.clock.now, maxCodexUnitsPerDay: 5_000 });
    const report = await runLive(o);
    expect(report.status).toBe('stopped');
    expect(report.ticks).toBe(1);
    const run = await f.db
      .selectFrom('ingest_runs')
      .selectAll()
      .where('id', '=', report.runId!)
      .executeTakeFirstOrThrow();
    expect(run.kind).toBe('live');
    expect(run.status).toBe('stopped');
    expect(await getLiveState(f.db, STATE_SETTINGS)).toMatchObject({ maxCodexUnitsPerDay: 5_000 });
    // The tick ran: the coin was triggered, and a stage row for it exists.
    const stage = await sql<{
      status: string;
    }>`select status from coin_stages where coin_id = 1 and stage = 'candles'`.execute(f.db);
    expect(stage.rows).toHaveLength(1);
    // Usage was recorded for the run (the first start looked at discovery).
    const usage = await sql<{
      requests: number;
    }>`select requests from provider_usage where run_id = ${report.runId!} and provider = 'codex'`.execute(
      f.db,
    );
    expect(usage.rows[0]!.requests).toBeGreaterThan(0);
    // The lock is free again.
    const again = await acquirePipelineLock(f.t.url, 'backfill');
    await again.release();
    expect(o.lines.join('\n')).toMatch(/Live status at/);
  }, 120_000);

  it('rejects a ceiling that is not a positive number: it is always in force', async () => {
    fx = await liveFixture();
    for (const bad of [0, -5, Number.NaN]) {
      await expect(
        runLive(liveOptions(fx, { confirm: false, maxCodexUnitsPerDay: bad })),
      ).rejects.toThrow(/--max-codex-units-per-day must be a positive number/);
    }
  });
});

describeDb('the dry run', () => {
  it('prints the plan, makes no request to any provider, and writes nothing', async () => {
    fx = await liveFixture();
    const f = fx;
    // Some watched coins in each age tier.
    const now = f.clock.ms;
    for (const [i, age] of [
      [1, 3600],
      [2, 2 * 3600],
      [3, 2 * 86_400],
      [4, 6 * 86_400],
      [5, 7 * 86_400],
    ] as const) {
      await f.db
        .insertInto('coins')
        .values({
          chain: 'solana',
          address: `D${i}`.padEnd(44, 'x'),
          graduated_at: new Date(now - age * 1000),
        })
        .execute();
    }
    const before = await sql<{ n: string }>`
      select (select count(*) from coins)::text || '/' || (select count(*) from coin_stages)::text || '/' ||
             (select count(*) from live_state)::text || '/' || (select count(*) from ingest_runs)::text as n`.execute(
      f.db,
    );
    // Through a connection that cannot write.
    const ro = createReadOnlyDb(f.t.url);
    try {
      const o = liveOptions(f, { confirm: false, db: ro, graduatesPerDay: 1_000 });
      const report = await runLive(o);
      expect(report.status).toBe('dry_run');
      expect(report.runId).toBeNull();
      const text = o.lines.join('\n');
      expect(text).toMatch(/Live plan \(dry run\): no request to any provider, nothing written\./);
      expect(text).toMatch(
        /Watched coins now: 5 \(under 24 hours 2, 1 to 3 days 1, 3 to 14 days 2\)/,
      );
      expect(text).toMatch(/Expected load for 1,000 graduates a day \(given\)/);
      expect(text).toMatch(/Codex\.io\s+[\d,]+ requests, [\d,]+ compute units a day/);
      expect(text).toMatch(/Jupiter\s+[\d,]+ requests a day/);
      expect(text).toMatch(
        /ceiling is 40,000 Codex\.io units a UTC day: the expectation is within it/,
      );
      expect(text).toMatch(/Add --confirm to run\./);
    } finally {
      await ro.destroy();
    }
    expect(f.world.stats.filterRequests + f.world.stats.otherRequests).toBe(0);
    expect(f.jupiter.requests).toBe(0);
    expect(f.codex.spend().requests).toBe(0);
    const after = await sql<{ n: string }>`
      select (select count(*) from coins)::text || '/' || (select count(*) from coin_stages)::text || '/' ||
             (select count(*) from live_state)::text || '/' || (select count(*) from ingest_runs)::text as n`.execute(
      f.db,
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it("assumes a day's volume when the database has none", async () => {
    fx = await liveFixture();
    const o = liveOptions(fx, { confirm: false });
    await runLive(o);
    expect(o.lines.join('\n')).toMatch(/no coins; a first start begins at the current time/);
    expect(o.lines.join('\n')).toMatch(
      /1,000 graduates a day \(assumed: none in the database in the last 24 hours\)/,
    );
  });
});

describe('the load model', () => {
  it('predicts the requests and units a day for 1,000 graduates a day', () => {
    const l = predictLoad({ graduatesPerDay: 1_000 });
    // Discovery: 288 passes a day, one request each (about 24 rows a pass).
    expect(l.codex.discoveryRequests).toBe(288);
    expect(l.codex.discoveryUnits).toBeGreaterThan(1_400);
    expect(l.codex.discoveryUnits).toBeLessThan(1_600);
    // First candle fetches: 300 triggered at 23.2 units and 700 screened at 13.5.
    expect(l.codex.candlesUnits).toBe(Math.round(300 * 23.2 + 700 * 13.5));
    // Last looks: every graduate. The 700 that do not list cost one request (4 units); the 300
    // that list cost a later trigger's worth (12 units).
    expect(l.codex.lastLookUnits).toBe(700 * 4 + 300 * 12);
    // Later triggers: one a triggered coin, 12 units each.
    expect(l.codex.laterUnits).toBe(300 * 12);
    // The parts are rounded one by one: the total is their sum to within the rounding.
    expect(
      Math.abs(
        l.codex.units -
          (l.codex.discoveryUnits +
            l.codex.sweepUnits +
            l.codex.candlesUnits +
            l.codex.lastLookUnits +
            l.codex.laterUnits),
      ),
    ).toBeLessThanOrEqual(3);
    // Well inside the 40,000 ceiling, and Jupiter far under its 1 request a second.
    expect(l.codex.units).toBeLessThan(40_000);
    expect(l.codex.units).toBeGreaterThan(15_000);
    // Every coin is watched for 14 days: 1,000 + 2,000 + 11,000 coins, 5 requests a 30 s pass.
    expect(l.watched).toEqual({ fresh: 1_000, mid: 2_000, older: 11_000 });
    expect(l.jupiter.watchRequests).toBe(14_400);
    expect(l.jupiter.requests).toBeLessThan(86_400);
    // Every figure scales with graduates a day.
    const double = predictLoad({ graduatesPerDay: 2_000 });
    expect(double.codex.candlesUnits).toBe(2 * l.codex.candlesUnits);
    expect(double.codex.lastLookUnits).toBe(2 * l.codex.lastLookUnits);
    expect(formatLivePlan).toBeTypeOf('function');
  });
});
