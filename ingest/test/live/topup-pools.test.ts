/**
 * The pool list in the candle top-up (issue #87), against a throwaway database, a simulated
 * Codex.io and Jupiter, and a clock the test moves by hand. Nothing here reaches a provider.
 */
import { ensureStages, getCoinPools, insertLiveGraduates, upsertPool } from '@memecoinipedia/db';
import { sql } from 'kysely';
import { afterEach, expect, it } from 'vitest';
import {
  COUNTER_TOPUP_LISTS,
  TOPUP_POOL_LIST_MAX_AGE_DAYS,
  UNITS_PER_REQUEST,
  topUpListsPerDay,
} from '../../src/live/constants.js';
import { formatLivePlan, planLive } from '../../src/live/plan.js';
import { createPoolListQueue, topUpOnce } from '../../src/live/topup.js';
import { refreshOnce } from '../../src/live/refresh.js';
import {
  describeDb,
  liveFixture,
  poolOf,
  reAsked,
  worldCoin,
  type LiveFixture,
} from './helpers.js';

let fx: LiveFixture | undefined;
afterEach(async () => {
  await fx?.cleanup();
  fx = undefined;
});

const HOUR = 3_600;
const DAY = 86_400;
const ALIVE = { liquidityUsd: 30_000, volume24hUsd: 5_000 };
const NEW_POOL = 'N'.repeat(44);

type Extra = NonNullable<ReturnType<typeof worldCoin>['extraPools']>[number];

/**
 * A coin that graduated 20 days before the fixture's first day, listed, with its first fetch done.
 * Its first day peaks at $1.2 million and it holds $700,000 after, so the top-up selects it (rule 1) and it takes the full path (the only one that fetches the bars
 * of pools other than the graduation pool: `fullPathFromUsd` is $1,000,000).
 */
async function listedCoin(f: LiveFixture, extra: Extra[] = []) {
  const T0 = f.clock.sec;
  const G = T0 - 20 * DAY;
  const c = worldCoin(1, G, (t) => (t < G + DAY ? 1_200_000 : 700_000), { extraPools: extra });
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
  const { id } = await f.db
    .selectFrom('coins')
    .select('id')
    .where('address', '=', c.mint)
    .executeTakeFirstOrThrow();
  await ensureStages(f.db, [id], ['candles', 'metrics']);
  f.queued.push({ stage: 'candles', ids: [id] });
  await f.drain();
  return { coin: c, id, T0 };
}

const coinRow = (f: LiveFixture, id: number) =>
  f.db
    .selectFrom('coins')
    .select(['ath_market_cap_usd', 'pools_listed_at', 'metrics_computed_at'])
    .where('id', '=', id)
    .executeTakeFirstOrThrow();

/** The next UTC day: the refresh has run, so the top-up may select the coin. */
async function nextDay(f: LiveFixture) {
  f.clock.set('2026-11-16T10:00:00Z');
  f.jupiter.figuresFor = () => ALIVE;
  expect((await refreshOnce(f.deps)).status).toBe('done');
}

const lists = (f: LiveFixture) => f.world.stats.lists;

/** The fixture's deps already carry the queue the candles stage asks. */
function withQueue(f: LiveFixture) {
  return { deps: f.deps, poolLists: f.deps.poolLists! };
}

