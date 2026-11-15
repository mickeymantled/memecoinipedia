import { describe, expect, it } from 'vitest';
import {
  JupiterClient,
  JupiterRedirectError,
  JupiterResponseError,
} from '../../../src/sources/jupiter/index.js';
import { RateLimiter } from '../../../src/sources/ratelimit.js';
import { fakeGetFetch } from '../net-helpers.js';

const client = (f: ReturnType<typeof fakeGetFetch>) =>
  new JupiterClient({
    fetch: f.fetch,
    limiter: new RateLimiter({ maxPerSecond: 1000, burst: 1000 }),
    http: { maxRetries: 0 },
  });

describe('one unreadable row does not fail the batch', () => {
  it('returns the odd row as found with an invalid marker, and the rest as normal', async () => {
    const body = JSON.stringify([
      { id: 'A', usdPrice: 2, holderCount: 7 },
      { id: 'B', usdPrice: 'free', liquidity: [] },
      { usdPrice: 1 }, // no id
      'junk',
    ]);
    const f = fakeGetFetch([{ body }]);
    const tokens = await client(f).getTokens(['A', 'B', 'C']);
    expect(f.requests).toHaveLength(1);
    expect(tokens[0]).toMatchObject({
      mint: 'A',
      found: true,
      priceUsd: 2,
      holderCount: 7,
      invalid: null,
    });
    expect(tokens[1]?.found).toBe(true);
    expect(tokens[1]?.invalid?.length).toBeGreaterThan(0);
    expect(tokens[1]).toMatchObject({ priceUsd: null, liquidityUsd: null, marketCapUsd: null });
    expect(tokens[2]).toMatchObject({ mint: 'C', found: false, invalid: null });
  });

  it('still throws when the body is not an array', async () => {
    const f = fakeGetFetch([{ body: '{"error":"x"}' }]);
    await expect(client(f).getTokens(['A'])).rejects.toBeInstanceOf(JupiterResponseError);
  });
});

describe('redirects', () => {
  it('a 3xx answer is a clear typed error, not "response was not JSON"', async () => {
    const f = fakeGetFetch([{ status: 301, headers: { location: 'https://elsewhere.test/' } }]);
    const err = await client(f)
      .getTokens(['A'])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JupiterRedirectError);
    expect((err as Error).message).toMatch(/redirect/i);
    expect(f.requests).toHaveLength(1);
  });
});
