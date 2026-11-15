import { describe, expect, it } from 'vitest';
import { BudgetExceededError, UnitBudget } from '../../../src/sources/budget.js';
import { HttpError } from '../../../src/sources/http.js';
import { RateLimiter } from '../../../src/sources/ratelimit.js';
import {
  CodexClient,
  CodexGraphQLError,
  CodexResponseError,
  type DiscoveredToken,
} from '../../../src/sources/codex/client.js';
import { pickGraduationPool } from '../../../src/sources/codex/pools.js';
import {
  fakeClock,
  fakeFetch,
  gqlBody,
  loadFixture,
  loadFixtureText,
  type FakeReply,
} from '../helpers.js';

const KEY = 'test-key-do-not-leak-0123456789';
const MINT = 'Df6yfrKC8kZE3KNkrHERKzAetSxbrWeniQfyJY4Jpump';
const POOL = 'DGDZ7bpMogjUDeHN28ZYzF3jP6p9UzEgFhK7rxGSAS1x';
const DAY = 86_400;

function make(
  answer: Parameters<typeof fakeFetch>[0],
  extra: Partial<ConstructorParameters<typeof CodexClient>[0]> = {},
) {
  const f = fakeFetch(answer);
  const clock = fakeClock();
  const budget = extra.budget ?? new UnitBudget();
  const client = new CodexClient({
    apiKey: KEY,
    fetch: f.fetch,
    budget,
    http: { sleep: clock.sleep, random: () => 0.5, baseDelayMs: 10, maxRetries: 2 },
    ...extra,
  });
  return { client, f, budget, clock };
}

const microOf = (fixture: string): number =>
  Number(loadFixture(fixture).data.usageData.total.computeUnits) / 1e6;

