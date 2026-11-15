import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { sql } from 'kysely';
import { statusFromEvidence } from '../src/coinMetrics.js';
import {
  countListedInFlight,
  countTopUp,
  listListedCoins,
  listTopUp,
  meetsAliveLine,
  storeRefresh,
  type RefreshFigure,
  type TopUpSpec,
} from '../src/refresh.js';
import { createTestDatabase, type TestDatabase } from '../src/testing.js';
import { adminUrl, describeDb } from './helpers.js';
import { describe } from 'vitest';

const NOW = new Date('2026-11-15T10:00:00Z');
const DAYSEC = 86_400;
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);

describe('statusFromEvidence', () => {
  const base = { rugPattern: false, lastAliveAt: null, hasWeekOfHistory: true, now: 1_000_000_000 };
  it('is rugged whatever else it is told', () => {
    expect(
      statusFromEvidence({
        ...base,
        rugPattern: true,
        lastAliveAt: base.now,
        hasWeekOfHistory: true,
      }),
    ).toBe('rugged');
  });
  it('is alive when last_alive_at is under 7 days old, and not at exactly 7', () => {
    expect(statusFromEvidence({ ...base, lastAliveAt: base.now - 7 * DAYSEC + 1 })).toBe('alive');
    expect(statusFromEvidence({ ...base, lastAliveAt: base.now - 7 * DAYSEC })).toBe('dead');
  });
  it('is dead with a week of history and unknown without', () => {
    expect(statusFromEvidence(base)).toBe('dead');
    expect(statusFromEvidence({ ...base, hasWeekOfHistory: false })).toBe('unknown');
  });
  it('meets the alive line at $1,000 of volume and $5,000 of liquidity, both inclusive', () => {
    expect(meetsAliveLine({ liquidityUsd: 5_000, volume24hUsd: 1_000 })).toBe(true);
    expect(meetsAliveLine({ liquidityUsd: 4_999, volume24hUsd: 1_000 })).toBe(false);
    expect(meetsAliveLine({ liquidityUsd: 5_000, volume24hUsd: 999 })).toBe(false);
    expect(meetsAliveLine({ liquidityUsd: null, volume24hUsd: 1_000 })).toBe(false);
  });
});

