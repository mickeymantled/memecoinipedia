import { describe, expect, it } from 'vitest';
import { BudgetExceededError, UnitBudget } from '../../../src/sources/budget.js';
import { HttpError } from '../../../src/sources/http.js';
import {
  HELIUS_PROVIDER,
  HeliusClient,
  HeliusResponseError,
  HeliusRpcError,
  transactionsForAddressCredits,
} from '../../../src/sources/helius/index.js';
import { RateLimiter } from '../../../src/sources/ratelimit.js';
import { fakeClock } from '../helpers.js';
import { fakeRpcFetch, fixtureText, rpcResult } from '../net-helpers.js';

const KEY = 'helius-test-key-0123456789abcdef';
const NON_TOKEN = '11111111111111111111111111111111';
const VANGOAT = '82DC7kRHVwkVEuK8NjbrwDDqbfkTrQWXuCp4T6C9noie';
const COP = 'copJmvZPQayNtCmaEMC9wGwQKvtw16PzHQEhesbsHsq';
const DODGE = 'DwpnoX1YvBSkRFUJyvgeYamptg7WEb3DvV315dAUpump';
const WIZARD = 'C8T9P27ABMvLHsRKEavFqa9etSsfw8EqkF2XkzT4pump';
const ROSE = 'HfVxfzmAPWER3LQ8VbDcbch6ACchbpuyXv3ujgRtpump';
const DUMACRATS = 'GqmP8uGseERgZYa7NAvzNrFw9qbGzMM6YnpwWiH46TGX';
const GOYIM = '9S8edqWxoWz5LYLnxWUmWBJnePg35WfdYQp7HQkUpump';
const FIXTURE_MINTS = [VANGOAT, COP, DODGE, WIZARD, ROSE, DUMACRATS, GOYIM, NON_TOKEN];
const DOG = 'GACuDtvf7EboY8SMiNyGorpWPc6tvXhKT4FGbQ6PpjF';

function client(
  f: ReturnType<typeof fakeRpcFetch>,
  extra: Partial<ConstructorParameters<typeof HeliusClient>[0]> = {},
) {
  const clock = fakeClock();
  return new HeliusClient({
    apiKey: KEY,
    fetch: f.fetch,
    http: { sleep: clock.sleep, random: () => 0.5, baseDelayMs: 10 },
    ...extra,
  });
}

