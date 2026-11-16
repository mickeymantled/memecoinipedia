import { getLiveState, insertLiveGraduates } from '@memecoinipedia/db';
import { STATE_LAST_WATCH } from '../../src/live/constants.js';
import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverOnce } from '../../src/live/discover.js';
import { newWatchState, marketCapOf, watchOnce } from '../../src/live/watch.js';
import { safeText } from '../../src/live/util.js';
import { token } from '../worker/helpers.js';
import { describeDb, liveFixture, worldCoin, type LiveFixture, type WorldCoin } from './helpers.js';

let fx: LiveFixture | undefined;
afterEach(async () => {
  await fx?.cleanup();
  fx = undefined;
});

/** A coin in the world and in `coins`, graduated `ageSeconds` ago. */
async function watched(
  f: LiveFixture,
  i: number,
  ageSeconds: number,
  capAt: (t: number) => number = () => 10_000,
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
        launchedAt: null,
        creatorWallet: null,
        graduatedAt: new Date(c.migratedAt * 1000),
      },
    ],
    { chain: 'solana', discoverySource: 'test', now: f.clock.now(), dayKey: 'day:setup' },
  );
  return c;
}

describe('market cap for the trigger', () => {
  it("is Jupiter's price times the coin's stored supply", () => {
    const t = token('M', { priceUsd: 0.0001, marketCapUsd: 123_456 });
    expect(marketCapOf(t, 1e9)).toBeCloseTo(100_000, 6);
    expect(marketCapOf(t, 5e8)).toBeCloseTo(50_000, 6);
  });
  it("falls back to Jupiter's own figure only when the supply is unknown", () => {
    const t = token('M', { priceUsd: 0.0001, marketCapUsd: 123_456 });
    for (const unknown of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(marketCapOf(t, unknown)).toBe(123_456);
    }
    expect(marketCapOf(token('M', { priceUsd: null, marketCapUsd: null }), 0)).toBeNull();
    // With a known supply and no price there is no market cap: Jupiter's figure is not used.
    expect(marketCapOf(token('M', { priceUsd: null, marketCapUsd: 99_999 }), 1e9)).toBeNull();
  });
});

describe('safeText', () => {
  it('makes provider text safe for a log line', () => {
    expect(safeText('a\nb\r\u001b[31mred\u0000 x')).toBe('a b  [31mred  x');
    expect(safeText('x'.repeat(500)).length).toBe(200);
    expect(safeText(new Error('boom\nFAKE line'))).toBe('boom FAKE line');
  });
});

