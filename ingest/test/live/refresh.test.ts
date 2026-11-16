/**
 * The daily refresh and the candle top-up (issue #74), against a throwaway database, a simulated
 * Codex.io and Jupiter, and a clock the test moves by hand. Nothing here reaches a provider.
 */
import { ensureStages, insertLiveGraduates } from '@memecoinipedia/db';
import { sql } from 'kysely';
import { afterEach, expect, it } from 'vitest';
import {
  JUPITER_FREE_RPS,
  REFRESH_MINTS_PER_REQUEST,
  TOPUP_STOP_SHARE,
} from '../../src/live/constants.js';
import type { CodexDayGate } from '../../src/live/gate.js';
import { LiveLoop } from '../../src/live/loop.js';
import { refreshOnce, refreshState } from '../../src/live/refresh.js';
import { topUpOnce } from '../../src/live/topup.js';
import { watchDue, newWatchState } from '../../src/live/watch.js';
import { describeDb, liveFixture, reAsked, worldCoin, type LiveFixture } from './helpers.js';

let fx: LiveFixture | undefined;
afterEach(async () => {
  await fx?.cleanup();
  fx = undefined;
});

const MIN = 60;
const HOUR = 3_600;
const DAY = 86_400;
const ALIVE = { liquidityUsd: 30_000, volume24hUsd: 5_000 };

const codexRequests = (f: LiveFixture) =>
  f.world.stats.filterRequests + f.world.stats.otherRequests;