async function collect(it: AsyncIterable<DiscoveredToken>): Promise<DiscoveredToken[]> {
  const out: DiscoveredToken[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe('fixtures parse into typed results', () => {
  it('filterTokens 2024: migrated pool address is null', async () => {
    const { client, f } = make([{ body: loadFixtureText('filter-tokens-2024') }]);
    const tokens = await collect(client.discoverGraduated({ from: 1731700991, to: 1731701591 }));
    const raw = loadFixture('filter-tokens-2024').data.filterTokens.results;
    expect(tokens).toHaveLength(raw.length);
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.every((t) => t.migratedPoolAddress === null && t.migrated === true)).toBe(true);
    expect(tokens[0]).toMatchObject({
      mint: raw[0].token.address,
      symbol: raw[0].token.symbol,
      creator: raw[0].token.creatorAddress,
      launchpadName: 'Pump.fun',
      migratedAt: raw[0].token.launchpad.migratedAt,
      launchpadPoolAddress: raw[0].token.launchpad.poolAddress,
      pairAddress: raw[0].pair.address,
      liquidityUsd: Number(raw[0].liquidity),
    });
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]?.query).toContain('launchpadName:["Pump.fun"]');
    expect(f.requests[0]?.query).toContain('launchpadMigrated:true');
  });

  it('filterTokens 2026: migrated pool address is present', async () => {
    const { client } = make([{ body: loadFixtureText('filter-tokens-2026') }]);
    const tokens = await collect(client.discoverGraduated({ from: 1788220622, to: 1788221222 }));
    expect(tokens.length).toBeGreaterThan(0);
    const usof = tokens.find((t) => t.symbol === 'USOF');
    expect(usof?.migratedPoolAddress).toBe(POOL);
    expect(usof?.pairAddress).toBe(POOL);
  });

  it('token launch info, 2024 and 2026', async () => {
    const a = make([{ body: loadFixtureText('token-2024') }]);
    const info24 = await a.client.getLaunchInfo(MINT);
    expect(info24).toEqual({
      mint: MINT,
      symbol: 'CHILLGUY',
      name: 'Just a chill guy',
      createdAt: 1728174672,
      creator: 'DTQQf6xhbRFqbSUzHsQ4e1PJroCR3dVKvUnt7sj11HJc',
      launchpadName: 'Pump.fun',
      migrated: true,
      migratedAt: 1731701291,
      migratedPoolAddress: null,
      completed: true,
      completedAt: 1731701291,
      launchpadPoolAddress: '5qM9aAZtM6mCk7dHRL6Frr6oqmKr5hGbaTgFFb9FLUSh',
    });
    const b = make([{ body: loadFixtureText('token-2026') }]);
    const info26 = await b.client.getLaunchInfo('5xczFwu1UcM2H66dn9VGTPHEyXEHYyC97DeWcrev19xC');
    expect(info26?.migratedPoolAddress).toBe(POOL);
  });

  it('returns null for an unknown token', async () => {
    const { client } = make([{ body: gqlBody({ token: null }, '4000000') }]);
    expect(await client.getLaunchInfo(MINT)).toBeNull();
  });

  it('pools: parsed, sorted oldest first, and the graduation pool is picked for both eras', async () => {
    const a = make([{ body: loadFixtureText('pairs-2024') }]);
    const r24 = await a.client.getPools(MINT);
    const raw24 = loadFixture('pairs-2024').data.listPairsWithMetadataForToken.results;
    expect(r24.pools).toHaveLength(raw24.length);
    expect(r24.truncated).toBe(false);
    const times = r24.pools.map((p) => p.createdAt ?? Infinity);
    expect(times).toEqual([...times].sort((x, y) => x - y));
    const first = r24.pools[0]!;
    expect(first.pairId).toBe(`${first.address}:1399811149`);
    expect(first).toMatchObject({ exchange: 'Raydium', protocol: 'RaydiumV4', quoteToken: 'SOL' });
    expect(first.liquidityUsd).toBeGreaterThan(0);
    // 2024: no migrated address, so the closest-in-time pool wins (Raydium V4, 12 s after migration).
    const pick24 = pickGraduationPool({
      pools: r24.pools,
      migratedPoolAddress: null,
      migratedAt: 1731701291,
    });
    expect(pick24).toMatchObject({ source: 'closest_to_migration', deltaToMigrationSec: 12 });
    expect(pick24?.pool?.exchange).toBe('Raydium');

    const b = make([{ body: loadFixtureText('pairs-2026') }]);
    const r26 = await b.client.getPools('5xczFwu1UcM2H66dn9VGTPHEyXEHYyC97DeWcrev19xC');
    expect(r26.pools.map((p) => p.exchange).sort()).toEqual(['Pump', 'PumpSwap']);
    const pick26 = pickGraduationPool({
      pools: r26.pools,
      migratedPoolAddress: POOL,
      migratedAt: 1788220922,
    });
    expect(pick26).toMatchObject({ address: POOL, source: 'migrated_pool_address' });
    // The same answer without the address: the curve is skipped and PumpSwap is chosen.
    expect(
      pickGraduationPool({ pools: r26.pools, migratedPoolAddress: null, migratedAt: 1788220922 })
        ?.address,
    ).toBe(POOL);
  });

  it('flags a pairs answer that hit the 250-pair cap', async () => {
    const results = Array.from({ length: 250 }, (_, i) => ({
      liquidity: '1',
      volume: '1',
      quoteToken: 'token1',
      backingToken: { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL' },
      exchange: { name: 'Orca' },
      pair: {
        address: `P${i}`,
        createdAt: 1000 + i,
        protocol: 'Orca',
        exchangeHash: 'h',
        token0: 'a',
        token1: 'b',
      },
    }));
    const { client } = make([
      { body: gqlBody({ listPairsWithMetadataForToken: { results } }, '5200000') },
    ]);
    const r = await client.getPools(MINT);
    expect(r.pools).toHaveLength(250);
    expect(r.truncated).toBe(true);
    const pick = pickGraduationPool({
      pools: r.pools,
      migratedPoolAddress: null,
      migratedAt: 1000,
      truncated: r.truncated,
    });
    expect(pick).toMatchObject({ source: 'closest_to_migration', truncated: true });
    const withAddress = pickGraduationPool({
      pools: r.pools,
      migratedPoolAddress: 'P3',
      migratedAt: 1000,
      truncated: true,
    });
    expect(withAddress?.truncated).toBe(false);
  });

  it('bars through the client: 1-minute 2026 fixture', async () => {
    const { client, f } = make([{ body: loadFixtureText('bars-1m-2026') }]);
    const from = 1788220920;
    const bars = await client.getPoolBars({
      pairAddress: POOL,
      resolution: '1',
      from,
      to: from + 20 * 60,
    });
    expect(bars).toHaveLength(20);
    expect(bars[0]?.t).toBe(from);
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]?.query).toContain(`getBars(symbol:"${POOL}:1399811149"`);
    expect(f.requests[0]?.query).toContain('resolution:"1"');
    expect(f.requests[0]?.query).toContain('removeEmptyBars:true');
  });

  it('never queries token-level bars or ATH fields', async () => {
    const { client, f } = make((req) => ({
      body: req.query.includes('getBars')
        ? loadFixtureText('bars-1m-2026')
        : req.query.includes('listPairs')
          ? loadFixtureText('pairs-2026')
          : req.query.includes('filterTokens')
            ? loadFixtureText('filter-tokens-2026')
            : loadFixtureText('token-2026'),
    }));
    await client.getLaunchInfo(MINT);
    await client.getPools(MINT);
    await client.getPoolBars({ pairAddress: POOL, resolution: '60', from: 0, to: 7200 });
    await collect(client.discoverGraduated({ from: 1, to: 2 }));
    expect(f.requests).toHaveLength(4);
    for (const r of f.requests) {
      expect(r.query).not.toMatch(/getTokenBars/i);
      expect(r.query).not.toMatch(/\bath[A-Za-z]*/i);
    }
  });
});

