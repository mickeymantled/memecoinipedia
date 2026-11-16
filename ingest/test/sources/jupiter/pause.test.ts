/**
 * Jupiter answering HTTP 429: the client pauses every request of the process, sends the request
 * that met it again after the pause, and gives up with one typed error after a named number of
 * pauses in a row. A fake clock throughout: nothing here waits in real time.
 */
import { describe, expect, it } from 'vitest';
import {
  JUPITER_MAX_PAUSES_IN_A_ROW,
  JUPITER_PAUSE_DEFAULT_MS,
  JUPITER_PAUSE_MAX_MS,
  JUPITER_PAUSE_PROVIDER,
  JUPITER_RATE_SHARE,
  JupiterClient,
  JupiterRateLimitedError,
  jupiterPauseUsage,
} from '../../../src/sources/jupiter/index.js';
import { fakeClock } from '../helpers.js';
import { fakeGetFetch, type GetReply } from '../net-helpers.js';

const OK = JSON.stringify([{ id: 'A', usdPrice: 1 }]);

/** A client on a fake clock, with the default limiter (so pacing is real) unless told otherwise. */
function setup(answer: (n: number, at: number) => GetReply, apiKey?: string) {
  const clock = fakeClock();
  const times: number[] = [];
  const f = fakeGetFetch((_req, n) => {
    times.push(clock.now());
    return answer(n, clock.now());
  });
  const c = new JupiterClient({
    fetch: f.fetch,
    now: clock.now,
    sleep: clock.sleep,
    ...(apiKey ? { apiKey } : {}),
    http: { sleep: clock.sleep, random: () => 0.5, baseDelayMs: 10 },
  });
  return { c, clock, times, f };
}

describe('the Jupiter pause', () => {
  it('answers 429 for 90 seconds: every request waits, none goes out during a pause, the batch is not failed', async () => {
    const { c, times } = setup((_n, at) => (at < 90_000 ? { status: 429 } : { body: OK }));
    const tokens = await c.getTokens(['A']);
    expect(tokens[0]).toMatchObject({ mint: 'A', found: true, priceUsd: 1 });
    // 429 at 0 (pause to 60 s), 429 at 60 s (pause to 120 s), answered at 120 s.
    expect(times).toEqual([0, 60_000, 120_000]);
    expect(c.pauseStats()).toEqual({ pauses: 2, secondsPaused: 120 });
    // The HTTP helper's quick retries were not used.
    expect(c.requestCount()).toBe(3);
  });

  it('waits at least Retry-After before the next request', async () => {
    const { c, times } = setup((n) =>
      n === 0 ? { status: 429, headers: { 'retry-after': '20' } } : { body: OK },
    );
    await c.getTokens(['A']);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(20_000);
    expect(c.pauseStats().secondsPaused).toBe(20);
  });

  it('caps a long Retry-After', async () => {
    const { c, times } = setup((n) =>
      n === 0 ? { status: 429, headers: { 'retry-after': '99999' } } : { body: OK },
    );
    await c.getTokens(['A']);
    expect(times[1]! - times[0]!).toBe(JUPITER_PAUSE_MAX_MS);
  });

  it('pauses for the default when there is no Retry-After', async () => {
    const { c, times } = setup((n) => (n === 0 ? { status: 429 } : { body: OK }));
    await c.getTokens(['A']);
    expect(times[1]! - times[0]!).toBe(JUPITER_PAUSE_DEFAULT_MS);
  });

  it('gives up with one typed error after the named number of pauses in a row, never retried by the helper', async () => {
    const { c, times } = setup(() => ({ status: 429 }));
    const err = await c.getTokens(['A']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JupiterRateLimitedError);
    expect((err as JupiterRateLimitedError).pauses).toBe(JUPITER_MAX_PAUSES_IN_A_ROW);
    expect((err as Error).message).toMatch(/kept answering HTTP 429/);
    expect(times).toHaveLength(JUPITER_MAX_PAUSES_IN_A_ROW);
    expect(c.pauseStats().pauses).toBe(JUPITER_MAX_PAUSES_IN_A_ROW);
  });

  it('counts pauses in a row only between answered requests: a success starts the count again', async () => {
    // 4 pauses, an answer, 4 pauses, an answer: never 5 in a row.
    const pattern = [429, 429, 429, 429, 200, 429, 429, 429, 429, 200];
    const { c } = setup((n) => (pattern[n] === 429 ? { status: 429 } : { body: OK }));
    await c.getTokens(['A']);
    await c.getTokens(['A']);
    expect(c.pauseStats().pauses).toBe(8);
  });

  it('one pause is shared by requests in flight together', async () => {
    const { c, times } = setup((n) => (n === 0 ? { status: 429 } : { body: OK }));
    // Two callers at once: both meet the 429 at the start and wait for the same pause.
    const [a, b] = await Promise.all([c.getTokens(['A']), c.getTokens(['A'])]);
    expect(a[0]!.found && b[0]!.found).toBe(true);
    expect(c.pauseStats().pauses).toBe(1);
    // Nothing went out between the first two answers and the end of the pause.
    expect(times.slice(2).every((t) => t >= JUPITER_PAUSE_DEFAULT_MS)).toBe(true);
  });

  it('says how long it is paused for, so a loop can end its pass instead of waiting', async () => {
    const clock = fakeClock();
    const f = fakeGetFetch((_r, n) =>
      n === 0 ? { status: 429, headers: { 'retry-after': '30' } } : { body: OK },
    );
    let seen = -1;
    const c: JupiterClient = new JupiterClient({
      fetch: f.fetch,
      now: clock.now,
      sleep: async (ms) => {
        seen = c.pausedForMs();
        await clock.sleep(ms);
      },
      http: { sleep: clock.sleep },
    });
    expect(c.pausedForMs()).toBe(0);
    await c.getTokens(['A']);
    expect(seen).toBeGreaterThan(29_000);
    expect(c.pausedForMs()).toBe(0);
  });

  it('paces at the named share of the documented rate: 0.5 a second without a key, 1 with one', async () => {
    for (const [key, perSecond] of [
      [undefined, 0.5],
      ['k', 1],
    ] as const) {
      const { c, times } = setup(() => ({ body: OK }), key);
      for (let i = 0; i < 4; i++) await c.getTokens(['A']);
      const gaps = times.slice(1).map((t, i) => t - times[i]!);
      const expected = 1000 / (perSecond * JUPITER_RATE_SHARE);
      for (const g of gaps) expect(g).toBeGreaterThanOrEqual(Math.floor(expected) - 1);
      expect(Math.max(...gaps)).toBeLessThan(expected + 5);
    }
  });

  it('tallies pauses and seconds under the Jupiter provider, and nothing before a pause', async () => {
    const { c } = setup((n) =>
      n === 0 ? { status: 429, headers: { 'retry-after': '20' } } : { body: OK },
    );
    expect(jupiterPauseUsage(c)).toEqual({});
    await c.getTokens(['A']);
    expect(jupiterPauseUsage(c)).toEqual({ [JUPITER_PAUSE_PROVIDER]: { requests: 1, units: 20 } });
  });
});