describeDb('the pool list in a top-up', () => {
  it('makes no list request for a coin whose list was read recently', async () => {
    fx = await liveFixture();
    const f = fx;
    const { id } = await listedCoin(f);
    await nextDay(f);
    await f.db
      .updateTable('coins')
      .set({
        pools_listed_at: new Date(f.clock.ms - (TOPUP_POOL_LIST_MAX_AGE_DAYS - 1) * DAY * 1000),
      })
      .where('id', '=', id)
      .execute();
    const { deps, poolLists } = withQueue(f);
    const before = lists(f);
    expect(await topUpOnce(deps)).toEqual({ status: 'ran', queued: 1, lists: 0 });
    expect(poolLists.size).toBe(0);
    await f.drain();
    expect(lists(f)).toBe(before);
  }, 300_000);

  it('reads an old list once, stores a new liquid SOL pool, fetches its bars up to the clock, recomputes the metrics, and asks for no held bar again', async () => {
    fx = await liveFixture();
    const f = fx;
    const T0 = f.clock.sec;
    // A second venue that opens the day after the first fetch and spikes to $2,000,000; the list shows it from the next UTC day.
    const spike = (t: number) => t >= T0 + 13 * HOUR && t < T0 + 14 * HOUR;
    const extra: Extra = {
      address: NEW_POOL,
      createdAt: T0 + 12 * HOUR,
      listedFrom: T0 + DAY - HOUR,
      liquidity: 40_000,
      capAt: (t) => (spike(t) ? 2_000_000 : 150_000),
    };
    const { coin, id } = await listedCoin(f, [extra]);
    const first = await coinRow(f, id);
    const firstBars = [...f.world.stats.bars];
    expect(first.ath_market_cap_usd).toBeLessThan(1_300_000);
    expect((await getCoinPools(f.db, id)).map((p) => p.address)).not.toContain(NEW_POOL);
    // Its list was read 15 days ago.
    await f.db
      .updateTable('coins')
      .set({ pools_listed_at: new Date(Date.parse('2026-11-01T10:00:00Z')) })
      .where('id', '=', id)
      .execute();
    await nextDay(f);
    const { deps } = withQueue(f);
    const listsBefore = lists(f);
    expect(await topUpOnce(deps)).toEqual({ status: 'ran', queued: 1, lists: 1 });
    await f.drain();

    expect(lists(f) - listsBefore).toBe(1);
    const pools = await getCoinPools(f.db, id);
    const added = pools.find((p) => p.address === NEW_POOL);
    expect(added).toMatchObject({ isPrimary: false, isGraduationPool: false });
    // The graduation role is where it was.
    expect(pools.find((p) => p.isGraduationPool)?.address).toBe(poolOf(coin.mint));
    // Its bars were fetched up to the clock.
    const later = f.world.stats.bars.slice(firstBars.length);
    expect(later.filter((b) => b.pool === NEW_POOL).length).toBeGreaterThan(0);
    const lastBar = await f.db
      .selectFrom('pools')
      .select('last_bar_at')
      .where('address', '=', NEW_POOL)
      .executeTakeFirstOrThrow();
    expect(lastBar.last_bar_at!.getTime() / 1000).toBeGreaterThan(f.clock.sec - 2 * DAY);
    // The held pool was extended too, and no request of it starts inside what the first run held.
    const heldLater = later.filter((b) => b.pool === poolOf(coin.mint));
    expect(heldLater.length).toBeGreaterThan(0);
    expect(
      reAsked(
        firstBars.filter((b) => b.pool === poolOf(coin.mint)),
        heldLater,
        T0,
      ),
    ).toEqual([]);
    // Metrics were recomputed with the new pool: the $2,000,000 spike is in the ATH.
    const after = await coinRow(f, id);
    expect(after.ath_market_cap_usd).toBeGreaterThan(1_900_000);
    expect(after.metrics_computed_at!.getTime()).toBeGreaterThanOrEqual(f.clock.ms - 1000);
    // The time of the read is stored, and the day's counter has it.
    expect(after.pools_listed_at!.getTime()).toBe(f.clock.ms);
    const counters = await f.db
      .selectFrom('live_state')
      .select('value')
      .where('key', '=', 'day:2026-11-16')
      .executeTakeFirstOrThrow();
    expect((counters.value as Record<string, number>)[COUNTER_TOPUP_LISTS]).toBe(1);
  }, 300_000);

  it('makes no list request at the daily ceiling, and keeps the mark until the gate is open', async () => {
    fx = await liveFixture({ ceilingUnits: 40_000 });
    const f = fx;
    const { id } = await listedCoin(f);
    await nextDay(f);
    await f.db.updateTable('coins').set({ pools_listed_at: null }).where('id', '=', id).execute();
    await sql`update pools set created_at = ${new Date(f.clock.ms - 60 * DAY * 1000)} where coin_id = ${id}`.execute(
      f.db,
    );
    // The top-up pass itself stops before the ceiling.
    const full = {
      ...f.deps,
      gate: {
        snapshot: () => ({ usedToday: 40_000, ceiling: 40_000, open: false, opensAt: null }),
        admit: () => false,
      } as unknown as LiveFixture['gate'],
    };
    const before = lists(f);
    expect(await topUpOnce(full)).toEqual({ status: 'paused', queued: 0, lists: 0 });
    expect(lists(f)).toBe(before);

    // A coin already marked: a stage asking while the gate is closed is told no, and the mark stays.
    let open = false;
    const queue = createPoolListQueue({ admit: () => open });
    queue.add([id]);
    expect(queue.take(id)).toBe(false);
    expect(queue.size).toBe(1);
    open = true;
    expect(queue.take(id)).toBe(true);
    expect(queue.take(id)).toBe(false);
    expect(queue.size).toBe(0);
  }, 300_000);

  it("hands out at most the day's share of the ceiling, and counts them in the day's counter", async () => {
    fx = await liveFixture({ ceilingUnits: 400 });
    const f = fx;
    expect(topUpListsPerDay(400)).toBe(10);
    expect(topUpListsPerDay(40_000)).toBe(1_000);
    for (let i = 0; i < 12; i++) {
      await sql`
        insert into coins (chain, address, ath_market_cap_usd, status, graduated_at, current_market_cap_usd, current_refreshed_at)
        values ('solana', ${'L' + String(i).padStart(43, '0')}, 150000, 'alive', '2026-10-01T00:00:00Z', 150000, '2026-11-16T09:00:00Z')`.execute(
        f.db,
      );
    }
    for (const stage of ['candles', 'metrics']) {
      await sql`insert into coin_stages (coin_id, stage, status, attempts, started_at, finished_at, updated_at)
        select id, ${stage}, 'done', 1, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z' from coins`.execute(
        f.db,
      );
    }
    f.clock.set('2026-11-16T10:00:00Z');
    f.jupiter.figuresFor = () => ({ ...ALIVE, priceUsd: 0.00015, marketCapUsd: 150_000 });
    expect((await refreshOnce(f.deps)).status).toBe('done');
    const { deps } = withQueue(f);
    // No stored time and no pool: the last finished candles (two months ago) say the list is old.
    const pass = await topUpOnce(deps);
    expect(pass).toEqual({ status: 'ran', queued: 12, lists: 10 });
    expect(f.deps.poolLists!.size).toBe(10);
    // The day's counter holds the 10 handed out, so the day's share is used up; the other 2 get no
    // mark today. (The counter is per UTC day: tomorrow's key starts empty.)
    const counter = await f.db
      .selectFrom('live_state')
      .select('value')
      .where('key', '=', 'day:2026-11-16')
      .executeTakeFirstOrThrow();
    expect((counter.value as Record<string, number>)[COUNTER_TOPUP_LISTS]).toBe(10);
  }, 300_000);

  it('does not move the graduation role: it records the data issue and leaves the role to a refresh', async () => {
    fx = await liveFixture();
    const f = fx;
    const T0 = f.clock.sec;
    // A second pool, created two hours after the migration (late); the main pool was created at it.
    const extra: Extra = {
      address: NEW_POOL,
      createdAt: T0 - 20 * DAY + 2 * HOUR,
      listedFrom: 0,
      liquidity: 40_000,
      capAt: () => 100_000,
    };
    const { coin, id } = await listedCoin(f, [extra]);
    // The coin holds the late pool as its graduation pool (as an old, wrong choice would leave it).
    await f.db
      .updateTable('pools')
      .set({ is_graduation_pool: false, is_primary: false })
      .where('coin_id', '=', id)
      .execute();
    await upsertPool(f.db, {
      chain: 'solana',
      address: NEW_POOL,
      coinId: id,
      dex: 'Raydium',
      isPrimary: true,
      isGraduationPool: true,
      quoteToken: 'SOL',
      createdAtChain: extra.createdAt,
      sourcePairId: null,
    } as unknown as Parameters<typeof upsertPool>[1]);
    await nextDay(f);
    await f.db
      .updateTable('coins')
      .set({ pools_listed_at: new Date(Date.parse('2026-10-01T00:00:00Z')) })
      .where('id', '=', id)
      .execute();
    const { deps } = withQueue(f);
    const listsBefore = lists(f);
    expect(await topUpOnce(deps)).toMatchObject({ queued: 1, lists: 1 });
    await f.drain();
    expect(lists(f) - listsBefore).toBe(1);
    const pools = await getCoinPools(f.db, id);
    expect(pools.filter((p) => p.isGraduationPool).map((p) => p.address)).toEqual([NEW_POOL]);
    const issues = await f.db
      .selectFrom('data_issues')
      .select(['kind', 'detail'])
      .where('coin_id', '=', id)
      .where('resolved_at', 'is', null)
      .execute();
    expect(issues.find((i) => i.kind === 'graduation_pool_differs')?.detail).toMatchObject({
      storedPool: NEW_POOL,
      listedPool: poolOf(coin.mint),
    });
  }, 300_000);

  it('shows the list requests a day in the dry run', async () => {
    fx = await liveFixture();
    const f = fx;
    await listedCoin(f);
    await nextDay(f);
    await f.db.updateTable('coins').set({ pools_listed_at: null }).execute();
    await sql`update pools set created_at = ${new Date(f.clock.ms - 60 * DAY * 1000)}`.execute(
      f.db,
    );
    const plan = await planLive(f.db, { now: f.clock.now(), maxCodexUnitsPerDay: 40_000 });
    expect(plan.topUp.poolListDue).toBe(1);
    expect(plan.topUpLists).toMatchObject({ dueNow: 1, cap: 1_000, today: 1, steadyPerDay: 1 });
    expect(plan.topUpLists.units).toBe(1 * UNITS_PER_REQUEST);
    expect(formatLivePlan(plan)).toMatch(
      /Pool lists .*over 14 days old.*1 of the selected coins are due now, so the first top-up makes 1 list requests/,
    );
  }, 300_000);
});
