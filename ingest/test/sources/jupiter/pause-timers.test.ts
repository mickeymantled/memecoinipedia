/**
 * The pause against the HTTP helper's own timer. The helper puts a real 30-second timer and an
 * abort signal on every attempt; a pause slept inside an attempt would hand the resend an aborted
 * signal. Vitest fake timers drive the client's sleep, its limiter and the helper's timer
 * together, and the double rejects an aborted signal the way `fetch` does. Nothing waits in real time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../../src/sources/http.js';
import {
  JUPITER_MAX_PAUSES_IN_A_ROW,
  JUPITER_PAUSE_DEFAULT_MS,
  JupiterClient,
  JupiterRateLimitedError,
} from '../../../src/sources/jupiter/index.js';

const OK = JSON.stringify([{ id: 'A', usdPrice: 1 }]);

interface Call {
  at: number;
  aborted: boolean;
}

/** A GET double that answers from `answer(n)` and rejects an already aborted signal as `fetch` does. */
function double(answer: (n: number) => { status: number; headers?: Record<string, string> }) {
  const calls: Call[] = [];
  const fetch = async (
    _url: string,
    init: { signal?: AbortSignal },
  ): Promise<{
    status: number;
    headers: { get(name: string): string | null };
    body: ReadableStream<Uint8Array> | null;
  }> => {
    const aborted = init.signal?.aborted === true;
    calls.push({ at: Date.now(), aborted });
    if (aborted) throw new DOMException('This operation was aborted', 'AbortError');
    const a = answer(calls.length - 1);
    const headers = a.headers ?? {};
    return {
      status: a.status,
      headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
      body: new ReadableStream({
        start(c) {
          if (a.status < 400) c.enqueue(new TextEncoder().encode(OK));
          c.close();
        },
      }),
    };
  };
  return { fetch: fetch as never, calls };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function client(fetch: never, http: Record<string, unknown> = {}) {
  return new JupiterClient({
    fetch,
    now: () => Date.now(),
    sleep,
    // The helper's own timer and backoff are real timers too, and fake here.
    http: { timeoutMs: 30_000, baseDelayMs: 10, random: () => 0.5, sleep, ...http },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** Lets the fake clock run until `p` settles. */
async function settle<T>(p: Promise<T>): Promise<T> {
  let done = false;
  const guarded = p.finally(() => {
    done = true;
  });
  guarded.catch(() => undefined);
  for (let i = 0; i < 2000 && !done; i++) await vi.advanceTimersByTimeAsync(1_000);
  return guarded;
}

describe('the pause and the HTTP helper timer', () => {
  it('one 429 without Retry-After, then 200: two calls, neither with an aborted signal, two requests counted', async () => {
    const d = double((n) => ({ status: n === 0 ? 429 : 200 }));
    const c = client(d.fetch);
    const tokens = await settle(c.getTokens(['A']));
    expect(tokens[0]).toMatchObject({ found: true, priceUsd: 1 });
    expect(d.calls).toHaveLength(2);
    expect(d.calls.every((x) => !x.aborted)).toBe(true);
    expect(d.calls[1]!.at - d.calls[0]!.at).toBeGreaterThanOrEqual(JUPITER_PAUSE_DEFAULT_MS);
    expect(c.requestCount()).toBe(2);
  });

  it('a second caller arriving during the pause makes one call, after the pause, with a signal that is not aborted', async () => {
    const d = double((n) => ({ status: n === 0 ? 429 : 200 }));
    const c = client(d.fetch);
    const first = c.getTokens(['A']);
    await vi.advanceTimersByTimeAsync(5_000); // the 429 has been answered, the pause is running
    expect(c.pausedForMs()).toBeGreaterThan(50_000);
    const second = c.getTokens(['A']);
    await settle(Promise.all([first, second]));
    expect(d.calls).toHaveLength(3); // 429 for the first, then one call each after the pause
    expect(d.calls.every((x) => !x.aborted)).toBe(true);
    const start = d.calls[0]!.at;
    expect(d.calls.slice(1).every((x) => x.at - start >= JUPITER_PAUSE_DEFAULT_MS)).toBe(true);
    expect(c.pauseStats().pauses).toBe(1);
  });

  it('429 without end with the helper allowed no retries: the typed error after five pauses, not an HttpError', async () => {
    const d = double(() => ({ status: 429 }));
    const c = client(d.fetch, { maxRetries: 0 });
    const err = await settle(c.getTokens(['A']).catch((e: unknown) => e));
    expect(err).toBeInstanceOf(JupiterRateLimitedError);
    expect(err).not.toBeInstanceOf(HttpError);
    expect(d.calls).toHaveLength(JUPITER_MAX_PAUSES_IN_A_ROW);
    expect(d.calls.every((x) => !x.aborted)).toBe(true);
    expect(c.pauseStats().pauses).toBe(JUPITER_MAX_PAUSES_IN_A_ROW);
  });

  it('two pauses, then four 5xx answers and a 200: answered, the helper still has its own five tries for the 5xx', async () => {
    const plan = [429, 429, 500, 500, 500, 500, 200];
    const d = double((n) => ({ status: plan[n] ?? 200 }));
    const c = client(d.fetch);
    const tokens = await settle(c.getTokens(['A']));
    expect(tokens[0]).toMatchObject({ found: true });
    expect(d.calls).toHaveLength(plan.length);
    expect(d.calls.every((x) => !x.aborted)).toBe(true);
    expect(c.pauseStats().pauses).toBe(2);
  });

  it('a 5xx between pauses does not reset the count of pauses in a row', async () => {
    // 429, 500, 429, 500, 429, 500, 429, 500, 429: five pauses with only 5xx between them.
    const d = double((n) => ({ status: n % 2 === 0 ? 429 : 500 }));
    const c = client(d.fetch);
    const err = await settle(c.getTokens(['A']).catch((e: unknown) => e));
    expect(err).toBeInstanceOf(JupiterRateLimitedError);
    expect(c.pauseStats().pauses).toBe(JUPITER_MAX_PAUSES_IN_A_ROW);
  });
});
