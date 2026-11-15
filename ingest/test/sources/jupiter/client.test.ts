import { describe, expect, it } from 'vitest';
import { HttpError } from '../../../src/sources/http.js';
import { JupiterClient, JupiterResponseError } from '../../../src/sources/jupiter/index.js';
import { RateLimiter } from '../../../src/sources/ratelimit.js';
import { fakeClock } from '../helpers.js';
import { fakeGetFetch, fixture, fixtureText } from '../net-helpers.js';

const FARTCOIN = '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump';
const VANGOAT = '82DC7kRHVwkVEuK8NjbrwDDqbfkTrQWXuCp4T6C9noie';
const DODGE = 'DwpnoX1YvBSkRFUJyvgeYamptg7WEb3DvV315dAUpump';
const ROSE = 'HfVxfzmAPWER3LQ8VbDcbch6ACchbpuyXv3ujgRtpump';
const USOF = '5xczFwu1UcM2H66dn9VGTPHEyXEHYyC97DeWcrev19xC';
const UNKNOWN = '11111111111111111111111111111111';

function client(
  f: ReturnType<typeof fakeGetFetch>,
  extra: Partial<ConstructorParameters<typeof JupiterClient>[0]> = {},
) {
  const clock = fakeClock();
  return {
    clock,
    c: new JupiterClient({
      fetch: f.fetch,
      limiter: new RateLimiter({
        maxPerSecond: 1000,
        burst: 1000,
        now: clock.now,
        sleep: clock.sleep,
      }),
      http: { sleep: clock.sleep, random: () => 0.5, baseDelayMs: 10 },
      ...extra,
    }),
  };
}

const queryIds = (url: string): string[] => new URL(url).searchParams.get('query')!.split(',');
const bodyFor = (ids: string[]) => JSON.stringify(ids.map((id) => ({ id, usdPrice: 1 })));

describe('getTokens', () => {
  it('reads the recorded response: priced, unpriced, and an unknown mint', async () => {
    const f = fakeGetFetch([{ body: fixtureText('jupiter', 'search') }]);
    const { c } = client(f);
    const tokens = await c.getTokens([FARTCOIN, VANGOAT, DODGE, ROSE, USOF, UNKNOWN]);
    expect(tokens.map((t) => t.mint)).toEqual([FARTCOIN, VANGOAT, DODGE, ROSE, USOF, UNKNOWN]);
    const by = Object.fromEntries(tokens.map((t) => [t.mint, t]));

    expect(by[FARTCOIN]).toMatchObject({ found: true, isVerified: expect.anything() });
    expect(by[FARTCOIN]?.priceUsd).toBeCloseTo(0.0913, 3);
    expect(by[FARTCOIN]?.marketCapUsd).toBeGreaterThan(9e7);
    expect(by[FARTCOIN]?.holderCount).toBeGreaterThan(100_000);
    expect(by[FARTCOIN]?.liquidityUsd).toBeGreaterThan(1e6);
    expect(by[FARTCOIN]?.volume24hUsd).toBeGreaterThan(0);
    // Whole tokens, as Jupiter gives them.
    expect(by[FARTCOIN]?.circulatingSupply).toBeCloseTo(999914113.437569, 3);
    expect(by[FARTCOIN]?.totalSupply).toBeCloseTo(999914113.437569, 3);

    // Known to Jupiter but with no price: found, price null.
    expect(by[VANGOAT]).toMatchObject({ found: true, priceUsd: null, marketCapUsd: null });
    expect(by[VANGOAT]?.holderCount).toBeGreaterThan(0);

    expect(by[DODGE]?.found).toBe(true);
    expect(by[ROSE]?.priceUsd).toBeGreaterThan(0);

    // Jupiter does not return it: found false, not an error.
    expect(by[UNKNOWN]).toMatchObject({
      found: false,
      priceUsd: null,
      liquidityUsd: null,
      volume24hUsd: null,
      holderCount: null,
      marketCapUsd: null,
      circulatingSupply: null,
    });
  });

  it('splits batches at 100 mints', async () => {
    const mints = Array.from({ length: 250 }, (_, i) => `Mint${String(i).padStart(3, '0')}`);
    const f = fakeGetFetch((req) => ({ body: bodyFor(queryIds(req.url)) }));
    const { c } = client(f);
    const tokens = await c.getTokens(mints);
    expect(f.requests).toHaveLength(3);
    expect(f.requests.map((r) => queryIds(r.url).length)).toEqual([100, 100, 50]);
    expect(tokens).toHaveLength(250);
    expect(tokens.every((t) => t.found)).toBe(true);
    expect(c.requestCount()).toBe(3);
  });

  it('exactly 100 mints is one request, 101 is two', async () => {
    const f = fakeGetFetch((req) => ({ body: bodyFor(queryIds(req.url)) }));
    const { c } = client(f);
    await c.getTokens(Array.from({ length: 100 }, (_, i) => `M${i}`));
    expect(f.requests).toHaveLength(1);
    await c.getTokens(Array.from({ length: 101 }, (_, i) => `M${i}`));
    expect(f.requests).toHaveLength(3);
  });

  it('marks every mint missing from the answer as found: false', async () => {
    const f = fakeGetFetch([{ body: '[]' }]);
    const tokens = await client(f).c.getTokens(['A', 'B']);
    expect(tokens.map((t) => t.found)).toEqual([false, false]);
  });

  it('ignores extra tokens in the answer that were not asked for', async () => {
    const f = fakeGetFetch([
      {
        body: JSON.stringify([
          { id: 'A', usdPrice: 1 },
          { id: 'Other', usdPrice: 2 },
        ]),
      },
    ]);
    const tokens = await client(f).c.getTokens(['A']);
    expect(tokens.map((t) => t.mint)).toEqual(['A']);
  });

  it('removes duplicates and makes no request for an empty list', async () => {
    const f = fakeGetFetch((req) => ({ body: bodyFor(queryIds(req.url)) }));
    const { c } = client(f);
    expect((await c.getTokens(['A', 'A', 'B'])).map((t) => t.mint)).toEqual(['A', 'B']);
    expect(await c.getTokens([])).toEqual([]);
    expect(f.requests).toHaveLength(1);
  });

  it('volume is null unless both buy and sell volume are given', async () => {
    const body = JSON.stringify([
      { id: 'A', stats24h: { buyVolume: 10, sellVolume: 5.5 } },
      { id: 'B', stats24h: { buyVolume: 10 } },
      { id: 'C' },
    ]);
    const tokens = await client(fakeGetFetch([{ body }])).c.getTokens(['A', 'B', 'C']);
    expect(tokens.map((t) => t.volume24hUsd)).toEqual([15.5, null, null]);
  });
});

