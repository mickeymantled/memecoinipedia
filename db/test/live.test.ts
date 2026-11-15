import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createRun } from '../src/runs.js';
import { recordUsageSample } from '../src/backfill.js';
import {
  bumpLiveCounters,
  countWatchedByAge,
  getLiveState,
  insertLiveGraduates,
  latestGraduatedAt,
  listWaitingCandles,
  listWatchedDue,
  listWatchedOlderThan,
  setLiveState,
  storeCurrentFigures,
  triggerCandles,
  usageByRunSince,
  usageTotalSince,
  type LiveGraduate,
  type WatchIntervals,
  type WatchSpec,
} from '../src/live.js';
import { acquirePipelineLock, PipelineLockError } from '../src/pipelineLock.js';
import { createTestDatabase, type TestDatabase } from '../src/testing.js';
import { adminUrl, describeDb } from './helpers.js';

const NOW = new Date('2026-11-15T10:00:00Z');
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);
const HOUR = 3600;
const DAY = 86_400;
const W: WatchSpec = { now: NOW, windowSeconds: 14 * DAY };
const INTERVALS: WatchIntervals = {
  freshUnderSeconds: DAY,
  freshEverySeconds: 120,
  midUnderSeconds: 3 * DAY,
  midEverySeconds: 600,
  olderEverySeconds: HOUR,
};
const addr = (i: number): string => `L${String(i).padStart(43, '0')}`;
const grad = (i: number, ageSeconds: number, extra: Partial<LiveGraduate> = {}): LiveGraduate => ({
  address: addr(i),
  ticker: `T${i}`,
  name: `Coin ${i}`,
  launchpad: 'pump.fun',
  launchedAt: ago(ageSeconds + 600),
  creatorWallet: null,
  graduatedAt: ago(ageSeconds),
  ...extra,
});
const OPTS = { chain: 'solana', discoverySource: 'codex-live', now: NOW, dayKey: 'day:2026-11-15' };