describe('bar windows and de-duplication through the client', () => {
  it('requests windows in order and de-duplicates a bucket returned by two windows', async () => {
    const step = 60;
    const from = 1_788_220_800;
    const bar = (t: number, c: number) => ({ t, c });
    const columns = (rows: Array<{ t: number; c: number }>) => ({
      getBars: {
        t: rows.map((r) => r.t),
        o: rows.map((r) => r.c),
        h: rows.map((r) => r.c),
        l: rows.map((r) => r.c),
        c: rows.map((r) => r.c),
        volume: rows.map(() => '10'),
        transactions: rows.map(() => 2),
        traders: rows.map(() => 1),
        liquidity: rows.map(() => null),
      },
    });
    const boundary = from + 1500 * step; // first bucket of window 2
    const replies: FakeReply[] = [
      // Window 1 wrongly also returns the boundary bucket; window 2 returns it too.
      {
        body: gqlBody(
          columns([bar(from, 1), bar(boundary - step, 2), bar(boundary, 3)]),
          '4000000',
        ),
      },
      { body: gqlBody(columns([bar(boundary, 4), bar(boundary + step, 5)]), '4000000') },
    ];
    const { client, f } = make(replies);
    const bars = await client.getPoolBars({
      pairAddress: POOL,
      resolution: '1',
      from,
      to: from + 2880 * step,
    });
    expect(f.requests).toHaveLength(2);
    expect(f.requests[0]?.query).toContain(`from:${from}, to:${from + 1500 * step - 1}`);
    expect(f.requests[1]?.query).toContain(`from:${boundary}, to:${from + 2880 * step - 1}`);
    expect(bars.map((b) => b.t)).toEqual([from, boundary - step, boundary, boundary + step]);
    expect(bars.filter((b) => b.t === boundary)).toHaveLength(1);
    expect(bars.every((b) => b.liquidityUsd === null)).toBe(true);
  });

  it('48 hours of 1-minute bars costs 2 requests; one year of hourly bars costs 6', async () => {
    const empty = { getBars: { t: [], o: [], h: [], l: [], c: [] } };
    const a = make(() => ({ body: gqlBody(empty, '4000000') }));
    const from = 1_788_220_800;
    await a.client.getPoolBars({ pairAddress: POOL, resolution: '1', from, to: from + 2 * DAY });
    expect(a.f.requests).toHaveLength(2);
    const b = make(() => ({ body: gqlBody(empty, '4000000') }));
    await b.client.getPoolBars({
      pairAddress: POOL,
      resolution: '60',
      from: 1_767_225_600,
      to: 1_767_225_600 + 365 * DAY,
    });
    expect(b.f.requests).toHaveLength(6);
    expect(b.budget.summary('codex').requests).toBe(6);
    expect(b.budget.summary('codex').units).toBe(24);
  });
});

