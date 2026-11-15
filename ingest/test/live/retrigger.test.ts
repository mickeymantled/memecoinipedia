/**
 * A coin stays watched for its first 14 days, fetched or not, and is fetched again at a new high.
 * Throwaway database, simulated Codex.io and Jupiter, a clock the test moves by hand.
 */
import { insertLiveGraduates, setLiveState } from '@memecoinipedia/db';
import { sql } from 'kysely';
import { afterEach, expect, it } from 'vitest';
import { STATE_LAST_SWEEP, WATCH_PASS_SECONDS } from '../../src/live/constants.js';
import { LiveLoop } from '../../src/live/loop.js';
import { sweepOnce } from '../../src/live/sweep.js';
import { watchOnce } from '../../src/live/watch.js';
import {
  describeDb,
  liveFixture,
  reAsked,
  worldCoin,
  type LiveFixture,
  type WorldCoin,
  type WorldStats,
} from './helpers.js';

let fx: LiveFixture | undefined;
afterEach(async () => {
  await fx?.cleanup();
  fx = undefined;
});

const MIN = 60;
const HOUR = 3_600;
const DAY = 86_400;
type Bar = WorldStats['bars'][number];

/** A coin in the world and in `coins`, graduated `ageSeconds` ago. */
async function addCoin(
  f: LiveFixture,
  i: number,
  ageSeconds: number,
  capAt: (t: number) => number,
): Promise<WorldCoin> {
  const c = worldCoin(i, f.clock.sec - ageSeconds, capAt);
  f.world.add(c);
  await insertLiveGraduates(
    f.db,
    [
      {
        address: c.mint,
        ticker: c.symbol,
        name: c.name,
        launchpad: 'pump.fun',
        launchedAt: new Date(c.createdAt * 1000),
        creatorWallet: null,
        graduatedAt: new Date(c.migratedAt * 1000),
      },
    ],
    { chain: 'solana', discoverySource: 'test', now: f.clock.now(), dayKey: 'day:setup' },
  );
  return c;
}

/** The sweep counts as done for the fixture's UTC day, so a tick does not start one. */
const sweepDoneToday = (f: LiveFixture) =>
  setLiveState(
    f.db,
    STATE_LAST_SWEEP,
    { at: f.clock.now().toISOString(), found: 0, queued: 0 },
    f.clock.now(),
  );

/** Ticks every `stepSeconds` until the clock reaches `untilSec`, running the stages after each tick. */
async function runUntil(
  f: LiveFixture,
  loop: LiveLoop,
  untilSec: number,
  stepSeconds = 15 * MIN,
  onStep?: () => Promise<void>,
): Promise<void> {
  while (f.clock.sec < untilSec) {
    f.clock.advance(stepSeconds * 1000);
    await loop.tick();
    await f.drain();
    await onStep?.();
  }
}

const coinRow = (f: LiveFixture, mint: string) =>
  f.db
    .selectFrom('coins')
    .select(['id', 'ath_market_cap_usd', 'last_trigger_market_cap_usd', 'current_market_cap_usd'])
    .where('address', '=', mint)
    .executeTakeFirstOrThrow();

const stageRow = async (f: LiveFixture, mint: string, stage: string) =>
  (
    await sql<{ status: string; attempts: number; finished_at: Date | null }>`
      select s.status, s.attempts, s.finished_at from coin_stages s
      join coins c on c.id = s.coin_id where c.address = ${mint} and s.stage = ${stage}`.execute(
      f.db,
    )
  ).rows[0] ?? null;

/** The day counters added up over every day so far. */
async function totals(f: LiveFixture): Promise<Record<string, number>> {
  const rows = await sql<{ value: Record<string, number> }>`
    select value from live_state where key like 'day:%'`.execute(f.db);
  const sum: Record<string, number> = {};
  for (const r of rows.rows)
    for (const [k, v] of Object.entries(r.value)) sum[k] = (sum[k] ?? 0) + v;
  return sum;
}

const finishedSec = async (f: LiveFixture, mint: string): Promise<number> =>
  Math.floor((await stageRow(f, mint, 'candles'))!.finished_at!.getTime() / 1000);