describe('getAssets', () => {
  it('reads both metadata layouts and reports missing mints as not found', async () => {
    const f = fakeRpcFetch([{ body: fixtureText('helius', 'asset-batch') }]);
    const c = client(f);
    const assets = await c.getAssets(FIXTURE_MINTS);

    expect(assets.map((a) => a.mint)).toEqual(FIXTURE_MINTS);
    const by = Object.fromEntries(assets.map((a) => [a.mint, a]));

    // Classic SPL token, Metaplex metadata account (a 2024 coin).
    expect(by[VANGOAT]).toMatchObject({
      found: true,
      name: 'Vincent Van Goat',
      symbol: 'VANGOAT',
      layout: 'metaplex',
      tokenProgram: 'spl-token',
      decimals: 6,
      assetInterface: 'FungibleToken',
    });
    expect(by[VANGOAT]?.uri).toMatch(/^https:\/\/ipfs\.io\/ipfs\/Qm/);
    expect(by[VANGOAT]?.supply).toBe('968576629725860');
    expect(by[COP]?.uri).toMatch(/^https:\/\/gateway\.ipfs\.io\/ipfs\//);
    expect(by[DODGE]).toMatchObject({
      layout: 'metaplex',
      tokenProgram: 'spl-token',
      symbol: 'dodge',
    });

    // Token-2022, metadata in the mint extension (2026 coins).
    expect(by[ROSE]).toMatchObject({
      found: true,
      name: 'MissRose',
      symbol: 'Rose',
      layout: 'token-2022-extension',
      tokenProgram: 'token-2022',
      tokenProgramId: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
      decimals: 6,
    });
    expect(by[ROSE]?.uri).toBe(
      'https://ipfs.io/ipfs/bafkreicauvgfgkzpt66rewh6fih2by3mkqugwcx6zlgkx52gzkzohnreye',
    );
    for (const m of [ROSE, DUMACRATS, GOYIM]) {
      expect(by[m]?.tokenProgram, m).toBe('token-2022');
      expect(by[m]?.layout, m).toBe('token-2022-extension');
    }

    // An address that is not a token comes back as null.
    expect(by[NON_TOKEN]).toMatchObject({
      found: false,
      name: null,
      uri: null,
      tokenProgram: null,
    });
  });

  it('puts the key in a header and never in the URL', async () => {
    const f = fakeRpcFetch([{ body: rpcResult([null]) }]);
    await client(f).getAssets([NON_TOKEN]);
    const req = f.requests[0]!;
    expect(req.headers['x-api-key']).toBe(KEY);
    expect(req.url).not.toContain(KEY);
    expect(req.url).not.toContain('api-key');
    expect(req.url).toBe('https://mainnet.helius-rpc.com/');
    expect(req.headers['user-agent']).toBe('ingest-client/0.1');
    expect(req.method).toBe('getAssetBatch');
    expect(req.params).toEqual({ ids: [NON_TOKEN] });
  });

  it('splits batches at 1,000 mints and meters 10 credits per request', async () => {
    const mints = Array.from({ length: 2_500 }, (_, i) => `Mint${i}`);
    const f = fakeRpcFetch((req) => {
      const ids = (req.params as { ids: string[] }).ids;
      return { body: rpcResult(ids.map(() => null)) };
    });
    const c = client(f);
    const assets = await c.getAssets(mints);
    expect(f.requests).toHaveLength(3);
    expect(f.requests.map((r) => (r.params as { ids: string[] }).ids.length)).toEqual([
      1000, 1000, 500,
    ]);
    expect(assets).toHaveLength(2_500);
    expect(assets.every((a) => !a.found)).toBe(true);
    expect(c.spend()).toMatchObject({ requests: 3, units: 30, estimatedUnits: 30 });
  });

  it('exactly 1,000 mints is one request; 1,001 is two', async () => {
    const f = fakeRpcFetch((req) => ({
      body: rpcResult((req.params as { ids: string[] }).ids.map(() => null)),
    }));
    await client(f).getAssets(Array.from({ length: 1000 }, (_, i) => `M${i}`));
    expect(f.requests).toHaveLength(1);
    await client(f).getAssets(Array.from({ length: 1001 }, (_, i) => `M${i}`));
    expect(f.requests).toHaveLength(3);
  });

  it('removes duplicate mints and keeps first-seen order', async () => {
    const f = fakeRpcFetch((req) => ({
      body: rpcResult((req.params as { ids: string[] }).ids.map(() => null)),
    }));
    const assets = await client(f).getAssets(['B', 'A', 'B', 'A']);
    expect(assets.map((a) => a.mint)).toEqual(['B', 'A']);
    expect((f.requests[0]?.params as { ids: string[] }).ids).toEqual(['B', 'A']);
  });

  it('makes no request for an empty list', async () => {
    const f = fakeRpcFetch([{}]);
    expect(await client(f).getAssets([])).toEqual([]);
    expect(f.requests).toHaveLength(0);
  });

  it('ignores a NUL padding in on-chain strings', async () => {
    const body = rpcResult([
      {
        id: 'X',
        interface: 'FungibleToken',
        content: {
          json_uri: 'https://e.test/a.json\u0000\u0000',
          metadata: { name: 'Pad\u0000\u0000', symbol: 'P\u0000' },
        },
        token_info: {
          supply: 1000,
          decimals: 0,
          token_program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        },
      },
    ]);
    const [a] = await client(fakeRpcFetch([{ body }])).getAssets(['X']);
    expect(a).toMatchObject({ name: 'Pad', symbol: 'P', uri: 'https://e.test/a.json' });
  });

  it('throws a typed error on a response that does not match', async () => {
    const f = fakeRpcFetch([{ body: rpcResult({ not: 'an array' }) }]);
    await expect(client(f).getAssets(['X'])).rejects.toBeInstanceOf(HeliusResponseError);
    const g = fakeRpcFetch([{ body: 'not json' }]);
    await expect(client(g).getAssets(['X'])).rejects.toBeInstanceOf(HeliusResponseError);
  });
});

describe('credits and the budget', () => {
  it('records a retried request as every attempt charged', async () => {
    const f = fakeRpcFetch([{ status: 503 }, { status: 503 }, { body: rpcResult([null]) }]);
    const c = client(f);
    await c.getAssets(['X']);
    expect(f.requests).toHaveLength(3);
    expect(c.spend()).toMatchObject({ requests: 3, units: 30 });
  });

  it('charges a failed request, retries included', async () => {
    const f = fakeRpcFetch([{ status: 500 }]);
    const c = client(f, { http: { maxRetries: 1, sleep: async () => undefined, baseDelayMs: 1 } });
    await expect(c.getAssets(['X'])).rejects.toBeInstanceOf(HttpError);
    expect(c.spend()).toMatchObject({ requests: 2, units: 20, reservedUnits: 0 });
  });

  it('stops before the call that would pass the ceiling', async () => {
    const f = fakeRpcFetch((req) => ({
      body: rpcResult((req.params as { ids: string[] }).ids.map(() => null)),
    }));
    const c = client(f, { budget: new UnitBudget({ ceilingUnits: 25 }) });
    await c.getAssets(Array.from({ length: 2000 }, (_, i) => `M${i}`)); // 2 requests, 20 credits
    const err = await c.getAssets(['a', 'b']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect((err as BudgetExceededError).provider).toBe(HELIUS_PROVIDER);
    expect(f.requests).toHaveLength(2); // the third was never sent
    expect(c.spend().remaining).toBe(5);
  });

  it('a batch that does not fit stops partway: earlier batches are kept in the budget', async () => {
    const f = fakeRpcFetch((req) => ({
      body: rpcResult((req.params as { ids: string[] }).ids.map(() => null)),
    }));
    const c = client(f, { budget: new UnitBudget({ ceilingUnits: 15 }) });
    await expect(
      c.getAssets(Array.from({ length: 3000 }, (_, i) => `M${i}`)),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    expect(f.requests).toHaveLength(1);
    expect(c.spend().units).toBe(10);
  });

  it('prices getTransactionsForAddress at 10 credits per 100 full transactions, 10 at the least', () => {
    expect(transactionsForAddressCredits(1)).toBe(10);
    expect(transactionsForAddressCredits(100)).toBe(10);
    expect(transactionsForAddressCredits(101)).toBe(20);
  });

  it('waits on the rate limiter before each request', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({
      maxPerSecond: 1,
      burst: 1,
      now: clock.now,
      sleep: clock.sleep,
    });
    const f = fakeRpcFetch((req) => ({
      body: rpcResult((req.params as { ids: string[] }).ids.map(() => null)),
    }));
    await client(f, { limiter }).getAssets(Array.from({ length: 2000 }, (_, i) => `M${i}`));
    expect(clock.sleeps).toEqual([1000]);
  });
});

describe('dry run', () => {
  it('returns planned requests and credits without calling the API', async () => {
    const f = fakeRpcFetch([{}]);
    const c = client(f, { dryRun: true });
    expect(await c.getAssets(Array.from({ length: 2_500 }, (_, i) => `M${i}`))).toEqual([]);
    expect(await c.getCreateEvent(DOG)).toEqual({ status: 'dry_run' });
    expect(await c.getCreateEvent(DODGE)).toEqual({ status: 'dry_run' });

    expect(f.requests).toHaveLength(0);
    const plan = c.plan();
    expect(plan.totalRequests).toBe(5);
    expect(plan.totalCredits).toBe(50);
    expect(plan.byMethod['getAssetBatch']).toEqual({ requests: 3, credits: 30 });
    expect(plan.byMethod['getTransactionsForAddress']).toEqual({ requests: 2, credits: 20 });
    expect(plan.lowerBoundMethods).toEqual(['getTransactionsForAddress']);
    expect(c.spend().requests).toBe(0);
  });

  it('a dry-run client does not need the budget', async () => {
    const budget = new UnitBudget({ ceilingUnits: 0 });
    const c = client(fakeRpcFetch([{}]), { dryRun: true, budget });
    await c.getAssets(['X']);
    expect(c.plan().totalCredits).toBe(10);
  });
});

describe('the key never appears in an error', () => {
  const hostile = (body: string, status = 401): Parameters<typeof fakeRpcFetch>[0] => [
    { status, body },
  ];

  it('HTTP 401 whose body echoes the key and the URL form', async () => {
    const f = fakeRpcFetch(
      hostile(
        `{"error":"invalid key ${KEY}","url":"https://mainnet.helius-rpc.com/?api-key=${KEY}"}`,
      ),
    );
    const err = await client(f)
      .getAssets(['X'])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    const dump = JSON.stringify(err, Object.getOwnPropertyNames(err)) + String(err);
    expect(dump).not.toContain(KEY);
    expect((err as HttpError).bodySnippet).toContain('[redacted]');
    expect((err as HttpError).status).toBe(401);
  });

  it('a 500 that exhausts the retries', async () => {
    const f = fakeRpcFetch(hostile(`oops ${KEY}`, 500));
    const c = client(f, { http: { maxRetries: 1, sleep: async () => undefined, baseDelayMs: 1 } });
    const err = await c.getAssets(['X']).catch((e: unknown) => e);
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain(KEY);
  });

  it('a network error whose message carries the URL with the key', async () => {
    const f = fakeRpcFetch([
      { throws: new Error(`connect failed https://x.test/?api-key=${KEY}`) },
    ]);
    const c = client(f, { http: { maxRetries: 0 } });
    const err = await c.getAssets(['X']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain(KEY);
  });

  it('a JSON-RPC error whose message holds the key', async () => {
    const f = fakeRpcFetch([
      {
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          error: { code: -32401, message: `bad key ${KEY} and api-key=${KEY}` },
        }),
      },
    ]);
    const err = await client(f)
      .getAssets(['X'])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HeliusRpcError);
    expect((err as HeliusRpcError).code).toBe(-32401);
    expect(String(err)).not.toContain(KEY);
    expect(String(err)).toContain('[redacted]');
  });

  it('the client has no way to put the key in the URL', async () => {
    const f = fakeRpcFetch([{ body: rpcResult([]) }]);
    await client(f, { endpoint: 'https://custom.helius.test/' }).getAssets(['X']);
    expect(f.requests[0]?.url).toBe('https://custom.helius.test/');
  });

  it('refuses an empty key', () => {
    expect(() => new HeliusClient({ apiKey: '' })).toThrow();
  });
});