describe('discovery paging', () => {
  /** A fake filterTokens endpoint over a sorted list of migration times. */
  function serverOf(times: number[], maxDepth: number) {
    const rows = times.map((t, i) => ({ mint: `M${String(i).padStart(4, '0')}`, t }));
    const seen: Array<{ gte: number; lte: number; limit: number; offset: number }> = [];
    const answer = (req: { query: string }): FakeReply => {
      const num = (re: RegExp) => Number(re.exec(req.query)![1]);
      const gte = num(/gte:(\d+)/);
      const lte = num(/lte:(\d+)/);
      const limit = num(/limit:(\d+)/);
      const offset = num(/offset:(\d+)/);
      seen.push({ gte, lte, limit, offset });
      if (limit + offset > maxDepth) {
        return { body: JSON.stringify({ errors: [{ message: 'Limit + Offset too big' }] }) };
      }
      const page = rows.filter((r) => r.t >= gte && r.t <= lte).slice(offset, offset + limit);
      return {
        body: gqlBody(
          {
            filterTokens: {
              count: page.length,
              page: 0,
              results: page.map((r) => ({
                token: {
                  address: r.mint,
                  symbol: r.mint,
                  name: r.mint,
                  createdAt: r.t - 10,
                  creatorAddress: 'creator',
                  launchpad: {
                    launchpadName: 'Pump.fun',
                    migrated: true,
                    migratedAt: r.t,
                    migratedPoolAddress: null,
                    completed: true,
                    completedAt: r.t,
                    poolAddress: 'curve',
                  },
                },
                pair: { address: `pair-${r.mint}` },
                liquidity: '100',
              })),
            },
          },
          '5000000',
        ),
      };
    };
    return { answer, seen, rows };
  }

  it('walks many windows and returns every token once, oldest first', async () => {
    // 3 per second for 50 seconds across a 100-second range, with an empty stretch.
    const times: number[] = [];
    for (let t = 1000; t < 1050; t++) times.push(t, t, t);
    const server = serverOf(times, 10_000);
    const { client } = make((req) => server.answer(req));
    const tokens = await collect(
      client.discoverGraduated({ from: 1000, to: 1099 }, { windowSeconds: 20, pageSize: 7 }),
    );
    expect(tokens).toHaveLength(150);
    expect(new Set(tokens.map((t) => t.mint)).size).toBe(150);
    const ts = tokens.map((t) => t.migratedAt!);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
    // 5 windows; the first three have 60 rows (9 requests of 7), the 4th has 30 rows, the 5th is empty.
    expect(server.seen.every((s) => s.gte >= 1000 && s.lte <= 1099)).toBe(true);
    expect(Math.min(...server.seen.map((s) => s.gte))).toBe(1000);
    expect(Math.max(...server.seen.map((s) => s.lte))).toBe(1099);
  });

  it('restarts from the last migration time when a window is deeper than the API allows', async () => {
    // 60 tokens in ONE window, 2 per second, with the API only allowing limit + offset <= 12.
    const times: number[] = [];
    for (let t = 5000; t < 5030; t++) times.push(t, t);
    const server = serverOf(times, 12);
    const { client } = make((req) => server.answer(req));
    const tokens = await collect(
      client.discoverGraduated(
        { from: 5000, to: 5029 },
        { windowSeconds: 1000, pageSize: 4, maxDepth: 12 },
      ),
    );
    expect(tokens).toHaveLength(60);
    expect(new Set(tokens.map((t) => t.mint)).size).toBe(60);
    expect(tokens.map((t) => t.mint)).toEqual(server.rows.map((r) => r.mint));
    expect(server.seen.every((s) => s.limit + s.offset <= 12)).toBe(true);
    // It had to restart at least once, so some request starts after the window start.
    expect(server.seen.some((s) => s.gte > 5000)).toBe(true);
  });

  it('gives up with a clear error when more than maxDepth tokens share one second', async () => {
    const times = Array.from({ length: 30 }, () => 7000);
    const server = serverOf(times, 8);
    const { client } = make((req) => server.answer(req));
    await expect(
      collect(
        client.discoverGraduated(
          { from: 7000, to: 7000 },
          { windowSeconds: 10, pageSize: 4, maxDepth: 8 },
        ),
      ),
    ).rejects.toThrow(/sharing migration time/);
  });

  it('rejects an out-of-range page size', async () => {
    const { client } = make([{}]);
    await expect(
      collect(client.discoverGraduated({ from: 0, to: 1 }, { pageSize: 201 })),
    ).rejects.toThrow(RangeError);
  });
});

