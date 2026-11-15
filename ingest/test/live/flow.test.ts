/**
 * The live loops end to end on a throwaway database, a simulated Codex.io and Jupiter, and a
 * clock the test moves by hand. No provider request, no real waiting: passes are called directly
 * (through `LiveLoop.tick`) and the stages are executed directly (`LiveFixture.drain`).
 */
import {
  createReadOnlyDb,
  getLiveState,
  insertLiveGraduates,
  setLiveState,
} from '@memecoinipedia/db';
import { sql } from 'kysely';
import { afterEach, expect, it } from 'vitest';
import { STATE_DISCOVERY_CURSOR, STATE_LAST_SWEEP, dayKey } from '../../src/live/constants.js';
import { discoverOnce } from '../../src/live/discover.js';
import { LiveLoop } from '../../src/live/loop.js';
import { collectLiveStatus, formatLiveStatus } from '../../src/live/status.js';
import { DAY_MS, describeDb, liveFixture, worldCoin, type LiveFixture } from './helpers.js';

let fx: LiveFixture | undefined;
afterEach(async () => {
  await fx?.cleanup();
  fx = undefined;
});

const MIN = 60;

/** The sweep counts as done for the fixture's UTC day, so a tick does not start one. */
async function sweepDoneToday(f: LiveFixture): Promise<void> {
  await setLiveState(
    f.db,
    STATE_LAST_SWEEP,
    { at: f.clock.now().toISOString(), found: 0, queued: 0 },
    f.clock.now(),
  );
}

async function addKnownCoin(f: LiveFixture, ageSeconds: number, i = 999): Promise<void> {
  await insertLiveGraduates(
    f.db,
    [
      {
        address: `K${String(i).padStart(43, '0')}`,
        ticker: 'OLD',
        name: 'Old',
        launchpad: 'pump.fun',
        launchedAt: null,
        creatorWallet: null,
        graduatedAt: new Date(f.clock.ms - ageSeconds * 1000),
      },
    ],
    { chain: 'solana', discoverySource: 'test', now: f.clock.now(), dayKey: 'day:setup' },
  );
}

const stageStatus = async (f: LiveFixture, address: string, stage: string) =>
  (
    await sql<{ status: string }>`
      select s.status from coin_stages s join coins c on c.id = s.coin_id
      where c.address = ${address} and s.stage = ${stage}`.execute(f.db)
  ).rows[0]?.status ?? null;