describe('getCreateEvent', () => {
  const fixtureCases = [
    {
      tag: '2024',
      mint: DOG,
      blockTime: 1716958727,
      creator: '35ewnxgogdtPLKMhAvLT9QMR75qfvcTnz14Q5HDuYsBo',
      slot: 268572068,
    },
    {
      tag: '2025',
      mint: DODGE,
      blockTime: 1737307481,
      creator: 'HaYtBw8VCwQji3BbjQtUtuP4Gx5uKxsWUfNuVyxX3aEK',
      slot: 315044198,
    },
    {
      tag: '2026',
      mint: ROSE,
      blockTime: 1775866192,
      creator: '9s2u7ZHqQdsmLzgA7ynL4ftYqV6KLvyoRvQs3cGGhph7',
      slot: 412395575,
    },
  ];
  for (const t of fixtureCases) {
    it(`resolves the ${t.tag} coin in one request and 10 credits`, async () => {
      const f = fakeRpcFetch([{ body: fixtureText('helius', `create-event-${t.tag}`) }]);
      const c = client(f);
      const r = await c.getCreateEvent(t.mint);
      expect(r).toMatchObject({
        status: 'resolved',
        mint: t.mint,
        slot: t.slot,
        blockTime: t.blockTime,
        creator: t.creator,
        requests: 1,
        credits: 10,
      });
      expect(r.status === 'resolved' && r.signature.length).toBeGreaterThan(60);
      expect(c.spend()).toMatchObject({ requests: 1, units: 10 });
      // Oldest first, full transactions, succeeded only.
      expect(f.requests[0]?.method).toBe('getTransactionsForAddress');
      const [address, config] = f.requests[0]!.params as [string, Record<string, unknown>];
      expect(address).toBe(t.mint);
      expect(config).toMatchObject({
        sortOrder: 'asc',
        transactionDetails: 'full',
        filters: { status: 'succeeded' },
      });
      expect(config['limit']).toBe(3);
    });
  }

  const row = (slot: number, signer: boolean, payer = 'Payer1111', mint = 'MintX') => ({
    slot,
    blockTime: 1_700_000_000 + slot,
    meta: { err: null },
    transaction: {
      signatures: [`sig${slot}`],
      message: {
        accountKeys: [
          { pubkey: payer, signer: true, writable: true },
          { pubkey: mint, signer, writable: true },
        ],
      },
    },
  });
  const page = (rows: unknown[], token: string | null) =>
    rpcResult({ data: rows, paginationToken: token });

  it('skips an earlier transaction that only touches the mint, and picks the one the mint signed', async () => {
    const f = fakeRpcFetch([{ body: page([row(1, false), row(2, true, 'Dev2222')], null) }]);
    const r = await client(f).getCreateEvent('MintX');
    expect(r).toMatchObject({ status: 'resolved', slot: 2, creator: 'Dev2222', signature: 'sig2' });
  });

  it('returns unresolved when the mint is in no transaction', async () => {
    const f = fakeRpcFetch([{ body: page([], null) }]);
    const c = client(f);
    const r = await c.getCreateEvent('MintX');
    expect(r).toEqual({
      status: 'unresolved',
      mint: 'MintX',
      reason: 'no_transactions',
      requests: 1,
      credits: 10,
    });
  });

  it('returns unresolved, not more paging, when no transaction qualifies and nothing is left', async () => {
    const f = fakeRpcFetch([{ body: page([row(1, false)], null) }]);
    const r = await client(f).getCreateEvent('MintX');
    expect(r).toMatchObject({ status: 'unresolved', reason: 'no_create_in_bound', requests: 1 });
  });

  it('pages at most 3 requests, then returns unresolved even though more pages exist', async () => {
    const f = fakeRpcFetch((_req, n) => ({ body: page([row(n + 1, false)], `tok${n + 1}`) }));
    const c = client(f);
    const r = await c.getCreateEvent('MintX');
    expect(r).toMatchObject({
      status: 'unresolved',
      reason: 'no_create_in_bound',
      requests: 3,
      credits: 30,
    });
    expect(f.requests).toHaveLength(3);
    // The second and third requests carry the token from the page before.
    expect((f.requests[1]?.params as [string, Record<string, unknown>])[1]['paginationToken']).toBe(
      'tok1',
    );
    expect((f.requests[2]?.params as [string, Record<string, unknown>])[1]['paginationToken']).toBe(
      'tok2',
    );
    expect(c.spend().requests).toBe(3);
  });

  it('finds the creation on the second page', async () => {
    const f = fakeRpcFetch((_req, n) =>
      n === 0
        ? { body: page([row(1, false)], 'tok1') }
        : { body: page([row(2, true, 'Dev')], null) },
    );
    const r = await client(f).getCreateEvent('MintX');
    expect(r).toMatchObject({ status: 'resolved', creator: 'Dev', requests: 2, credits: 20 });
  });

  it('the bound is configurable', async () => {
    const f = fakeRpcFetch((_req, n) => ({ body: page([row(n + 1, false)], `t${n}`) }));
    const r = await client(f, { maxCreateEventRequests: 1 }).getCreateEvent('MintX');
    expect(f.requests).toHaveLength(1);
    expect(r).toMatchObject({ status: 'unresolved', requests: 1 });
  });

  it('counts retries inside the bound: three requests in all, never four', async () => {
    const f = fakeRpcFetch([{ status: 503 }]);
    const c = client(f);
    const err = await c.getCreateEvent('MintX').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(f.requests).toHaveLength(3);
    expect(c.spend()).toMatchObject({ requests: 3, units: 30 });
  });

  it('a retry uses up part of the bound for paging', async () => {
    const f = fakeRpcFetch((_req, n) =>
      n === 0 ? { status: 503 } : { body: page([row(n, false)], `t${n}`) },
    );
    const r = await client(f).getCreateEvent('MintX');
    // 1: 503, 2: page one (token), 3: page two. The bound is spent.
    expect(f.requests).toHaveLength(3);
    expect(r).toMatchObject({ status: 'unresolved', requests: 3 });
  });

  it('does not accept a first transaction whose payer is the mint itself', async () => {
    const f = fakeRpcFetch([{ body: page([row(1, true, 'MintX')], null) }]);
    const r = await client(f).getCreateEvent('MintX');
    expect(r.status).toBe('unresolved');
  });

  it('stops at the budget ceiling before calling', async () => {
    const f = fakeRpcFetch([{ body: page([], null) }]);
    const c = client(f, { budget: new UnitBudget({ ceilingUnits: 5 }) });
    await expect(c.getCreateEvent('MintX')).rejects.toBeInstanceOf(BudgetExceededError);
    expect(f.requests).toHaveLength(0);
  });

  it('rejects bad options', () => {
    expect(() => new HeliusClient({ apiKey: KEY, maxCreateEventRequests: 0 })).toThrow(RangeError);
    expect(() => new HeliusClient({ apiKey: KEY, createEventPageSize: 101 })).toThrow(RangeError);
  });
});