describeDb('the refresh and top-up queries', () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase(adminUrl!);
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await t.db.deleteFrom('coin_stages').execute();
    await t.db.deleteFrom('pools').execute();
    await t.db.deleteFrom('coins').execute();
  });

  const addr = (i: number) => `F${String(i).padStart(43, '0')}`;
  async function coin(
    i: number,
    o: {
      ath?: number | null;
      status?: string;
      current?: number | null;
      refreshedAt?: Date | null;
      graduatedAgo?: number;
      rug?: boolean;
      lastAlive?: Date | null;
      statusChangedAt?: Date | null;
      candles?: { status: string; finishedAgo: number } | null;
      metrics?: { status: string; finishedAgo: number } | null;
      newestBarAgo?: number | null;
    } = {},
  ): Promise<number> {
    const r = await sql<{ id: number }>`
      insert into coins (chain, address, ath_market_cap_usd, status, current_market_cap_usd,
        current_refreshed_at, graduated_at, rug_pattern, last_alive_at, status_changed_at)
      values ('solana', ${addr(i)}, ${o.ath === undefined ? 200_000 : o.ath}, ${o.status ?? 'alive'},
        ${o.current ?? null}, ${o.refreshedAt === undefined ? NOW : o.refreshedAt},
        ${ago(o.graduatedAgo ?? 30 * DAYSEC)}, ${o.rug ?? null}, ${o.lastAlive ?? null},
        ${o.statusChangedAt ?? null})
      returning id`.execute(t.db);
    const id = r.rows[0]!.id;
    const stage = async (name: string, s: { status: string; finishedAgo: number } | null) => {
      if (s === null) return;
      await sql`insert into coin_stages (coin_id, stage, status, attempts, started_at, finished_at, updated_at)
        values (${id}, ${name}, ${s.status}, 1, ${ago(s.finishedAgo + 60)}, ${ago(s.finishedAgo)}, ${NOW})`.execute(
        t.db,
      );
    };
    await stage(
      'candles',
      o.candles === undefined ? { status: 'done', finishedAgo: DAYSEC } : o.candles,
    );
    await stage(
      'metrics',
      o.metrics === undefined ? { status: 'done', finishedAgo: DAYSEC } : o.metrics,
    );
    if (o.newestBarAgo !== undefined && o.newestBarAgo !== null) {
      await sql`insert into pools (chain, address, coin_id, dex, last_bar_at)
        values ('solana', ${'P' + addr(i)}, ${id}, 'PumpSwap', ${ago(o.newestBarAgo)})`.execute(
        t.db,
      );
    }
    return id;
  }

  const SPEC: TopUpSpec = {
    now: NOW,
    dayStart: new Date('2026-11-15T00:00:00Z'),
    refreshedSince: new Date('2026-11-15T00:00:00Z'),
    listedUsd: 100_000,
    athShare: 0.5,
    staleBarSeconds: 7 * DAYSEC,
  };

  it('lists the listed coins in id order, a page at a time', async () => {
    const ids = [
      await coin(1),
      await coin(2, { ath: 99_999 }),
      await coin(3, { ath: null }),
      await coin(4, { ath: 100_000 }),
      await coin(5),
    ];
    const first = await listListedCoins(t.db, { listedUsd: 100_000, afterId: 0, limit: 2 });
    expect(first.map((c) => c.id)).toEqual([ids[0], ids[3]]);
    const next = await listListedCoins(t.db, { listedUsd: 100_000, afterId: ids[3]!, limit: 2 });
    expect(next.map((c) => c.id)).toEqual([ids[4]]);
  });

  it('stores a refresh: figures, last_alive_at forward only, the status, and status_changed_at only on a change', async () => {
    const changedAt = ago(3 * DAYSEC);
    const lastAlive = ago(2 * DAYSEC);
    const live = await coin(1, { status: 'alive', lastAlive, statusChangedAt: changedAt });
    const quiet = await coin(2, {
      status: 'alive',
      lastAlive: ago(7 * DAYSEC),
      statusChangedAt: changedAt,
    });
    const stale = await coin(3, {
      status: 'dead',
      lastAlive: ago(9 * DAYSEC),
      statusChangedAt: changedAt,
    });
    const rugged = await coin(4, {
      status: 'rugged',
      rug: true,
      lastAlive: null,
      statusChangedAt: changedAt,
    });
    const young = await coin(5, {
      status: 'unknown',
      graduatedAgo: 2 * DAYSEC,
      lastAlive: null,
      statusChangedAt: changedAt,
    });
    const fig = (id: number, liq: number | null, vol: number | null): RefreshFigure => ({
      id,
      priceUsd: liq === null ? null : 0.0001,
      marketCapUsd: liq === null ? null : 100_000,
      liquidityUsd: liq,
      volume24hUsd: vol,
    });
    const out = await storeRefresh(
      t.db,
      [
        fig(live, 8_000, 2_000),
        fig(quiet, 100, 5),
        fig(stale, 9_000, 4_000),
        fig(rugged, 9_000, 4_000),
        fig(young, null, null),
      ],
      NOW,
    );
    expect(out).toMatchObject({ coins: 5, metLine: 3, changed: 2 });
    const rows = await t.db
      .selectFrom('coins')
      .select([
        'id',
        'status',
        'status_changed_at',
        'last_alive_at',
        'current_price_usd',
        'current_liquidity_usd',
        'current_refreshed_at',
      ])
      .orderBy('id')
      .execute();
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    // Meets the line: last_alive_at moves forward to the refresh time; still alive, no change.
    expect(by[live]).toMatchObject({ status: 'alive', status_changed_at: changedAt });
    expect(by[live]!.last_alive_at).toEqual(NOW);
    // Quiet for 7 days exactly: dead, and the change is stamped.
    expect(by[quiet]).toMatchObject({ status: 'dead', current_liquidity_usd: 100 });
    expect(by[quiet]!.status_changed_at).toEqual(NOW);
    expect(by[quiet]!.last_alive_at).toEqual(ago(7 * DAYSEC));
    // Dead, trading again: alive.
    expect(by[stale]!.status).toBe('alive');
    expect(by[stale]!.status_changed_at).toEqual(NOW);
    // Rugged stays rugged whatever Jupiter says, though last_alive_at still records the line met.
    expect(by[rugged]).toMatchObject({ status: 'rugged', status_changed_at: changedAt });
    expect(by[rugged]!.last_alive_at).toEqual(NOW);
    // Unknown to Jupiter: no price, no liquidity, the refresh time recorded; unknown under 7 days.
    expect(by[young]).toMatchObject({
      status: 'unknown',
      current_price_usd: null,
      current_liquidity_usd: null,
    });
    expect(by[young]!.current_refreshed_at).toEqual(NOW);
    // A second refresh at the same time changes nothing.
    const again = await storeRefresh(t.db, [fig(live, 8_000, 2_000)], NOW);
    expect(again.changed).toBe(0);
  });

  it('never moves last_alive_at backwards', async () => {
    const later = new Date(NOW.getTime() + DAYSEC * 1000);
    const id = await coin(1, { lastAlive: later });
    await storeRefresh(
      t.db,
      [{ id, priceUsd: 1, marketCapUsd: 1, liquidityUsd: 9_000, volume24hUsd: 9_000 }],
      NOW,
    );
    const r = await t.db
      .selectFrom('coins')
      .select('last_alive_at')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(r.last_alive_at).toEqual(later);
  });

  it('selects for the top-up: alive, listed, refreshed today, near the ATH or with stale bars; never dead, rugged, or near-ATH-less with fresh bars', async () => {
    const sixty = await coin(1, { current: 120_000, newestBarAgo: DAYSEC }); // 60% of 200,000, fresh bars
    const tenFresh = await coin(2, { current: 20_000, newestBarAgo: DAYSEC }); // 10%, fresh bars
    const tenStale = await coin(3, { current: 20_000, newestBarAgo: 8 * DAYSEC }); // 10%, bars end 8 days ago
    const noPrice = await coin(4, { current: null, newestBarAgo: 8 * DAYSEC }); // unknown to Jupiter, stale bars
    const dead = await coin(5, { status: 'dead', current: 190_000, newestBarAgo: 8 * DAYSEC });
    const rugged = await coin(6, { status: 'rugged', current: 190_000, newestBarAgo: 8 * DAYSEC });
    const unlisted = await coin(7, { ath: 99_000, current: 99_000, newestBarAgo: 8 * DAYSEC });
    const notRefreshed = await coin(8, {
      current: 190_000,
      refreshedAt: ago(DAYSEC),
      newestBarAgo: 8 * DAYSEC,
    });
    const exactly = await coin(9, { current: 100_000, newestBarAgo: DAYSEC }); // exactly half
    void [tenFresh, dead, rugged, unlisted, notRefreshed];
    const ids = await listTopUp(t.db, SPEC, { afterId: 0, limit: 100 });
    expect(ids).toEqual([sixty, tenStale, noPrice, exactly]);
    expect(await countTopUp(t.db, SPEC)).toEqual({ total: 4, byMarketCap: 2, byStaleBars: 2 });
    // Without the refresh condition (the dry run, before the day's refresh), the unrefreshed coin counts too.
    const dry = await countTopUp(t.db, { ...SPEC, refreshedSince: null });
    expect(dry.total).toBe(5);
  });

  it('does not select a coin until its candles and metrics have finished, nor twice in one day', async () => {
    const reopened = await coin(1, {
      current: 190_000,
      candles: { status: 'pending', finishedAgo: 3 * DAYSEC },
    });
    const running = await coin(2, {
      current: 190_000,
      metrics: { status: 'running', finishedAgo: 3 * DAYSEC },
    });
    const doneToday = await coin(3, {
      current: 190_000,
      candles: { status: 'done', finishedAgo: 600 },
    });
    const failed = await coin(4, {
      current: 190_000,
      candles: { status: 'failed', finishedAgo: 3 * DAYSEC },
    });
    const ready = await coin(5, { current: 190_000 });
    void [reopened, running, doneToday, failed];
    expect(await listTopUp(t.db, SPEC, { afterId: 0, limit: 100 })).toEqual([ready]);
    expect(await countListedInFlight(t.db, 100_000)).toBe(1); // only the pending candles row
  });
});