describe('cost metering', () => {
  it('takes the cost from the response when present', async () => {
    const { client, budget } = make([{ body: loadFixtureText('pairs-2024') }]);
    await client.getPools(MINT);
    const s = budget.summary('codex');
    expect(s.requests).toBe(1);
    expect(s.units).toBeCloseTo(microOf('pairs-2024'), 9);
    expect(s.estimatedUnits).toBe(0);
    expect(client.spend().units).toBe(s.units);
  });

  it('estimates and marks it when the response has no cost', async () => {
    const empty = { getBars: { t: [], o: [], h: [], l: [], c: [] } };
    const a = make([{ body: gqlBody(empty) }]);
    await a.client.getPoolBars({ pairAddress: POOL, resolution: '1', from: 0, to: 600 });
    expect(a.budget.summary('codex')).toMatchObject({
      requests: 1,
      units: 4,
      estimatedUnits: 4,
      estimatedRequests: 1,
    });

    // filterTokens: 5 units plus 0.0048 per token returned.
    const body = JSON.parse(loadFixtureText('filter-tokens-2026'));
    delete body.data.usageData;
    const n = body.data.filterTokens.results.length;
    const b = make([{ body: JSON.stringify(body) }]);
    await collect(b.client.discoverGraduated({ from: 1, to: 2 }));
    const s = b.budget.summary('codex');
    expect(s.estimatedRequests).toBe(1);
    expect(s.units).toBeCloseTo(5 + 0.0048 * n, 9);
  });

  it('sums mixed measured and estimated requests', async () => {
    const empty = { getBars: { t: [], o: [], h: [], l: [], c: [] } };
    const { client, budget } = make([
      { body: gqlBody(empty, '4000000') },
      { body: gqlBody(empty) },
    ]);
    await client.getPoolBars({ pairAddress: POOL, resolution: '1', from: 0, to: 60 });
    await client.getPoolBars({ pairAddress: POOL, resolution: '1', from: 0, to: 60 });
    expect(budget.summary('codex')).toMatchObject({ requests: 2, units: 8, estimatedUnits: 4 });
  });

  it('stops before the call that would pass the ceiling', async () => {
    const empty = { getBars: { t: [], o: [], h: [], l: [], c: [] } };
    const budget = new UnitBudget({ ceilingUnits: 10 });
    const { client, f } = make(() => ({ body: gqlBody(empty, '4000000') }), { budget });
    const call = () => client.getPoolBars({ pairAddress: POOL, resolution: '1', from: 0, to: 60 });
    await call();
    await call();
    await expect(call()).rejects.toBeInstanceOf(BudgetExceededError);
    expect(f.requests).toHaveLength(2);
    expect(budget.summary('codex')).toMatchObject({ requests: 2, units: 8, remaining: 2 });
  });

  it('holds the ceiling under 50 concurrent calls: exactly 10 fetches, 40 throw', async () => {
    const empty = { getBars: { t: [], o: [], h: [], l: [], c: [] } };
    const budget = new UnitBudget({ ceilingUnits: 40 }); // 10 calls at 4 units
    const pending: Array<() => void> = [];
    // Each fetch stays pending until released below.
    const f2 = fakeFetch(() => ({ body: gqlBody(empty, '4000000') }));
    const wired = new CodexClient({
      apiKey: KEY,
      fetch: (url, init) =>
        new Promise((resolve) => {
          pending.push(() => resolve(f2.fetch(url, init)));
        }),
      budget,
      http: { sleep: async () => {} },
    });
    const calls = Array.from({ length: 50 }, () =>
      wired.getPoolBars({ pairAddress: POOL, resolution: '1', from: 0, to: 60 }),
    );
    const settled = Promise.allSettled(calls);
    // Let every call reach its fetch (or its budget rejection) before any response arrives.
    await new Promise((r) => setTimeout(r, 0));
    expect(pending).toHaveLength(10);
    expect(budget.summary('codex').reservedUnits).toBe(40);
    pending.forEach((release) => release());
    const results = await settled;
    expect(f2.requests).toHaveLength(10);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(10);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(40);
    expect(
      rejected.every((r) => (r as PromiseRejectedResult).reason instanceof BudgetExceededError),
    ).toBe(true);
    expect(budget.summary('codex')).toMatchObject({ requests: 10, units: 40, reservedUnits: 0 });
  });
});