describeDb('live loops', () => {
  it('finds a coin, triggers it at the next poll, and has its metrics inside the hour', async () => {
    fx = await liveFixture();
    const f = fx;
    await addKnownCoin(f, 600); // the latest graduation in the database: where a first start begins
    await sweepDoneToday(f);
    const G = f.clock.sec + 10 * MIN;
    // Graduates at $60,000 and climbs $1,750 a minute: $90,000 is crossed 18 minutes in, $95,000 at 20.
    const coin = worldCoin(1, G, (t) =>
      Math.min(60_000 + Math.floor((t - G) / 60) * 1_750, 200_000),
    );
    f.world.add(coin);
    const crossedAt = G + 18 * MIN;

    const loop = new LiveLoop(f.deps);
    let foundAt: number | null = null;
    let triggeredAt: number | null = null;
    let metricsAt: number | null = null;
    for (let i = 0; i < 90 * 4; i++) {
      f.clock.advance(15_000);
      await loop.tick();
      const present = await f.db
        .selectFrom('coins')
        .select('id')
        .where('address', '=', coin.mint)
        .executeTakeFirst();
      if (present && foundAt === null) foundAt = f.clock.sec;
      if (triggeredAt === null && f.queued.some((q) => q.stage === 'candles'))
        triggeredAt = f.clock.sec;
      const ran = await f.drain();
      if (metricsAt === null && ran.some((r) => r.stage === 'metrics' && r.outcome === 'done')) {
        metricsAt = f.clock.sec;
      }
    }
    // Found within one discovery interval (5 minutes) of graduating.
    expect(foundAt! - G).toBeLessThanOrEqual(5 * MIN + 15);
    // Triggered at the next poll for its age: a young coin is polled every 2 minutes.
    expect(triggeredAt! - crossedAt).toBeGreaterThanOrEqual(0);
    expect(triggeredAt! - crossedAt).toBeLessThanOrEqual(2 * MIN + 30);
    // From crossing $90,000 to metrics done: well inside an hour.
    expect(metricsAt! - crossedAt).toBeLessThan(60 * MIN);
    expect(await stageStatus(f, coin.mint, 'candles')).toBe('done');
    expect(await stageStatus(f, coin.mint, 'metrics')).toBe('done');
    const row = await f.db
      .selectFrom('coins')
      .select(['ath_market_cap_usd', 'discovery_source', 'ticker', 'current_market_cap_usd'])
      .where('address', '=', coin.mint)
      .executeTakeFirstOrThrow();
    // The fetch sees the bars up to the minute before it ran, so its ATH is a minute or two behind the poll.
    expect(row.ath_market_cap_usd).toBeGreaterThan(85_000);
    expect(row.discovery_source).toBe('codex-live');
    expect(row.ticker).toBe('S1');
    expect(row.current_market_cap_usd).toBeGreaterThanOrEqual(90_000);
    // Done coins leave the watched set, and the day's counters say what happened.
    const status = await collectLiveStatus(f.db, f.clock.now());
    expect(status.today).toMatchObject({ found: 1, triggered: 1, swept: 0 });
    expect(status.watched.total).toBe(1); // the known coin, never fetched
  }, 120_000);

  it('fetches by the daily sweep a coin that went above the line and back between two polls', async () => {
    fx = await liveFixture({ startIso: '2026-11-15T22:50:00Z' });
    const f = fx;
    await addKnownCoin(f, 300);
    await sweepDoneToday(f);
    const G = f.clock.sec + 10 * MIN; // 23:00
    // $20,000, except for an hour and a half from 25 minutes after graduating: $150,000.
    const coin = worldCoin(2, G, (t) => (t >= G + 25 * MIN && t < G + 85 * MIN ? 150_000 : 20_000));
    f.world.add(coin);
    const loop = new LiveLoop(f.deps);

    // Up to 24 minutes in, a tick a minute: found and polled at $20,000.
    for (let i = 0; i < 34; i++) {
      f.clock.advance(60_000);
      await loop.tick();
    }
    // The spike (23:25 to 00:25) passes between two ticks: the next one, on day 2, sees $20,000 again.
    f.clock.set('2026-11-16T00:30:00Z');
    await loop.tick();
    expect(f.queued.filter((q) => q.stage === 'candles')).toHaveLength(0);
    const polled = await f.db
      .selectFrom('coins')
      .select('current_market_cap_usd')
      .where('address', '=', coin.mint)
      .executeTakeFirstOrThrow();
    expect(polled.current_market_cap_usd).toBeCloseTo(20_000, 0);
    // Day 2's sweep ran and found the coin 1.5 hours old: not yet. Day 3's finds it 25 hours old.
    expect(
      ((await getLiveState<{ at: string }>(f.db, STATE_LAST_SWEEP)) ?? { at: '' }).at.slice(0, 10),
    ).toBe('2026-11-16');
    while (f.clock.ms < Date.parse('2026-11-17T00:20:00Z')) {
      f.clock.advance(30 * MIN * 1000);
      await loop.tick();
    }
    expect(f.queued.some((q) => q.stage === 'candles')).toBe(true);
    expect(await stageStatus(f, coin.mint, 'candles')).toBe('pending');
    const ran = await f.drain();
    expect(ran.filter((r) => r.outcome === 'done').map((r) => r.stage)).toEqual(
      expect.arrayContaining(['candles', 'metrics']),
    );
    const row = await f.db
      .selectFrom('coins')
      .select('ath_market_cap_usd')
      .where('address', '=', coin.mint)
      .executeTakeFirstOrThrow();
    expect(row.ath_market_cap_usd).toBeGreaterThanOrEqual(100_000);
    const day3 = await getLiveState<{ swept?: number; triggered?: number }>(
      f.db,
      dayKey(f.clock.now()),
    );
    // Two coins were old enough: this one and the known coin the test started from.
    expect(day3).toMatchObject({ swept: 2 });
    expect(day3?.triggered ?? 0).toBe(0);
  }, 180_000);

  it('loses no coin in 30 minutes of failed discovery and inserts none twice', async () => {
    fx = await liveFixture();
    const f = fx;
    await sweepDoneToday(f);
    const t0 = f.clock.sec;
    await setLiveState(f.db, STATE_DISCOVERY_CURSOR, { at: t0 }, f.clock.now());
    // One graduate a minute for two hours.
    for (let i = 1; i <= 120; i++) f.world.add(worldCoin(100 + i, t0 + i * MIN, () => 10_000));
    const failFrom = t0 + 30 * MIN;
    const failTo = t0 + 60 * MIN;
    f.world.failFilter = () => f.clock.sec >= failFrom && f.clock.sec < failTo;
    const loop = new LiveLoop(f.deps);
    let cursorAtFailureStart: unknown;
    let cursorAtFailureEnd: unknown;
    let errors = 0;
    for (let i = 0; i < 130; i++) {
      f.clock.advance(60_000);
      const r = await loop.tick();
      if (r.discovery?.status === 'error') errors++;
      if (f.clock.sec === failFrom + 5 * MIN)
        cursorAtFailureStart = await getLiveState(f.db, STATE_DISCOVERY_CURSOR);
      if (f.clock.sec === failTo - 60)
        cursorAtFailureEnd = await getLiveState(f.db, STATE_DISCOVERY_CURSOR);
    }
    expect(errors).toBeGreaterThanOrEqual(5);
    // While discovery was failing the cursor stood still.
    expect(cursorAtFailureEnd).toEqual(cursorAtFailureStart);
    const rows = await f.db.selectFrom('coins').select('address').execute();
    expect(rows).toHaveLength(120);
    expect(new Set(rows.map((r) => r.address)).size).toBe(120);
    expect(new Set(rows.map((r) => r.address))).toEqual(new Set(f.world.coins.map((c) => c.mint)));
    const last = await getLiveState<{ status: string }>(f.db, 'last_discovery');
    expect(last?.status).toBe('ok');
  }, 120_000);

  it('walks a 3-day gap, 3,000 graduates a day, without a query past the depth limit, and survives a restart', async () => {
    fx = await liveFixture();
    const f = fx;
    const now = f.clock.sec;
    const start = now - 3 * 86_400;
    await setLiveState(f.db, STATE_DISCOVERY_CURSOR, { at: start }, f.clock.now());
    const total = 9_000;
    for (let k = 0; k < total; k++) {
      f.world.add(
        worldCoin(1000 + k, start + 1 + Math.floor((k * 3 * 86_400) / total), () => 10_000),
      );
    }
    // The process dies after 20 requests: a new one picks the cursor up.
    let requests = 0;
    f.world.failFilter = () => ++requests > 20;
    const first = await discoverOnce(f.deps);
    expect(first.status).toBe('error');
    const midCursor = (await getLiveState<{ at: number }>(f.db, STATE_DISCOVERY_CURSOR))!.at;
    expect(midCursor).toBeGreaterThan(start);
    expect(midCursor).toBeLessThan(now);
    const storedMid = Number(
      (await sql<{ n: string }>`select count(*)::text as n from coins`.execute(f.db)).rows[0]!.n,
    );
    expect(storedMid).toBeGreaterThan(0);
    expect(storedMid).toBeLessThan(total);

    f.world.failFilter = null;
    const restarted = await discoverOnce({ ...f.deps }); // a new pass: nothing but the database carried over
    expect(restarted.status).toBe('ok');
    const rows = await sql<{ n: string; d: string }>`
      select count(*)::text as n, count(distinct address)::text as d from coins`.execute(f.db);
    expect(rows.rows[0]).toEqual({ n: String(total), d: String(total) });
    expect(f.world.stats.violations).toBe(0);
    // A window holds about 250 rows: no query asks for more than two pages' depth.
    expect(f.world.stats.maxDepth).toBeLessThanOrEqual(1_000);
    expect((await getLiveState<{ at: number }>(f.db, STATE_DISCOVERY_CURSOR))!.at).toBe(now);
  }, 180_000);

  it('starts at the latest graduation in the database when there is no cursor', async () => {
    fx = await liveFixture();
    const f = fx;
    await addKnownCoin(f, 3 * 3600); // graduated 3 hours ago
    f.world.add(worldCoin(1, f.clock.sec - 5 * 3600, () => 10_000)); // before it: not read
    f.world.add(worldCoin(2, f.clock.sec - 2 * 3600, () => 10_000)); // after it: found
    const pass = await discoverOnce(f.deps);
    expect(pass.status).toBe('ok');
    const found = await f.db
      .selectFrom('coins')
      .select('address')
      .where('discovery_source', '=', 'codex-live')
      .execute();
    expect(found.map((c) => c.address)).toEqual([f.world.coins[1]!.mint]);
  });

  it('stops asking Codex.io at the day ceiling until the next UTC day, and the watch loop goes on', async () => {
    fx = await liveFixture({ startIso: '2026-11-15T22:00:00Z', ceilingUnits: 12 });
    const f = fx;
    await sweepDoneToday(f);
    await setLiveState(f.db, STATE_DISCOVERY_CURSOR, { at: f.clock.sec }, f.clock.now());
    for (let i = 1; i <= 400; i++)
      f.world.add(worldCoin(2000 + i, f.clock.sec + i * 30, () => 10_000));
    const loop = new LiveLoop(f.deps);
    // Each discovery pass is one request of about 5 units: the ceiling of 12 is reached in the third.
    for (let i = 0; i < 6; i++) {
      f.clock.advance(5 * 60_000);
      await loop.tick();
    }
    const before = f.world.stats.filterRequests;
    expect(before).toBeLessThanOrEqual(4);
    expect(
      f.logs.some((l) => /warn Codex\.io: .*paused until 2026-11-16T00:00:00\.000Z/.test(l)),
    ).toBe(true);
    const watchedBefore = f.jupiter.requests;
    for (let i = 0; i < 6; i++) {
      f.clock.advance(5 * 60_000);
      const r = await loop.tick();
      expect(r.discovery?.status).toBe('paused');
    }
    // No Codex.io request while the day lasts; the watch loop went on.
    expect(f.world.stats.filterRequests).toBe(before);
    expect(f.jupiter.requests).toBeGreaterThan(watchedBefore);
    // The candles stage takes no coin either.
    await f.db.updateTable('coins').set({ ath_market_cap_usd: null }).execute();
    const coinId = (await f.db.selectFrom('coins').select('id').limit(1).executeTakeFirstOrThrow())
      .id;
    f.queued.push({ stage: 'candles', ids: [coinId] });
    expect((await f.drain())[0]).toMatchObject({ stage: 'candles', outcome: 'held' });

    // The next UTC day: the gate opens and discovery resumes.
    f.clock.set('2026-11-16T00:01:00Z');
    await loop.tick();
    expect(f.logs.some((l) => /info Codex\.io: a new UTC day \(2026-11-16\).*resume/.test(l))).toBe(
      true,
    );
    expect(f.world.stats.filterRequests).toBeGreaterThan(before);
  }, 120_000);

  it('counts the units other runs used today toward the ceiling', async () => {
    fx = await liveFixture({ ceilingUnits: 12 });
    const f = fx;
    const other = (
      await f.db
        .insertInto('ingest_runs')
        .values({ kind: 'backfill' })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    await sql`insert into provider_usage_samples (run_id, provider, sampled_at, requests, units)
              values (${other}, 'codex', ${new Date(f.clock.ms - 3600_000)}, 9, 10012)`.execute(
      f.db,
    );
    // It had used 9,999 units before today began and 10,012 now: 13 today.
    await sql`insert into provider_usage_samples (run_id, provider, sampled_at, requests, units)
              values (${other}, 'codex', ${new Date(f.clock.ms - DAY_MS)}, 5, 9999)`.execute(f.db);
    await f.gate.refresh();
    expect(f.gate.admit()).toBe(false);
    const pass = await discoverOnce(f.deps);
    expect(pass.status).toBe('paused');
    expect(f.world.stats.filterRequests).toBe(0);
  });

  it('prints the status figures from the database alone, through a connection that cannot write', async () => {
    fx = await liveFixture();
    const f = fx;
    await sweepDoneToday(f);
    await addKnownCoin(f, 300);
    const G = f.clock.sec + 2 * MIN;
    f.world.add(worldCoin(3, G, (t) => (t < G + 60 ? 70_000 : 500_000)));
    const loop = new LiveLoop(f.deps);
    for (let i = 0; i < 60; i++) {
      f.clock.advance(30_000);
      await loop.tick();
      await f.drain();
    }
    // Usage samples as the run's own reporting would have written them.
    const s = f.codex.spend();
    await sql`insert into provider_usage_samples (run_id, provider, sampled_at, requests, units)
              values (${f.runId}, 'codex', ${f.clock.now()}, ${s.requests}, ${s.units})`.execute(
      f.db,
    );
    const ro = createReadOnlyDb(f.t.url);
    try {
      const status = await collectLiveStatus(ro, f.clock.now());
      expect(status.today).toMatchObject({ found: 1, triggered: 1, fetched: 1, listed: 1 });
      expect(status.today.codexUnits).toBeGreaterThan(0);
      expect(status.cursorAt).not.toBeNull();
      expect(status.lagSeconds).toBeLessThan(10 * MIN);
      expect(status.watched.total).toBe(1);
      expect(status.lastSweep).not.toBeNull();
      const text = formatLiveStatus(status);
      expect(text).toMatch(/Discovery cursor: .* behind/);
      expect(text).toMatch(/Watched coins: 1 \(under 24 hours 1/);
      expect(text).toMatch(
        /coins found 1, triggered 1, queued by the sweep 0, fetched 1, listed 1/,
      );
      expect(text).toMatch(/Codex\.io [\d,]+ units in [\d,]+ requests/);
      expect(text).toMatch(/Last sweep: 2026-11-15T/);
      await expect(sql`delete from coins`.execute(ro)).rejects.toThrow(/read-only/);
    } finally {
      await ro.destroy();
    }
  }, 120_000);
});
