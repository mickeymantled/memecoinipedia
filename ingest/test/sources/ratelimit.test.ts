import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../../src/sources/ratelimit.js';
import { fakeClock } from './helpers.js';

/** Largest number of timestamps inside any half-open one-second span. */
function maxInAnySecond(times: number[]): number {
  let max = 0;
  for (const start of times) {
    max = Math.max(max, times.filter((t) => t >= start && t < start + 1000).length);
  }
  return max;
}

describe('RateLimiter', () => {
  it('holds maxPerSecond under a burst of 100 calls (burst 1)', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({
      maxPerSecond: 10,
      burst: 1,
      now: clock.now,
      sleep: clock.sleep,
    });
    const starts: number[] = [];
    await Promise.all(
      Array.from({ length: 100 }, () => limiter.run(async () => void starts.push(clock.now()))),
    );
    expect(starts).toHaveLength(100);
    expect(maxInAnySecond(starts)).toBeLessThanOrEqual(10);
    // 100 calls at 10 per second cannot finish faster than 9.9 seconds.
    expect(clock.now()).toBeGreaterThanOrEqual(9_900);
  });

  it('allows the configured burst up front, then the sustained rate', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({
      maxPerSecond: 10,
      burst: 5,
      now: clock.now,
      sleep: clock.sleep,
    });
    const starts: number[] = [];
    await Promise.all(
      Array.from({ length: 100 }, () => limiter.run(async () => void starts.push(clock.now()))),
    );
    expect(starts.slice(0, 5).every((t) => t === 0)).toBe(true);
    expect(starts[5]).toBeGreaterThan(0);
    // A bucket of size 5 refilling at 10 per second can put at most 5 + 10 calls in one second.
    expect(maxInAnySecond(starts)).toBeLessThanOrEqual(15);
    expect(clock.now()).toBeGreaterThanOrEqual(9_500);
  });

  it('does not delay calls that arrive after the bucket has refilled', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({
      maxPerSecond: 2,
      burst: 2,
      now: clock.now,
      sleep: clock.sleep,
    });
    await limiter.acquire();
    await limiter.acquire();
    clock.advance(5_000);
    const before = clock.now();
    await limiter.acquire();
    await limiter.acquire();
    expect(clock.now()).toBe(before);
    expect(clock.sleeps).toHaveLength(0);
  });

  it('caps concurrency', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({
      maxPerSecond: 1000,
      burst: 1000,
      maxConcurrency: 3,
      now: clock.now,
      sleep: clock.sleep,
    });
    let running = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 20 }, () =>
        limiter.run(async () => {
          running++;
          peak = Math.max(peak, running);
          await new Promise((r) => setTimeout(r, 1));
          running--;
        }),
      ),
    );
    expect(peak).toBe(3);
    expect(running).toBe(0);
  });

  it('releases its slot when the call throws', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({
      maxPerSecond: 1000,
      burst: 10,
      maxConcurrency: 1,
      now: clock.now,
      sleep: clock.sleep,
    });
    await expect(limiter.run(async () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    await expect(limiter.run(async () => 'ok')).resolves.toBe('ok');
  });

  it('rejects nonsense settings', () => {
    expect(() => new RateLimiter({ maxPerSecond: 0 })).toThrow(RangeError);
    expect(() => new RateLimiter({ maxPerSecond: 1, burst: 0 })).toThrow(RangeError);
  });
});