describe('no launch-time field', () => {
  const banned = /creat|launch|first|graduat|born|mint(ed)?At|dev|pool|time/i;
  const keysDeep = (v: unknown, out: string[] = []): string[] => {
    if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        out.push(k);
        keysDeep(x, out);
      }
    }
    return out;
  };

  it('the recorded response does carry createdAt (so the test is meaningful)', () => {
    const raw = fixture('jupiter', 'search') as Array<Record<string, unknown>>;
    expect(raw.every((t) => typeof t['createdAt'] === 'string')).toBe(true);
    expect(raw.some((t) => 'firstPool' in t)).toBe(true);
    expect(raw.some((t) => 'graduatedAt' in t)).toBe(true);
  });

  it('no key anywhere in the typed result looks like a launch time', async () => {
    const f = fakeGetFetch([{ body: fixtureText('jupiter', 'search') }]);
    const tokens = await client(f).c.getTokens([FARTCOIN, VANGOAT, DODGE, ROSE, USOF, UNKNOWN]);
    const keys = new Set(keysDeep(tokens));
    expect([...keys].filter((k) => banned.test(k))).toEqual([]);
    expect(keys.has('createdAt')).toBe(false);
    // And none of the raw createdAt values leaked in as a value.
    const raw = fixture('jupiter', 'search') as Array<{ createdAt: string }>;
    const text = JSON.stringify(tokens);
    for (const t of raw) expect(text).not.toContain(t.createdAt);
  });

  it('the exact key set is the documented one', async () => {
    const f = fakeGetFetch([{ body: fixtureText('jupiter', 'search') }]);
    const [t] = await client(f).c.getTokens([FARTCOIN]);
    expect(Object.keys(t!).sort()).toEqual(
      [
        'circulatingSupply',
        'fdvUsd',
        'found',
        'holderCount',
        'isVerified',
        'liquidityUsd',
        'marketCapUsd',
        'mint',
        'priceUsd',
        'totalSupply',
        'updatedAt',
        'invalid',
        'volume24hUsd',
      ].sort(),
    );
  });
});

describe('request shape and limits', () => {
  it('works without a key and sends no key header', async () => {
    const f = fakeGetFetch([{ body: '[]' }]);
    await client(f).c.getTokens(['A']);
    const req = f.requests[0]!;
    expect(req.url).toBe('https://api.jup.ag/tokens/v2/search?query=A');
    expect(req.headers['x-api-key']).toBeUndefined();
    expect(req.headers['user-agent']).toBe('ingest-client/0.1');
  });

  it('sends the key in a header, never in the URL, when one is set', async () => {
    const f = fakeGetFetch([{ body: '[]' }]);
    await client(f, { apiKey: 'jup-secret' }).c.getTokens(['A']);
    expect(f.requests[0]?.headers['x-api-key']).toBe('jup-secret');
    expect(f.requests[0]?.url).not.toContain('jup-secret');
  });

  it('an error does not carry the key', async () => {
    const f = fakeGetFetch([{ status: 401, body: 'bad key jup-secret' }]);
    const err = await client(f, { apiKey: 'jup-secret' })
      .c.getTokens(['A'])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).message).not.toContain('jup-secret');
  });

  it('is rate limited: one request per second means a one second wait between batches', async () => {
    const clock = fakeClock();
    const f = fakeGetFetch((req) => ({ body: bodyFor(queryIds(req.url)) }));
    const c = new JupiterClient({
      fetch: f.fetch,
      limiter: new RateLimiter({ maxPerSecond: 1, burst: 1, now: clock.now, sleep: clock.sleep }),
    });
    await c.getTokens(Array.from({ length: 250 }, (_, i) => `M${i}`));
    expect(clock.sleeps).toEqual([1000, 1000]);
  });

  it('retries a 429 and counts the retry as a request', async () => {
    const f = fakeGetFetch([{ status: 429, headers: { 'retry-after': '1' } }, { body: '[]' }]);
    const { c, clock } = client(f);
    await c.getTokens(['A']);
    expect(c.requestCount()).toBe(2);
    expect(clock.sleeps).toEqual([1000]);
  });

  it('throws a typed error on a body that is not the expected shape', async () => {
    await expect(
      client(fakeGetFetch([{ body: '{"error":"x"}' }])).c.getTokens(['A']),
    ).rejects.toBeInstanceOf(JupiterResponseError);
    await expect(
      client(fakeGetFetch([{ body: 'not json' }])).c.getTokens(['A']),
    ).rejects.toBeInstanceOf(JupiterResponseError);
  });
});