describeDb('live state, the watched set and the pipeline lock', () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase(adminUrl!);
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await t.db.deleteFrom('provider_usage_samples').execute();
    await t.db.deleteFrom('provider_usage').execute();
    await t.db.deleteFrom('coin_stages').execute();
    await t.db.deleteFrom('ingest_runs').execute();
    await t.db.deleteFrom('coins').execute();
    await t.db.deleteFrom('live_state').execute();
  });

  const idOf = async (i: number): Promise<number> =>
    (
      await t.db
        .selectFrom('coins')
        .select('id')
        .where('address', '=', addr(i))
        .executeTakeFirstOrThrow()
    ).id;

  it('keeps values by key and adds to counters, creating them as needed', async () => {
    expect(await getLiveState(t.db, 'discovery_cursor')).toBeNull();
    await setLiveState(t.db, 'discovery_cursor', { at: 100 }, NOW);
    await setLiveState(t.db, 'discovery_cursor', { at: 200 }, NOW);
    expect(await getLiveState(t.db, 'discovery_cursor')).toEqual({ at: 200 });
    await bumpLiveCounters(t.db, 'day:x', { found: 3 }, NOW);
    await bumpLiveCounters(t.db, 'day:x', { found: 2, triggered: 1 }, NOW);
    await bumpLiveCounters(t.db, 'day:x', { found: 0 }, NOW);
    expect(await getLiveState(t.db, 'day:x')).toEqual({ found: 5, triggered: 1 });
  });

  it('inserts only coins it does not have, with their facts and a source of their own', async () => {
    const first = await insertLiveGraduates(t.db, [grad(1, 600), grad(2, 700), grad(1, 600)], OPTS);
    expect(first).toEqual({ inserted: 2, seen: 2 });
    const again = await insertLiveGraduates(t.db, [grad(1, 600), grad(3, 100)], OPTS);
    expect(again.inserted).toBe(1);
    const c = await t.db
      .selectFrom('coins')
      .selectAll()
      .where('address', '=', addr(1))
      .executeTakeFirstOrThrow();
    expect(c.discovery_source).toBe('codex-live');
    expect(c.ticker).toBe('T1');
    expect(c.launchpad).toBe('pump.fun');
    expect(c.graduated_at).toEqual(ago(600));
    expect(c.rough_ath_market_cap_usd).toBeNull();
    const stages = await sql<{ n: string }>`
      select count(*)::text as n from coin_stages where stage = 'discovered' and status = 'done'`.execute(
      t.db,
    );
    expect(stages.rows[0]!.n).toBe('3');
    expect(await getLiveState(t.db, OPTS.dayKey)).toEqual({ found: 3 });
  });

  it('stores token text as it comes, without the NUL character Postgres cannot hold', async () => {
    const nasty = `<script>alert(1)</script>'; drop table coins; --\nline\u0000two`;
    await insertLiveGraduates(t.db, [grad(1, 100, { ticker: 'A\u0000B', name: nasty })], OPTS);
    const c = await t.db.selectFrom('coins').select(['ticker', 'name']).executeTakeFirstOrThrow();
    expect(c.ticker).toBe('AB');
    expect(c.name).toBe(nasty.replace('\u0000', ''));
  });

  it('reports the latest graduation', async () => {
    expect(await latestGraduatedAt(t.db)).toBeNull();
    await insertLiveGraduates(t.db, [grad(1, 5000), grad(2, 900)], OPTS);
    expect(await latestGraduatedAt(t.db)).toEqual(ago(900));
  });

  it('watches coins graduated in the window that no candles attempt has touched', async () => {
    await insertLiveGraduates(
      t.db,
      [
        grad(1, 2 * HOUR), // fresh
        grad(2, 2 * DAY), // mid
        grad(3, 5 * DAY), // older
        grad(4, 20 * DAY), // outside the window
        grad(5, 3 * HOUR), // attempted: done
        grad(6, 3 * HOUR), // attempted: failed
        grad(7, 3 * HOUR), // triggered, not yet claimed
        grad(8, 3 * HOUR), // claimed once, then back to pending with no attempts counted
      ],
      OPTS,
    );
    const stage = (i: number, status: string, attempts: number, started: Date | null) =>
      sql`insert into coin_stages (coin_id, stage, status, attempts, started_at, updated_at)
          values (${i}, 'candles', ${status}, ${attempts}, ${started}, ${NOW})`.execute(t.db);
    await stage(await idOf(5), 'done', 1, ago(100));
    await stage(await idOf(6), 'failed', 1, ago(100));
    await stage(await idOf(7), 'pending', 0, null);
    await stage(await idOf(8), 'pending', 0, ago(500));
    const counts = await countWatchedByAge(t.db, W, {
      freshUnderSeconds: DAY,
      midUnderSeconds: 3 * DAY,
    });
    // 1, 2, 3 and the triggered-but-unclaimed 7 are watched; 4 is too old; 5, 6, 8 were attempted.
    expect(counts).toEqual({ fresh: 2, mid: 1, older: 1, total: 4, triggeredWaiting: 1 });
  });

  it('lists the coins whose price is due by their age, never-polled and longest-ago first', async () => {
    await insertLiveGraduates(
      t.db,
      [grad(1, 2 * HOUR), grad(2, 2 * HOUR), grad(3, 2 * DAY), grad(4, 5 * DAY), grad(5, 2 * HOUR)],
      OPTS,
    );
    const set = (i: number, refreshedAgo: number | null) =>
      t.db
        .updateTable('coins')
        .set({ current_refreshed_at: refreshedAgo === null ? null : ago(refreshedAgo) })
        .where('address', '=', addr(i))
        .execute();
    await set(1, 119); // fresh tier: every 120 s, not due
    await set(2, 121); // due
    await set(3, 599); // mid tier: every 600 s, not due
    await set(4, 3599); // older tier: hourly, not due
    await set(5, null); // never polled
    let due = await listWatchedDue(t.db, W, INTERVALS, { limit: 10 });
    expect(due.map((c) => c.address)).toEqual([addr(5), addr(2)]);
    await set(3, 601);
    await set(4, 3601);
    due = await listWatchedDue(t.db, W, INTERVALS, { limit: 10 });
    expect(due.map((c) => c.address)).toEqual([addr(5), addr(4), addr(3), addr(2)]);
    due = await listWatchedDue(t.db, W, INTERVALS, { limit: 2, excludeIds: [await idOf(5)] });
    expect(due.map((c) => c.address)).toEqual([addr(4), addr(3)]);
    expect(due[0]!.totalSupply).toBe(1_000_000_000);
  });

  it('stores current figures for many coins at once', async () => {
    await insertLiveGraduates(t.db, [grad(1, 100), grad(2, 100)], OPTS);
    await storeCurrentFigures(
      t.db,
      [
        {
          id: await idOf(1),
          priceUsd: 0.0001,
          marketCapUsd: 100_000,
          liquidityUsd: 20_000,
          volume24hUsd: 5,
        },
        {
          id: await idOf(2),
          priceUsd: 0.00002,
          marketCapUsd: null,
          liquidityUsd: null,
          volume24hUsd: null,
        },
      ],
      NOW,
    );
    const rows = await t.db
      .selectFrom('coins')
      .select(['address', 'current_price_usd', 'current_market_cap_usd', 'current_refreshed_at'])
      .orderBy('address')
      .execute();
    expect(rows[0]).toMatchObject({ current_price_usd: 0.0001, current_market_cap_usd: 100_000 });
    expect(rows[1]).toMatchObject({ current_price_usd: 0.00002, current_market_cap_usd: null });
    expect(rows[1]!.current_refreshed_at).toEqual(NOW);
  });

  it('triggers a coin once and counts it once; the sweep and the requeue see the same rows', async () => {
    await insertLiveGraduates(
      t.db,
      [grad(1, 30 * HOUR), grad(2, 2 * HOUR), grad(3, 40 * HOUR)],
      OPTS,
    );
    const ids = [await idOf(1), await idOf(2)];
    expect(
      await triggerCandles(t.db, ids, { now: NOW, dayKey: OPTS.dayKey, counter: 'triggered' }),
    ).toEqual(ids);
    expect(
      await triggerCandles(t.db, ids, { now: NOW, dayKey: OPTS.dayKey, counter: 'triggered' }),
    ).toEqual([]);
    expect(await getLiveState(t.db, OPTS.dayKey)).toEqual({ found: 3, triggered: 2 });
    expect(await listWaitingCandles(t.db, { afterId: 0, limit: 10 })).toEqual(ids);
    // A triggered coin stays watched until a worker attempts it.
    const old = await listWatchedOlderThan(t.db, W, DAY, { afterId: 0, limit: 10 });
    expect(old).toEqual([ids[0], await idOf(3)]);
    expect(await listWatchedOlderThan(t.db, W, DAY, { afterId: ids[0]!, limit: 10 })).toEqual([
      await idOf(3),
    ]);
    // Once claimed it is attempted, no longer watched and no longer waiting.
    await sql`update coin_stages set status = 'running', attempts = 1, started_at = ${NOW}
              where coin_id = ${ids[0]!} and stage = 'candles'`.execute(t.db);
    expect(await listWaitingCandles(t.db, { afterId: 0, limit: 10 })).toEqual([ids[1]]);
    expect(await listWatchedOlderThan(t.db, W, DAY, { afterId: 0, limit: 10 })).toEqual([
      await idOf(3),
    ]);
  });

  it('reads a provider day from the usage samples of every run', async () => {
    const midnight = new Date('2026-11-15T00:00:00Z');
    const a = await createRun(t.db, { kind: 'backfill' });
    const b = await createRun(t.db, { kind: 'live' });
    const c = await createRun(t.db, { kind: 'backfill' });
    const sample = (run: number, at: Date, requests: number, units: number) =>
      recordUsageSample(t.db, run, { provider: 'codex', requests, units }, at);
    // Run a started yesterday: 1,000 units before midnight, 1,300 now (300 today).
    await sample(a, new Date('2026-11-14T23:00:00Z'), 100, 1000);
    await sample(a, new Date('2026-11-15T09:00:00Z'), 130, 1300);
    // Run b started today: 50 units.
    await sample(b, new Date('2026-11-15T08:00:00Z'), 10, 50);
    // Run c finished yesterday: nothing today.
    await sample(c, new Date('2026-11-14T12:00:00Z'), 999, 9999);
    const rows = await usageByRunSince(t.db, 'codex', midnight, NOW);
    expect(rows.sort((x, y) => x.runId - y.runId)).toEqual([
      { runId: a, latest: 1300, before: 1000 },
      { runId: b, latest: 50, before: 0 },
    ]);
    expect(await usageTotalSince(t.db, 'codex', midnight, NOW)).toEqual({
      requests: 40,
      units: 350,
    });
    expect(await usageTotalSince(t.db, 'helius', midnight, NOW)).toEqual({ requests: 0, units: 0 });
  });

  it('lets one process hold the pipeline lock and names it to the second', async () => {
    const first = await acquirePipelineLock(t.url, 'backfill', { now: NOW, pid: 4242 });
    try {
      const err = await acquirePipelineLock(t.url, 'live').then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(PipelineLockError);
      expect((err as PipelineLockError).message).toMatch(/Cannot start a live run/);
      expect((err as PipelineLockError).message).toMatch(/`backfill run`.*pid 4242/);
      expect((err as PipelineLockError).holder).toMatchObject({ kind: 'backfill', pid: 4242 });
    } finally {
      await first.release();
    }
    // Released: the next one gets it, and the hint is gone when it lets go.
    const second = await acquirePipelineLock(t.url, 'live');
    expect(await getLiveState(t.db, 'pipeline_lock')).toMatchObject({ kind: 'live' });
    await second.release();
    await second.release();
    expect(await getLiveState(t.db, 'pipeline_lock')).toBeNull();
  });

  it('says only that another process runs when there is no hint', async () => {
    const first = await acquirePipelineLock(t.url, 'live');
    await t.db.deleteFrom('live_state').execute();
    try {
      await expect(acquirePipelineLock(t.url, 'backfill')).rejects.toThrow(
        /another pipeline process \(a backfill run or a live run\) is running/,
      );
    } finally {
      await first.release();
    }
  });
});