describe('failed calls are charged conservatively', () => {
  const cases: Array<[string, Parameters<typeof fakeFetch>[0], number]> = [
    ['HTTP 400', [{ status: 400 }], 1],
    ['HTTP 500 until retries run out (3 attempts)', [{ status: 500 }], 3],
    ['non-JSON body', [{ body: 'nope' }], 1],
    ['bad envelope', [{ body: '[]' }], 1],
    ['GraphQL errors', [{ body: JSON.stringify({ errors: [{ message: 'x' }] }) }], 1],
    [
      'schema mismatch',
      [{ body: gqlBody({ getBars: { t: [1], o: ['a'], h: [1], l: [1], c: [1] } }, '4000000') }],
      1,
    ],
    ['network error until retries run out', [{ throws: new Error('down') }], 3],
  ];
  for (const [name, answer, attempts] of cases) {
    it(`${name}: records ${attempts} estimated request(s) at the estimate`, async () => {
      const { client, budget, f } = make(answer);
      await expect(
        client.getPoolBars({ pairAddress: POOL, resolution: '1', from: 0, to: 60 }),
      ).rejects.toThrow();
      expect(f.requests).toHaveLength(attempts);
      expect(budget.summary('codex')).toMatchObject({
        requests: attempts,
        units: 4 * attempts,
        estimatedUnits: 4 * attempts,
        estimatedRequests: attempts,
        reservedUnits: 0,
      });
    });
  }

  it('a pairs failure is charged the full 250-pair estimate', async () => {
    const { client, budget } = make([{ status: 400 }]);
    await expect(client.getPools(MINT)).rejects.toThrow();
    expect(budget.summary('codex').units).toBeCloseTo(4 + 0.0048 * 250, 9);
  });
});

describe('dry run', () => {
  it('makes no network call and reports the plan', async () => {
    const { client, f, budget } = make(
      () => {
        throw new Error('fetch must not be called');
      },
      { dryRun: true },
    );
    const from = 1_788_220_800;

    expect(await client.getLaunchInfo(MINT)).toBeNull();
    expect(await client.getPools(MINT)).toEqual({ pools: [], truncated: false });
    expect(
      await client.getPoolBars({ pairAddress: POOL, resolution: '1', from, to: from + 2 * DAY }),
    ).toEqual([]);
    expect(
      await client.getPoolBars({
        pairAddress: POOL,
        resolution: '60',
        from: 1_767_225_600,
        to: 1_767_225_600 + 365 * DAY,
      }),
    ).toEqual([]);
    expect(await collect(client.discoverGraduated({ from, to: from + 3 * DAY - 1 }))).toEqual([]);

    expect(f.requests).toHaveLength(0);
    expect(budget.summary('codex').requests).toBe(0);

    const plan = client.plan();
    expect(plan.byOperation['token']).toEqual({ requests: 1, units: 4 });
    expect(plan.byOperation['pairs']?.requests).toBe(1);
    expect(plan.byOperation['pairs']?.units).toBeCloseTo(4 + 0.0048 * 250, 9);
    expect(plan.byOperation['bars']).toEqual({ requests: 8, units: 32 });
    expect(plan.byOperation['filterTokens']?.requests).toBe(3);
    expect(plan.byOperation['filterTokens']?.units).toBeCloseTo(3 * (5 + 0.0048 * 200), 9);
    expect(plan.totalRequests).toBe(1 + 1 + 8 + 3);
    expect(plan.totalUnits).toBeCloseTo(4 + 5.2 + 32 + 3 * 5.96, 9);
    expect(plan.lowerBoundOperations).toEqual(['filterTokens']);
    expect(plan.calls).toHaveLength(plan.totalRequests);
  });

  it('plan is empty outside dry-run mode before any call', () => {
    const { client } = make([{}]);
    expect(client.plan()).toMatchObject({ totalRequests: 0, totalUnits: 0, calls: [] });
  });
});