describeDb('a watched coin is fetched again at a new high', () => {
  it('fetches a coin screened out at 24 hours again when it reaches $95,000 on day 3, and lists it when the bars say so', async () => {
    fx = await liveFixture();
    const f = fx;
    const G = f.clock.sec - 10 * MIN;
    const day3 = G + 2 * DAY + 2 * HOUR;
    const relist = day3 + 6 * HOUR;
    const coin = await addCoin(f, 1, 10 * MIN, (t) =>
      t < day3 ? 20_000 : t < relist ? 95_000 : 110_000,
    );
    const loop = new LiveLoop(f.deps, { refresh: false, topUp: false });

    // The sweep queues the coin once it is 24 hours old; the staged fetch screens it out on its
    // daily bars. It stays watched.
    await runUntil(f, loop, G + 2 * DAY);
    const first = await stageRow(f, coin.mint, 'candles');
    expect(first?.status === 'done' || first?.status === 'skipped').toBe(true);
    expect((await coinRow(f, coin.mint)).ath_market_cap_usd ?? 0).toBeLessThan(90_000);
    expect((await totals(f)).swept).toBe(1);
    const firstBars = [...f.world.stats.bars];
    const firstAsOf = await finishedSec(f, coin.mint);
    expect(firstBars.map((b) => b.resolution)).toEqual(['1D']);

    // Day 3: $95,000. The watch polls it, finds both stages finished and a market cap over the
    // line, and the coin is fetched again.
    await runUntil(f, loop, relist - HOUR);
    expect((await totals(f)).retriggered).toBe(1);
    const secondBars = f.world.stats.bars.slice(firstBars.length);
    expect(secondBars.length).toBeGreaterThan(0);
    // Nothing the first fetch held is asked for again. The daily request starts at the bar that
    // was still forming; the minute and hourly windows are bars the screened-out fetch never took.
    expect(reAsked(firstBars, secondBars, firstAsOf)).toEqual([]);
    const daily = secondBars.filter((b) => b.resolution === '1D');
    expect(daily).toHaveLength(1);
    expect(daily[0]!.from).toBe(Math.floor(firstAsOf / DAY) * DAY);
    const row = await coinRow(f, coin.mint);
    expect(row.last_trigger_market_cap_usd).toBeCloseTo(95_000, 0);
    // The bars say $95,000: under the listing line, so not listed.
    expect(row.ath_market_cap_usd).toBeGreaterThan(90_000);
    expect(row.ath_market_cap_usd).toBeLessThan(100_000);
    expect(await stageRow(f, coin.mint, 'metadata')).toBeNull();

    // At $110,000, over 1.05 times $95,000, it is fetched again, and now the bars list it.
    await runUntil(f, loop, relist + 2 * HOUR);
    expect((await totals(f)).retriggered).toBe(2);
    expect((await coinRow(f, coin.mint)).ath_market_cap_usd).toBeGreaterThanOrEqual(100_000);
    expect((await stageRow(f, coin.mint, 'metadata'))?.status).toBe('done');
  }, 300_000);

  it('does not fetch a coin triggered at $91,500 (ATH $89,750) again at $92,000, and does at $97,000', async () => {
    // Jupiter shows $91,500 and every 1-minute bar wicks up to it, but the bars close at $89,750:
    // the fetch stores an ATH of $89,750 (close-based) under the $91,500 the watch saw.
    fx = await liveFixture();
    const f = fx;
    await sweepDoneToday(f);
    const S = f.clock.sec;
    const t92 = S + HOUR;
    // $97,000 from ten minutes before the tick that sees it: a fetch cannot see the minute still forming.
    const t97 = S + 3 * HOUR - 10 * MIN;
    const coin = await addCoin(f, 2, 10 * MIN, (t) =>
      t < t92 ? 91_500 : t < t97 ? 92_000 : 97_000,
    );
    coin.closeAt = (t) => (t < t92 ? 89_750 : coin.capAt(t));
    const loop = new LiveLoop(f.deps, { refresh: false, topUp: false });

    await runUntil(f, loop, S + 30 * MIN);
    let row = await coinRow(f, coin.mint);
    expect(row.last_trigger_market_cap_usd).toBeCloseTo(91_500, 0);
    expect(row.ath_market_cap_usd).toBeCloseTo(89_750, 0);
    expect(await totals(f)).toMatchObject({ triggered: 1 });
    const firstBars = [...f.world.stats.bars];
    const firstAsOf = await finishedSec(f, coin.mint);

    // An hour at $92,000, long past the 15 minutes: under 1.05 times $91,500 ($96,075), no fetch.
    await runUntil(f, loop, S + 2 * HOUR + 45 * MIN);
    expect((await totals(f)).retriggered ?? 0).toBe(0);
    expect(f.world.stats.bars).toHaveLength(firstBars.length);
    expect((await coinRow(f, coin.mint)).current_market_cap_usd).toBeCloseTo(92_000, 0);

    // At $97,000 it is fetched again, asking for nothing the first fetch held.
    await runUntil(f, loop, t97 + HOUR);
    expect((await totals(f)).retriggered).toBe(1);
    row = await coinRow(f, coin.mint);
    expect(row.last_trigger_market_cap_usd).toBeCloseTo(97_000, 0);
    expect(row.ath_market_cap_usd).toBeGreaterThan(96_000);
    const later = f.world.stats.bars.slice(firstBars.length);
    expect(later.length).toBeGreaterThan(0);
    expect(reAsked(firstBars, later, firstAsOf)).toEqual([]);
  }, 120_000);

  it('updates the ATH of a listed coin at $150,000 within one poll interval plus 15 minutes when it reaches $400,000 on day 5', async () => {
    fx = await liveFixture();
    const f = fx;
    await sweepDoneToday(f);
    const day5 = f.clock.sec + 4 * DAY;
    const coin = await addCoin(f, 3, 10 * MIN, (t) => (t < day5 ? 150_000 : 400_000));
    const loop = new LiveLoop(f.deps, { refresh: false, topUp: false });

    await runUntil(f, loop, f.clock.sec + HOUR);
    const listed = await coinRow(f, coin.mint);
    expect(listed.ath_market_cap_usd).toBeGreaterThanOrEqual(149_000);
    expect(listed.ath_market_cap_usd).toBeLessThan(151_000);
    const firstBars = [...f.world.stats.bars];
    const firstAsOf = await finishedSec(f, coin.mint);
    expect(firstBars.length).toBeGreaterThan(0);

    // A day and a half of $150,000 passes with no further fetch (150,000 is under 1.05 times itself).
    await runUntil(f, loop, day5 - 10 * MIN);
    expect(f.world.stats.bars).toHaveLength(firstBars.length);
    expect((await totals(f)).retriggered ?? 0).toBe(0);

    // Day 5: the coin is over 3 days old, so it is polled hourly.
    const step = 5 * MIN;
    let updatedAt: number | null = null;
    await runUntil(f, loop, day5 + 3 * HOUR, step, async () => {
      if (updatedAt !== null) return;
      const r = await coinRow(f, coin.mint);
      if ((r.ath_market_cap_usd ?? 0) >= 399_000) updatedAt = f.clock.sec;
    });
    expect(updatedAt).not.toBeNull();
    expect(updatedAt! - day5).toBeLessThanOrEqual(HOUR + 15 * MIN + step);
    expect((await totals(f)).retriggered).toBe(1);
    expect(reAsked(firstBars, f.world.stats.bars.slice(firstBars.length), firstAsOf)).toEqual([]);
  }, 300_000);

  it('fetches a coin that sits between $90,000 and $94,000 once by the watch and once by the last look', async () => {
    fx = await liveFixture();
    const f = fx;
    const G = f.clock.sec - 10 * MIN;
    // Between $90,500 and $93,999, a different figure every hour; never 5% over its own ATH.
    const coin = await addCoin(
      f,
      4,
      10 * MIN,
      (t) => 90_500 + ((Math.floor(t / HOUR) * 7_919) % 3_500),
    );
    const loop = new LiveLoop(f.deps, { refresh: false, topUp: false });

    await runUntil(f, loop, G + 2 * HOUR);
    expect(await totals(f)).toMatchObject({ triggered: 1 });
    expect((await coinRow(f, coin.mint)).ath_market_cap_usd).toBeGreaterThan(90_000);
    const afterFirst = f.world.stats.bars.length;

    // Ten and more days: polled all along, fetched no more.
    await runUntil(f, loop, G + 12 * DAY, 30 * MIN);
    expect(f.world.stats.bars).toHaveLength(afterFirst);
    expect(await totals(f)).toMatchObject({ triggered: 1 });
    expect((await totals(f)).retriggered ?? 0).toBe(0);
    expect((await totals(f)).lastlook ?? 0).toBe(0);

    // The sweep after its 13th day gives it its last look: one more fetch, once.
    await runUntil(f, loop, G + 15 * DAY, 30 * MIN);
    const t = await totals(f);
    expect(t.lastlook).toBe(1);
    expect(t.triggered).toBe(1);
    expect(t.retriggered ?? 0).toBe(0);
    expect(f.world.stats.bars.length).toBeGreaterThan(afterFirst);
    expect(await finishedSec(f, coin.mint)).toBeGreaterThan(G + 13 * DAY);
    expect((await stageRow(f, coin.mint, 'metrics'))?.status).toBe('done');
  }, 300_000);

  it('finds by the last look a spike on day 8 that the hourly poll missed', async () => {
    fx = await liveFixture();
    const f = fx;
    const G = f.clock.sec - 10 * MIN;
    // $30,000, except six minutes on day 8 that fall between two ticks (ticks are on the quarter hour).
    const spike = f.clock.sec + 8 * DAY + 3 * MIN;
    const coin = await addCoin(f, 5, 10 * MIN, (t) =>
      t >= spike && t < spike + 6 * MIN ? 300_000 : 30_000,
    );
    const loop = new LiveLoop(f.deps, { refresh: false, topUp: false });

    await runUntil(f, loop, G + 12 * DAY, 15 * MIN);
    // The poll never saw it: the coin was screened out at 24 hours and never triggered.
    let t = await totals(f);
    expect(t.triggered ?? 0).toBe(0);
    expect(t.retriggered ?? 0).toBe(0);
    expect(t.swept).toBe(1);
    expect((await coinRow(f, coin.mint)).ath_market_cap_usd ?? 0).toBeLessThan(90_000);

    await runUntil(f, loop, G + 15 * DAY, 15 * MIN);
    t = await totals(f);
    expect(t.lastlook).toBe(1);
    const row = await coinRow(f, coin.mint);
    expect(row.ath_market_cap_usd).toBeGreaterThanOrEqual(250_000);
    expect((await stageRow(f, coin.mint, 'metadata'))?.status).toBe('done');
  }, 300_000);

  it('gives a listed coin its last look too: a run on day 8 between two hourly polls is found', async () => {
    fx = await liveFixture();
    const f = fx;
    const G = f.clock.sec - 10 * MIN;
    // $150,000, except 20 minutes on day 8 at $600,000, then $120,000 at the next poll.
    const spike = f.clock.sec + 8 * DAY + 3 * MIN;
    const coin = await addCoin(f, 9, 10 * MIN, (t) =>
      t >= spike && t < spike + 20 * MIN
        ? 600_000
        : t >= spike + 20 * MIN && t < spike + 2 * HOUR
          ? 120_000
          : 150_000,
    );
    const loop = new LiveLoop(f.deps, { refresh: false, topUp: false });

    await runUntil(f, loop, G + 12 * DAY, 15 * MIN);
    // Listed by its first fetch; the hourly polls never saw the run.
    let t = await totals(f);
    expect(t.triggered).toBe(1);
    expect(t.retriggered ?? 0).toBe(0);
    const before = await coinRow(f, coin.mint);
    expect(before.ath_market_cap_usd).toBeGreaterThanOrEqual(149_000);
    expect(before.ath_market_cap_usd).toBeLessThan(151_000);

    // The sweep after its 13th day looks again, once.
    await runUntil(f, loop, G + 16 * DAY, 15 * MIN);
    t = await totals(f);
    expect(t.lastlook).toBe(1);
    expect(t.retriggered ?? 0).toBe(0);
    expect((await coinRow(f, coin.mint)).ath_market_cap_usd).toBeGreaterThanOrEqual(590_000);
  }, 300_000);

  it('does not trigger a coin while its candles or metrics are waiting or running', async () => {
    fx = await liveFixture();
    const f = fx;
    await sweepDoneToday(f);
    const S = f.clock.sec;
    // $120,000 at the first poll, $1,000,000 when the stages run, $2,000,000 from the minute after.
    const coin = await addCoin(f, 6, 10 * MIN, (t) =>
      t < S + 6 * MIN ? 120_000 : t < S + 7 * MIN ? 1_000_000 : 2_000_000,
    );
    const set = (stage: string, status: string) =>
      sql`update coin_stages set status = ${status}, attempts = ${status === 'pending' ? 0 : 1},
            started_at = coalesce(started_at, now())
          where stage = ${stage} and coin_id = ${coin.mint ? sql`(select id from coins where address = ${coin.mint})` : sql`0`}`.execute(
        f.db,
      );
    const poll = async () => {
      f.clock.advance(2 * MIN * 1000);
      return watchOnce(f.deps);
    };

    // First trigger at $120,000: candles waiting for a worker.
    f.clock.advance(4 * MIN * 1000);
    expect((await watchOnce(f.deps)).triggered).toBe(1);
    // Still waiting, now at $2,000,000: polled, not triggered again, no second job row.
    const again = await poll();
    expect(again.polled).toBe(1);
    expect(again.triggered + again.retriggered).toBe(0);
    expect(await stageRow(f, coin.mint, 'candles')).toMatchObject({
      status: 'pending',
      attempts: 0,
    });

    // The stages run. Two minutes later the market cap is $2,000,000 (the fetch saw $1,000,000), but the candles finished
    // less than 15 minutes ago.
    await f.drain();
    expect((await stageRow(f, coin.mint, 'metrics'))?.status).toBe('done');
    expect((await poll()).retriggered).toBe(0);

    // Past the 15 minutes: metrics running, then metrics waiting, then candles running, then
    // candles waiting (a reopened row keeps its start time): none is triggered.
    f.clock.advance(16 * MIN * 1000);
    for (const [stage, status] of [
      ['metrics', 'running'],
      ['metrics', 'pending'],
      ['candles', 'running'],
      ['candles', 'pending'],
    ] as const) {
      await set(stage, status);
      const p = await poll();
      expect(p.polled).toBe(1);
      expect(p.retriggered).toBe(0);
      await set(stage, 'done');
    }
    expect((await totals(f)).retriggered ?? 0).toBe(0);

    // Both finished, 15 minutes gone, a new high: now it is.
    const p = await poll();
    expect(p.retriggered).toBe(1);
    expect(await stageRow(f, coin.mint, 'candles')).toMatchObject({
      status: 'pending',
      attempts: 0,
    });
    expect(await stageRow(f, coin.mint, 'metrics')).toMatchObject({
      status: 'pending',
      attempts: 0,
    });
    expect(WATCH_PASS_SECONDS).toBeLessThan(2 * MIN);
  }, 60_000);

  it('retries the failed candles, or failed metrics, of a watched coin at the next sweep, once', async () => {
    fx = await liveFixture();
    const f = fx;
    const watched = await addCoin(f, 7, 2 * DAY, () => 10_000);
    const old = await addCoin(f, 8, 20 * DAY, () => 10_000);
    const metricsOnly = await addCoin(f, 10, 2 * DAY, () => 10_000);
    for (const c of [watched, old]) {
      await sql`
        insert into coin_stages (coin_id, stage, status, attempts, started_at, finished_at, last_error)
        select id, 'candles', 'failed', 3, now(), now(), 'provider said no'
        from coins where address = ${c.mint}`.execute(f.db);
    }
    // Candles done, metrics failed.
    await sql`
      insert into coin_stages (coin_id, stage, status, attempts, started_at, finished_at)
      select id, 'candles', 'done', 1, now(), now() from coins where address = ${metricsOnly.mint}`.execute(
      f.db,
    );
    await sql`
      insert into coin_stages (coin_id, stage, status, attempts, started_at, finished_at, last_error)
      select id, 'metrics', 'failed', 3, now(), now(), 'bad bars' from coins where address = ${metricsOnly.mint}`.execute(
      f.db,
    );
    const queuedBefore = f.queued.length;

    const first = await sweepOnce(f.deps);
    expect(first.retried).toBe(2);
    // The watched coin is back to a fresh pending row and was queued; the old one is left failed.
    expect(await stageRow(f, watched.mint, 'candles')).toMatchObject({
      status: 'pending',
      attempts: 0,
    });
    expect(await stageRow(f, old.mint, 'candles')).toMatchObject({ status: 'failed', attempts: 3 });
    // Candles stay done for the coin whose metrics failed; only its metrics are retried and queued.
    expect(await stageRow(f, metricsOnly.mint, 'candles')).toMatchObject({ status: 'done' });
    expect(await stageRow(f, metricsOnly.mint, 'metrics')).toMatchObject({
      status: 'pending',
      attempts: 0,
    });
    const metricsId = (await coinRow(f, metricsOnly.mint)).id;
    expect(
      f.queued.slice(queuedBefore).some((q) => q.stage === 'metrics' && q.ids.includes(metricsId)),
    ).toBe(true);
    const watchedId = (await coinRow(f, watched.mint)).id;
    expect(
      f.queued.slice(queuedBefore).some((q) => q.stage === 'candles' && q.ids.includes(watchedId)),
    ).toBe(true);

    // The next sweep finds nothing failed among the watched coins.
    const second = await sweepOnce(f.deps);
    expect(second.retried).toBe(0);
    expect((await totals(f)).retried).toBe(2);
  }, 60_000);
});