async function addCoin(
  f: LiveFixture,
  i: number,
  ageSeconds: number,
  capAt: (t: number) => number,
) {
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

const row = (f: LiveFixture, mint: string) =>
  f.db
    .selectFrom('coins')
    .select([
      'id',
      'status',
      'ath_market_cap_usd',
      'current_market_cap_usd',
      'current_liquidity_usd',
      'current_price_usd',
      'last_alive_at',
      'status_changed_at',
    ])
    .where('address', '=', mint)
    .executeTakeFirstOrThrow();

/** Listed coins with no world behind them, inserted in one statement. */
async function insertListed(f: LiveFixture, n: number): Promise<void> {
  await sql`
    insert into coins (chain, address, ath_market_cap_usd, status, graduated_at)
    select 'solana', 'L' || lpad(g::text, 43, '0'), 150000, 'alive', ${f.clock.now()}::timestamptz - interval '30 days'
    from generate_series(1, ${n}) g`.execute(f.db);
}

describeDb('the daily refresh', () => {
  it('refreshes 150,000 listed coins in 1,500 Jupiter requests, no Codex request, in under a day at the free rate, and a restart does not repeat a coin', async () => {
    fx = await liveFixture();
    const f = fx;
    await insertListed(f, 150_000);
    const first = await refreshOnce(f.deps, { maxRequests: 700 });
    expect(first).toMatchObject({ status: 'progress', requests: 700 });
    // A new pass (a restart: the place is in live_state) goes on from there.
    const rest = await refreshOnce(f.deps, { maxRequests: 100_000 });
    expect(rest.status).toBe('done');
    expect(f.jupiter.requests).toBe(1_500);
    const asked = f.jupiter.asked.flat();
    expect(asked).toHaveLength(150_000);
    expect(new Set(asked).size).toBe(150_000);
    expect(f.jupiter.asked.every((a) => a.length <= REFRESH_MINTS_PER_REQUEST)).toBe(true);
    expect(codexRequests(f)).toBe(0);
    expect(f.jupiter.requests / JUPITER_FREE_RPS).toBeLessThan(DAY);
    // Jupiter knows none of them: stored with no price and no liquidity, and no error.
    expect(f.logs.filter((l) => l.startsWith('error') || l.startsWith('warn'))).toEqual([]);
    const s = await refreshState(f.deps);
    expect(s).toMatchObject({ done: true, requests: 1_500, coins: 150_000, unknown: 150_000 });
    // Done for the day: another pass sends nothing.
    expect((await refreshOnce(f.deps)).status).toBe('idle');
    expect(f.jupiter.requests).toBe(1_500);
  }, 300_000);

  it('stores no price and no liquidity for a coin Jupiter does not know, and counts it, not an error', async () => {
    fx = await liveFixture();
    const f = fx;
    const c = await addCoin(f, 1, 20 * DAY, () => 150_000);
    await f.db.updateTable('coins').set({ ath_market_cap_usd: 150_000 }).execute();
    f.jupiter.unknown.add(c.mint);
    const pass = await refreshOnce(f.deps);
    expect(pass).toMatchObject({ status: 'done', requests: 1, unknown: 1 });
    const r = await row(f, c.mint);
    expect(r.current_price_usd).toBeNull();
    expect(r.current_liquidity_usd).toBeNull();
    expect(f.logs.filter((l) => l.startsWith('error') || l.startsWith('warn'))).toEqual([]);
    expect((await refreshState(f.deps))?.unknown).toBe(1);
  });

  it('turns an alive coin dead on the seventh quiet refresh and alive again on trading, moving status_changed_at exactly twice; a rugged coin stays rugged', async () => {
    fx = await liveFixture();
    const f = fx;
    const start = f.clock.now();
    const c = await addCoin(f, 1, 30 * DAY, () => 150_000);
    const rug = await addCoin(f, 2, 30 * DAY, () => 150_000);
    await f.db
      .updateTable('coins')
      .set({ ath_market_cap_usd: 150_000, status: 'alive', last_alive_at: start })
      .execute();
    await f.db
      .updateTable('coins')
      .set({ status: 'rugged', rug_pattern: true })
      .where('address', '=', rug.mint)
      .execute();
    // Jupiter shows both coins quiet.
    f.jupiter.figuresFor = () => ({ liquidityUsd: 100, volume24hUsd: 5 });
    const changes: Date[] = [];
    let last = (await row(f, c.mint)).status_changed_at?.getTime() ?? null;
    const statuses: string[] = [];
    for (let day = 1; day <= 7; day++) {
      f.clock.advance(DAY * 1000);
      await refreshOnce(f.deps);
      const r = await row(f, c.mint);
      statuses.push(r.status);
      const at = r.status_changed_at?.getTime() ?? null;
      if (at !== last && r.status_changed_at) changes.push(r.status_changed_at);
      last = at;
    }
    expect(statuses).toEqual(['alive', 'alive', 'alive', 'alive', 'alive', 'alive', 'dead']);
    expect(changes).toHaveLength(1);
    // It trades again.
    f.jupiter.figuresFor = (m) => (m === c.mint ? ALIVE : { liquidityUsd: 100, volume24hUsd: 5 });
    f.clock.advance(DAY * 1000);
    await refreshOnce(f.deps);
    const back = await row(f, c.mint);
    expect(back.status).toBe('alive');
    if (back.status_changed_at && back.status_changed_at.getTime() !== last)
      changes.push(back.status_changed_at);
    expect(changes).toHaveLength(2);
    // Rugged, even when Jupiter shows trading.
    f.jupiter.figuresFor = () => ALIVE;
    f.clock.advance(DAY * 1000);
    await refreshOnce(f.deps);
    expect((await row(f, rug.mint)).status).toBe('rugged');
  });

  it('yields to a watch request that is due, and a tick sends the watch request before any refresh request', async () => {
    fx = await liveFixture();
    const f = fx;
    await insertListed(f, 250);
    // A coin graduated 10 minutes ago is watched: its price is due.
    const w = await addCoin(f, 1, 10 * MIN, () => 20_000);
    expect(await watchDue(f.deps, newWatchState())).toBe(true);
    const yielded = await refreshOnce(f.deps, {
      shouldYield: () => watchDue(f.deps, newWatchState()),
    });
    expect(yielded).toMatchObject({ status: 'yielded', requests: 0 });
    expect(f.jupiter.requests).toBe(0);
    const loop = new LiveLoop(f.deps, { topUp: false });
    await loop.tick();
    expect(f.jupiter.asked[0]).toContain(w.mint);
    // The refresh follows in the same tick, once the watch has been served.
    expect(f.jupiter.asked.slice(1).flat().length).toBeGreaterThan(0);
    expect((await refreshState(f.deps))?.coins).toBeGreaterThan(0);
  }, 120_000);
});

describeDb('the candle top-up', () => {
  it('reopens an alive coin at 60% of its ATH, asks only for bars after the last held, stores the new higher ATH, and leaves a dead coin and an alive coin at 10% alone', async () => {
    fx = await liveFixture();
    const f = fx;
    const T0 = f.clock.sec;
    const G = T0 - 20 * DAY;
    // A $200,000 first day, then $120,000, with a spike to $250,000 in the day after the first fetch.
    const spike = (t: number) => t >= T0 + 6 * HOUR && t < T0 + 8 * HOUR;
    const top = await addCoin(f, 1, 20 * DAY, (t) =>
      t < G + DAY ? 200_000 : spike(t) ? 250_000 : 120_000,
    );
    const dead = await addCoin(f, 2, 20 * DAY, (t) => (t < G + DAY ? 200_000 : 120_000));
    const low = await addCoin(f, 3, 20 * DAY, (t) =>
      t < G + DAY ? 200_000 : spike(t) ? 250_000 : 20_000,
    );
    // The first fetch, as the sweep would queue it.
    const seed = await f.db.selectFrom('coins').select('id').execute();
    await ensureStages(
      f.db,
      seed.map((r) => r.id),
      ['candles', 'metrics'],
    );
    f.queued.push({ stage: 'candles', ids: seed.map((r) => r.id) });
    await f.drain();
    const first = await row(f, top.mint);
    expect(first.ath_market_cap_usd).toBeGreaterThanOrEqual(190_000);
    expect(first.ath_market_cap_usd).toBeLessThan(210_000);
    expect(first.status).toBe('alive');
    const firstBars = [...f.world.stats.bars];
    const firstAsOf = T0;
    await f.db
      .updateTable('coins')
      .set({ status: 'dead', last_alive_at: new Date((T0 - 30 * DAY) * 1000) })
      .where('address', '=', dead.mint)
      .execute();

    // The next UTC day. The refresh first: no Codex.io request, and no top-up before it is done.
    f.clock.set('2026-11-16T10:00:00Z');
    f.jupiter.figuresFor = () => ALIVE;
    f.jupiter.figures.set(dead.mint, { liquidityUsd: 100, volume24hUsd: 5 });
    expect((await topUpOnce(f.deps)).status).toBe('waiting_for_refresh');
    const codexBefore = codexRequests(f);
    expect((await refreshOnce(f.deps)).status).toBe('done');
    expect(codexRequests(f)).toBe(codexBefore);
    expect((await row(f, top.mint)).current_market_cap_usd).toBeCloseTo(120_000, 0);
    expect((await row(f, dead.mint)).status).toBe('dead');

    const queuedBefore = f.queued.length;
    const pass = await topUpOnce(f.deps);
    expect(pass).toEqual({ status: 'ran', queued: 1 });
    const ids = f.queued.slice(queuedBefore).flatMap((q) => q.ids);
    expect(ids).toEqual([(await row(f, top.mint)).id]);
    expect(ids).not.toContain((await row(f, low.mint)).id);
    // Not selected again until its candles finish.
    expect((await topUpOnce(f.deps)).queued).toBe(0);

    await f.drain();
    const later = f.world.stats.bars.slice(firstBars.length);
    expect(later.length).toBeGreaterThan(0);
    expect(later.every((b) => b.mint === top.mint)).toBe(true);
    expect(reAsked(firstBars, later, firstAsOf)).toEqual([]);
    const after = await row(f, top.mint);
    expect(after.ath_market_cap_usd).toBeGreaterThan(240_000);
    // Dead and the 10% coin were not fetched again.
    expect((await row(f, low.mint)).ath_market_cap_usd).toBeLessThan(210_000);
  }, 300_000);

  it('stops at the unit ceiling while the refresh still finishes', async () => {
    fx = await liveFixture();
    const f = fx;
    const c = await addCoin(f, 1, 20 * DAY, () => 150_000);
    await f.db
      .updateTable('coins')
      .set({ ath_market_cap_usd: 150_000, status: 'alive', current_market_cap_usd: 150_000 })
      .execute();
    for (const stage of ['candles', 'metrics']) {
      await sql`insert into coin_stages (coin_id, stage, status, attempts, started_at, finished_at, updated_at)
        select id, ${stage}, 'done', 1, ${f.clock.now()}::timestamptz - interval '3 days', ${f.clock.now()}::timestamptz - interval '3 days', ${f.clock.now()} from coins where address = ${c.mint}`.execute(
        f.db,
      );
    }
    f.jupiter.figuresFor = () => ALIVE;
    const ceiling = 40_000;
    const atCeiling = {
      ...f.deps,
      gate: {
        snapshot: () => ({
          usedToday: ceiling * TOPUP_STOP_SHARE,
          ceiling,
          open: true,
          opensAt: null,
        }),
      } as unknown as CodexDayGate,
    };
    expect((await refreshOnce(atCeiling)).status).toBe('done');
    expect(await topUpOnce(atCeiling)).toEqual({ status: 'paused', queued: 0 });
    expect(f.queued).toEqual([]);
    // Under the stop share the same coin is queued.
    const open = {
      ...f.deps,
      gate: {
        snapshot: () => ({ usedToday: 0, ceiling, open: true, opensAt: null }),
      } as unknown as CodexDayGate,
    };
    expect(await topUpOnce(open)).toEqual({ status: 'ran', queued: 1 });
  });
});