describeDb('the watch loop', () => {
  it("triggers on price times the stored supply, and on Jupiter's figure only for an unknown supply", async () => {
    fx = await liveFixture();
    const f = fx;
    // Both coins have a price that is $95,000 on a billion tokens.
    const half = await watched(f, 1, 600, () => 95_000);
    const unknownSupply = await watched(f, 2, 600, () => 95_000);
    await sql`update coins set total_supply = 500000000 where address = ${half.mint}`.execute(f.db);
    await sql`update coins set total_supply = 0 where address = ${unknownSupply.mint}`.execute(
      f.db,
    );
    // Jupiter's own market cap figure is $95,000 for both.
    const pass = await watchOnce(f.deps);
    expect(pass.polled).toBe(2);
    // Half the supply: $47,500, no trigger. Unknown supply: Jupiter's $95,000, trigger.
    expect(pass.triggered).toBe(1);
    expect(f.queued).toHaveLength(1);
    const queuedId = f.queued[0]!.ids[0]!;
    const row = await f.db
      .selectFrom('coins')
      .select('address')
      .where('id', '=', queuedId)
      .executeTakeFirstOrThrow();
    expect(row.address).toBe(unknownSupply.mint);
    const stored = await f.db
      .selectFrom('coins')
      .select(['address', 'current_market_cap_usd', 'current_price_usd'])
      .orderBy('address')
      .execute();
    const byAddr = Object.fromEntries(stored.map((r) => [r.address, r]));
    expect(byAddr[half.mint]!.current_market_cap_usd).toBeCloseTo(47_500, 0);
    expect(byAddr[half.mint]!.current_price_usd).toBeCloseTo(95_000 / 1e9, 12);
  });

  it('does not treat a mint Jupiter does not know as an error: it stays watched, asked again after its interval', async () => {
    fx = await liveFixture();
    const f = fx;
    const c = await watched(f, 1, 600);
    f.jupiter.unknown.add(c.mint);
    const state = newWatchState();
    const first = await watchOnce(f.deps, state);
    expect(first).toMatchObject({ polled: 1, priced: 0, unanswered: 1, triggered: 0 });
    expect(first.error).toBeUndefined();
    // Not asked again until a young coin's interval (2 minutes) has passed.
    f.clock.advance(60_000);
    expect((await watchOnce(f.deps, state)).polled).toBe(0);
    f.clock.advance(61_000);
    expect((await watchOnce(f.deps, state)).polled).toBe(1);
    // Still watched, nothing stored for it.
    const row = await f.db
      .selectFrom('coins')
      .select('current_refreshed_at')
      .executeTakeFirstOrThrow();
    expect(row.current_refreshed_at).toBeNull();
  });

  it("reads prices at the interval of the coin's age: 2 minutes, 10 minutes, an hour", async () => {
    fx = await liveFixture();
    const f = fx;
    const young = await watched(f, 1, 2 * 3600);
    const middle = await watched(f, 2, 2 * 86_400);
    const old = await watched(f, 3, 5 * 86_400);
    const state = newWatchState();
    const times: Record<string, number> = { [young.mint]: 0, [middle.mint]: 0, [old.mint]: 0 };
    for (let i = 0; i < 140; i++) {
      await watchOnce(f.deps, state);
      f.clock.advance(30_000);
    }
    for (const asked of f.jupiter.asked) for (const m of asked) times[m] = (times[m] ?? 0) + 1;
    // 70 minutes at a pass every 30 seconds.
    expect(times[young.mint]).toBe(35); // at 0, 2, 4 ... 68 minutes
    expect(times[middle.mint]).toBe(7); // at 0, 10 ... 60
    expect(times[old.mint]).toBe(2); // at 0 and 60
  });

  it('asks Jupiter for 100 mints a request', async () => {
    fx = await liveFixture();
    const f = fx;
    for (let i = 1; i <= 250; i++) await watched(f, i, 600);
    const pass = await watchOnce(f.deps);
    expect(pass).toMatchObject({ polled: 250, priced: 250, requests: 3 });
    expect(f.jupiter.asked.map((a) => a.length)).toEqual([100, 100, 50]);
  });

  it('keeps what a failed request did not lose, and asks the failed coins again next pass', async () => {
    fx = await liveFixture();
    const f = fx;
    for (let i = 1; i <= 150; i++) await watched(f, i, 600);
    const real = f.jupiter.getTokens.bind(f.jupiter);
    let calls = 0;
    f.jupiter.getTokens = async (m) => {
      if (++calls === 2) throw new Error('Jupiter down\nfake log line');
      return real(m);
    };
    const first = await watchOnce(f.deps);
    expect(first.polled).toBe(100);
    expect(first.error).toBe('Jupiter down fake log line');
    expect(f.logs.some((l) => l.includes('\n'))).toBe(false);
    const second = await watchOnce(f.deps);
    expect(second.polled).toBe(50);
  });

  describe('the stored record of the last pass (live_state last_watch)', () => {
    const record = (f: LiveFixture) => getLiveState<{ endedAt: string; okAt: string | null }>(f.db, STATE_LAST_WATCH);

    it('is written by a pass with nothing due', async () => {
      fx = await liveFixture();
      const f = fx;
      expect(await record(f)).toBeNull();
      const pass = await watchOnce(f.deps);
      expect(pass.polled).toBe(0);
      const now = f.clock.now().toISOString();
      expect(await record(f)).toEqual({ endedAt: now, okAt: now });
    });

    it('keeps the time of the last clean pass when a price request fails', async () => {
      fx = await liveFixture();
      const f = fx;
      await watched(f, 1, 600);
      const clean = f.clock.now().toISOString();
      await watchOnce(f.deps);
      expect(await record(f)).toEqual({ endedAt: clean, okAt: clean });

      f.clock.advance(1_200_000); // the coin is due again
      const real = f.jupiter.getTokens.bind(f.jupiter);
      f.jupiter.getTokens = async () => {
        throw new Error('Jupiter down');
      };
      const failedAt = f.clock.now().toISOString();
      expect((await watchOnce(f.deps)).error).toBe('Jupiter down');
      expect(await record(f)).toEqual({ endedAt: failedAt, okAt: clean });

      f.jupiter.getTokens = real;
      f.clock.advance(60_000);
      const again = f.clock.now().toISOString();
      await watchOnce(f.deps);
      expect(await record(f)).toEqual({ endedAt: again, okAt: again });
    });

    it('does not count a pass that ended paused as a clean one', async () => {
      fx = await liveFixture();
      const f = fx;
      await watched(f, 1, 600);
      const clean = f.clock.now().toISOString();
      await watchOnce(f.deps);
      expect(await record(f)).toEqual({ endedAt: clean, okAt: clean });

      f.clock.advance(1_200_000); // the coin is due again
      f.jupiter.pausedForMs = () => 30_000;
      const pausedAt = f.clock.now().toISOString();
      const pass = await watchOnce(f.deps);
      expect(pass.paused).toBe(true);
      expect(pass.requests).toBe(0);
      expect(await record(f)).toEqual({ endedAt: pausedAt, okAt: clean });

      f.jupiter.pausedForMs = () => 0;
      f.clock.advance(60_000);
      const again = f.clock.now().toISOString();
      expect((await watchOnce(f.deps)).paused).toBeUndefined();
      expect(await record(f)).toEqual({ endedAt: again, okAt: again });
    });

    it('has no clean time when the first pass fails', async () => {
      fx = await liveFixture();
      const f = fx;
      await watched(f, 1, 600);
      f.jupiter.getTokens = async () => {
        throw new Error('Jupiter down');
      };
      await watchOnce(f.deps);
      expect(await record(f)).toEqual({ endedAt: f.clock.now().toISOString(), okAt: null });
    });
  });
});

describeDb('what comes from a provider is data', () => {
  it('stores token names as they come and never writes one into a log line', async () => {
    fx = await liveFixture();
    const f = fx;
    const nasty = "\u001b[31mevil\nerror FAKE LOG LINE\u0000 '; drop table coins; --";
    const c = worldCoin(7, f.clock.sec - 120, () => 10_000, { symbol: '$<b>&"', name: nasty });
    f.world.add(c);
    const pass = await discoverOnce(f.deps);
    expect(pass.found).toBe(1);
    const row = await f.db.selectFrom('coins').select(['ticker', 'name']).executeTakeFirstOrThrow();
    expect(row.ticker).toBe('$<b>&"');
    expect(row.name).toBe(nasty.replace('\u0000', ''));
    await watchOnce(f.deps);
    for (const line of f.logs) {
      expect(line).not.toContain('FAKE LOG LINE');
      expect(line).not.toContain('evil');
      expect(line).not.toContain('<b>');
    }
    // Both tables still there.
    const n = await sql<{ n: string }>`select count(*)::text as n from coins`.execute(f.db);
    expect(n.rows[0]!.n).toBe('1');
  });
});