describe('errors', () => {
  it('throws a typed error carrying the GraphQL messages', async () => {
    const body = JSON.stringify({
      errors: [
        { message: 'Limit cannot be greater than 200', extensions: { code: 'OUT_OF_RANGE' } },
        { message: 'second' },
      ],
    });
    const { client } = make([{ body }]);
    const err = (await client.getPools(MINT).catch((e: unknown) => e)) as CodexGraphQLError;
    expect(err).toBeInstanceOf(CodexGraphQLError);
    expect(err.messages).toEqual(['Limit cannot be greater than 200', 'second']);
    expect(err.codes).toEqual(['OUT_OF_RANGE']);
  });

  it('throws CodexResponseError for a body that does not match the schema', async () => {
    const bad = gqlBody({
      getBars: { t: [1], o: ['abc'], h: [1], l: [1], c: [1] },
    });
    const { client } = make([{ body: bad }]);
    const err = await client
      .getPoolBars({ pairAddress: POOL, resolution: '1', from: 0, to: 60 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CodexResponseError);
    const notJson = make([{ body: '<html>' }]);
    await expect(notJson.client.getPools(MINT)).rejects.toBeInstanceOf(CodexResponseError);
  });

  it('retries a 429 through the client and meters both attempts', async () => {
    const { client, f, budget, clock } = make([
      { status: 429, headers: { 'retry-after': '2' } },
      { body: loadFixtureText('token-2026') },
    ]);
    await client.getLaunchInfo(MINT);
    expect(f.requests).toHaveLength(2);
    expect(clock.sleeps).toEqual([2000]);
    // Both HTTP attempts count; the failed one at the estimate (4), the good one as reported.
    const sp = budget.summary('codex');
    expect(sp.requests).toBe(2);
    expect(sp.units).toBeCloseTo(4 + microOf('token-2026'), 9);
    expect(sp.estimatedRequests).toBe(1);
  });

  it('sends the key only in the Authorization header and never leaks it in errors', async () => {
    const failures: Array<Parameters<typeof fakeFetch>[0]> = [
      [{ status: 401, body: 'nope' }],
      [{ status: 500 }],
      [{ throws: new Error(`socket closed ${KEY}`) }],
      [{ body: JSON.stringify({ errors: [{ message: 'Unauthorized' }] }) }],
      [{ body: 'not json' }],
    ];
    for (const answer of failures) {
      const { client, f } = make(answer);
      const err = (await client.getPools(MINT).catch((e: unknown) => e)) as Error;
      expect(err).toBeInstanceOf(Error);
      expect(f.requests[0]?.headers['Authorization']).toBe(KEY);
      expect(f.requests[0]?.query).not.toContain(KEY);
      const text = [err.message, String(err), err.stack ?? '', JSON.stringify(err)].join('\n');
      expect(text).not.toContain(KEY);
    }
    // And an HTTP failure is an HttpError.
    const { client } = make([{ status: 400 }]);
    await expect(client.getPools(MINT)).rejects.toBeInstanceOf(HttpError);
  });

  it('refuses a malformed address before any request is made', async () => {
    const { client, f } = make([{}]);
    await expect(client.getPools('x" ) { evil }')).rejects.toThrow(TypeError);
    await expect(client.getLaunchInfo('short')).rejects.toThrow(TypeError);
    expect(f.requests).toHaveLength(0);
  });
});

describe('rate limiter wiring', () => {
  it('passes every request, including retries, through the limiter', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({
      maxPerSecond: 2,
      burst: 1,
      now: clock.now,
      sleep: clock.sleep,
    });
    const times: number[] = [];
    const f = fakeFetch((_req, n) => {
      times.push(clock.now());
      return n < 2 ? { status: 500 } : { body: loadFixtureText('token-2026') };
    });
    const client = new CodexClient({
      apiKey: KEY,
      fetch: f.fetch,
      limiter,
      http: { sleep: clock.sleep, random: () => 0, baseDelayMs: 1, maxRetries: 3 },
    });
    await client.getLaunchInfo(MINT);
    expect(times).toHaveLength(3);
    // At 2 per second, three requests cannot all start inside one second.
    expect(times[2]! - times[0]!).toBeGreaterThanOrEqual(1000);
  });
});
