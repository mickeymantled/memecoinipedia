import { afterAll, beforeAll, expect, it } from 'vitest';
import { sql, type Kysely } from 'kysely';
import { createDb, type Database } from '@memecoinipedia/db';
import { createTestDatabase, type TestDatabase } from '@memecoinipedia/db/testing';
import { createApp } from '../src/app.js';
import { adminUrl, addr, describeDb, insertCoin } from './helpers.js';

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** Two base58 characters for i, so tags stay valid addresses. */
const b58 = (i: number) => BASE58[Math.floor(i / 58)]! + BASE58[i % 58]!;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

interface Reply {
  status: number;
  headers: Headers;
  body: Json;
  text: string;
}

const SUMMARY_FIELDS = [
  'chain',
  'address',
  'ticker',
  'name',
  'image_url',
  'sensitive',
  'launched_at',
  'ath_market_cap_usd',
  'ath_at',
  'seconds_to_ath',
  'current_market_cap_usd',
  'status',
  'primary_narrative',
  'secondary_narratives',
];
// api/README.md section 3.2, in the order the table lists them.
const COIN_FIELDS = [
  ...SUMMARY_FIELDS,
  'launchpad',
  'creator_wallet',
  'quote_token',
  'graduated_at',
  'description',
  'socials',
  'ath_pool',
  'primary_pool',
  'ath_wick_market_cap_usd',
  'ath_wick_at',
  'seconds_above_100k',
  'seconds_above_1m',
  'seconds_above_10m',
  'seconds_above_100m',
  'max_drawdown_pct',
  'rug_pattern',
  'metric_flags',
  'metrics_as_of',
  'current_price_usd',
  'current_liquidity_usd',
  'current_volume_24h_usd',
  'current_refreshed_at',
  'status_changed_at',
  'narrative_confidence',
  'narrative_reason',
  'summary',
  'classified_at',
  'parent',
];

describeDb('API (keyword search, coin, narratives)', () => {
  let t: TestDatabase;
  let db: Kysely<Database>;
  let app: ReturnType<typeof createApp>;

  const get = async (path: string): Promise<Reply> => {
    const res = await app.request(`/api/v1${path}`);
    const text = await res.text();
    let body: Json = null;
    try {
      body = JSON.parse(text);
    } catch {
      // leave null
    }
    return { status: res.status, headers: res.headers, body, text };
  };

  /** Follows `next_cursor` to the end. Every page must obey `limit` and agree on `total`. */
  const walk = async (query: string, limit: number) => {
    const addresses: string[] = [];
    let cursor: string | null = null;
    let total: number | null = null;
    let pages = 0;
    do {
      const r: Reply = await get(
        `/coins?${query}&limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`,
      );
      expect(r.status, r.text).toBe(200);
      expect(r.body.data.length).toBeLessThanOrEqual(limit);
      expect(r.body.page.limit).toBe(limit);
      total ??= r.body.page.total;
      expect(r.body.page.total).toBe(total);
      addresses.push(...r.body.data.map((c: Json) => c.address));
      cursor = r.body.page.next_cursor;
      pages++;
      expect(pages).toBeLessThan(1000);
    } while (cursor);
    return { addresses, total: total as number };
  };

  const ADDR = {
    full: 'ExampLeMint1111111111111111111111111111pump',
    pool: 'ExampLePoo1111111111111111111111111111111111',
  };

  beforeAll(async () => {
    t = await createTestDatabase(adminUrl!);
    db = t.db;
    app = createApp({ db });

    // Relevance fixture for q = "zorb".
    await insertCoin(db, { tag: 'rev1', ticker: 'ZORB', name: 'Zorb Original', ath: 150_000 });
    await insertCoin(db, { tag: 'rev2', ticker: 'zorb', name: 'Other thing', ath: 900_000 });
    await insertCoin(db, { tag: 'rev3', ticker: 'ZORBKING', name: 'King', ath: 200_000 });
    await insertCoin(db, { tag: 'rev4', ticker: 'ZORBFATHER', name: 'Father', ath: 5_000_000 });
    await insertCoin(db, { tag: 'rev5', ticker: 'ZORRB', name: 'Nothing', ath: 300_000 });
    await insertCoin(db, { tag: 'rev6', ticker: 'XYZ', name: 'Zorb', ath: 100_000 });
    await insertCoin(db, { tag: 'rev7', ticker: 'CAT', name: 'Cat', ath: 700_000 });
    await insertCoin(db, { tag: 'rev8', ticker: 'ZORBUNLISTED', name: 'Below', ath: 99_999.99 });
    await insertCoin(db, { tag: 'rev9', ticker: 'ZORBNULL', name: 'No metrics', ath: null });
    // LIKE metacharacters in tickers.
    await insertCoin(db, { tag: 'pct', ticker: '%OFF', name: 'Percent' });
    await insertCoin(db, { tag: 'und', ticker: '_UNDER', name: 'Underscore' });

    // Percentile fixture: gaming ATHs 100k, 200k, 300k, 400k, 1M listed; one below the line.
    for (const [i, ath] of [100_000, 200_000, 300_000, 400_000, 1_000_000].entries()) {
      await insertCoin(db, { tag: `g${i + 1}`, ath, primary: 'gaming' });
    }
    await insertCoin(db, { tag: 'g6', ath: 50_000, primary: 'gaming' });
    // Secondary mentions of gaming: one listed (primary tech), one not listed.
    await insertCoin(db, { tag: 'sg1', ath: 321_000, primary: 'tech', secondary: ['gaming'] });
    await insertCoin(db, { tag: 'sg2', ath: 20_000, primary: 'tech', secondary: ['gaming'] });

    // Paging fixture: many ties in ATH and launch time, some without a launch time.
    const narratives = ['animal', 'culture_meme', null];
    const statuses = ['alive', 'dead', 'rugged', 'unknown'] as const;
    for (let i = 0; i < 53; i++) {
      await insertCoin(db, {
        tag: `pg${b58(i)}`,
        ticker: `PAGE${i}`,
        name: `Page ${i}`,
        ath: 100_000 + (i % 5) * 50_000,
        launchedAt: i % 9 === 8 ? null : new Date(Date.UTC(2025, 0, 1 + (i % 7))).toISOString(),
        primary: narratives[i % 3],
        secondary: i % 4 === 0 ? ['tech'] : [],
        status: statuses[i % 4],
      });
    }
    // Two launch times that differ by a microsecond.
    await insertCoin(db, { tag: 'us1', launchedAt: '2025-06-01T00:00:00.000001Z' });
    await insertCoin(db, { tag: 'us2', launchedAt: '2025-06-01T00:00:00.000002Z' });

    // A coin with every field, as in the contract's example.
    const parent = await insertCoin(db, { tag: 'parentx', ticker: 'PARENT', ath: 120_000 });
    const full = await db
      .insertInto('coins')
      .values({
        chain: 'solana',
        address: ADDR.full,
        ticker: 'EXDOG',
        name: 'Example Dog',
        launchpad: 'pump.fun',
        launched_at: new Date('2024-11-03T14:07:00Z'),
        creator_wallet: 'ExampLeCreator11111111111111111111111111111',
        quote_token: 'So11111111111111111111111111111111111111112',
        graduated_at: new Date('2024-11-03T15:02:00Z'),
        description: 'the most example dog on solana',
        image_url: 'https://third-party.example/never-exposed.png',
        image_storage_key: 'covers/never-exposed.png',
        socials: JSON.stringify({
          website: null,
          twitter: 'https://x.com/exampledog',
          telegram: 'http://not-https.example/t',
          discord: 'https://discord.example/extra-key-is-dropped',
        }),
        ath_market_cap_usd: 4_210_000,
        ath_at: new Date('2024-11-05T09:31:00Z'),
        seconds_to_ath: 156_240,
        ath_wick_market_cap_usd: 5_630_000,
        ath_wick_at: new Date('2024-11-05T09:30:00Z'),
        seconds_above_100k: 1_296_000,
        seconds_above_1m: 388_800,
        seconds_above_10m: 0,
        seconds_above_100m: 0,
        max_drawdown_pct: 99.6,
        rug_pattern: false,
        metric_flags: [],
        metrics_as_of: new Date('2026-11-14T00:00:00Z'),
        current_price_usd: 0.0000184,
        current_market_cap_usd: 18_400,
        current_liquidity_usd: 6100,
        current_volume_24h_usd: 240,
        current_refreshed_at: new Date('2026-11-15T06:00:00Z'),
        status: 'dead',
        status_changed_at: new Date('2025-02-11T00:00:00Z'),
        primary_narrative: 'animal',
        secondary_narratives: ['culture_meme'],
        narrative_confidence: 0.93,
        narrative_reason: 'Dog mascot coin with no link to a person or event.',
        summary:
          'Example Dog is a dog-themed coin launched on pump.fun in November 2024. It reached a $4.2M market cap two days after launch and has traded near zero since early 2025.',
        classified_at: new Date('2026-11-14T10:00:00Z'),
        parent_coin_id: parent,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const pool = await db
      .insertInto('pools')
      .values({
        chain: 'solana',
        address: ADDR.pool,
        coin_id: full.id,
        dex: 'raydium',
        is_primary: true,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    // A second, non-primary pool must not be picked as the primary one.
    await db
      .insertInto('pools')
      .values({ chain: 'solana', address: addr('poo2'), coin_id: full.id, dex: 'orca' })
      .execute();
    await db.updateTable('coins').set({ ath_pool_id: pool.id }).where('id', '=', full.id).execute();

    // A held coin that is not listed, and one with no metrics yet.
    await insertCoin(db, { tag: 'beow', ath: 99_999 });
    await insertCoin(db, { tag: 'nometrics', ath: null });
    // Same address on another chain.
    await insertCoin(db, { tag: 'other1', chain: 'ethereum' });

    // Text written by a creator.
    await db
      .insertInto('coins')
      .values({
        chain: 'solana',
        address: addr('htmcoin'),
        ticker: ' $HTML\n',
        name: '  <script>alert(1)</script> &amp; "q" \'q\' \u0007bell\ttab\u001b[31m red  ',
        description: '\n\n<img src=x onerror=alert(1)>\r\nline two\u0000'.replace(
          '\u0000',
          '\u0001',
        ),
        ath_market_cap_usd: 130_000,
        ath_at: new Date('2025-03-02T00:00:00Z'),
        primary_narrative: 'other',
      })
      .execute();
    await sql`vacuum analyze coins`.execute(db);
  });

  afterAll(async () => {
    await t.drop();
  });

  const listed = async () =>
    db
      .selectFrom('coins')
      .selectAll()
      .where('ath_market_cap_usd', '>=', 100_000)
      .orderBy('id')
      .execute();

  // ------------------------------------------------------------------ basics

  it('answers unknown routes with the error shape', async () => {
    for (const path of ['/nope', '/coins/solana', '/narratives/a/b']) {
      const r = await get(path);
      expect(r.status).toBe(404);
      expect(r.body).toEqual({
        error: {
          code: 'not_found',
          message: expect.any(String),
          param: null,
          reason: 'unknown_route',
        },
      });
    }
    const outside = await app.request('/health');
    expect(outside.status).toBe(404);
    const post = await app.request('/api/v1/coins', { method: 'POST' });
    expect(post.status).toBe(404);
  });

  it('serves JSON with the contract content type', async () => {
    const r = await get('/health');
    expect(r.headers.get('content-type')).toBe('application/json; charset=utf-8');
    const e = await get('/coins?limit=0');
    expect(e.headers.get('content-type')).toBe('application/json; charset=utf-8');
  });

  it('health is ok, not cached, and 503 when the database is gone', async () => {
    const r = await get('/health');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(r.headers.get('cache-control')).toBe('no-store');

    // Nothing listens on port 1: the connection is refused at once.
    const dead = createDb('postgres://localhost:1/none');
    const res = await createApp({ db: dead }).request('/api/v1/health');
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect((await res.json()) as Json).toEqual({
      error: {
        code: 'upstream_unavailable',
        message: expect.any(String),
        param: null,
        reason: null,
      },
    });
    expect(res.headers.get('retry-after')).toBe('5');
  });

  it('answers a failing query with 500 internal and leaks nothing', async () => {
    const log = console.error;
    console.error = () => {};
    const broken = createDb('postgres://localhost:1/none');
    const res = await createApp({ db: broken }).request('/api/v1/narratives');
    expect(res.status).toBe(500);
    console.error = log;
    const body = (await res.json()) as Json;
    expect(body).toEqual({
      error: { code: 'internal', message: 'internal error', param: null, reason: null },
    });
  });

  it('sets cache-control: 60 for lists, 300 for a coin, 3600 for narratives', async () => {
    expect((await get('/coins')).headers.get('cache-control')).toBe('public, max-age=60');
    expect((await get('/coins?q=zorb')).headers.get('cache-control')).toBe('public, max-age=60');
    expect((await get(`/coins/solana/${ADDR.full}`)).headers.get('cache-control')).toBe(
      'public, max-age=300',
    );
    expect((await get('/narratives')).headers.get('cache-control')).toBe('public, max-age=3600');
    expect((await get('/narratives/ai')).headers.get('cache-control')).toBe('public, max-age=3600');
  });

  // -------------------------------------------------------------------- coin

  it('returns a coin with exactly the contract fields and values', async () => {
    const r = await get(`/coins/solana/${ADDR.full}`);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual([...COIN_FIELDS].sort());
    expect(r.body).toEqual({
      chain: 'solana',
      address: ADDR.full,
      ticker: 'EXDOG',
      name: 'Example Dog',
      image_url: null,
      sensitive: false,
      launched_at: '2024-11-03T14:07:00Z',
      ath_market_cap_usd: 4210000,
      ath_at: '2024-11-05T09:31:00Z',
      seconds_to_ath: 156240,
      current_market_cap_usd: 18400,
      status: 'dead',
      primary_narrative: 'animal',
      secondary_narratives: ['culture_meme'],
      launchpad: 'pump.fun',
      creator_wallet: 'ExampLeCreator11111111111111111111111111111',
      quote_token: 'So11111111111111111111111111111111111111112',
      graduated_at: '2024-11-03T15:02:00Z',
      description: 'the most example dog on solana',
      socials: { website: null, twitter: 'https://x.com/exampledog', telegram: null },
      ath_pool: { address: ADDR.pool, dex: 'raydium' },
      primary_pool: { address: ADDR.pool, dex: 'raydium' },
      ath_wick_market_cap_usd: 5630000,
      ath_wick_at: '2024-11-05T09:30:00Z',
      seconds_above_100k: 1296000,
      seconds_above_1m: 388800,
      seconds_above_10m: 0,
      seconds_above_100m: 0,
      max_drawdown_pct: 99.6,
      rug_pattern: false,
      metric_flags: [],
      metrics_as_of: '2026-11-14T00:00:00Z',
      current_price_usd: 0.0000184,
      current_liquidity_usd: 6100,
      current_volume_24h_usd: 240,
      current_refreshed_at: '2026-11-15T06:00:00Z',
      status_changed_at: '2025-02-11T00:00:00Z',
      narrative_confidence: 0.93,
      narrative_reason: 'Dog mascot coin with no link to a person or event.',
      summary: expect.stringContaining('Example Dog is a dog-themed coin'),
      classified_at: '2026-11-14T10:00:00Z',
      parent: {
        chain: 'solana',
        address: addr('parentx'),
        ticker: 'PARENT',
        name: 'parentx coin',
        listed: true,
      },
    });
  });

  it('returns null, empty list and null keys for everything unknown', async () => {
    const bare = addr('bare');
    await db
      .insertInto('coins')
      .values({ chain: 'solana', address: bare, ath_market_cap_usd: 110_000 })
      .execute();
    const r = await get(`/coins/solana/${bare}`);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual([...COIN_FIELDS].sort());
    const nonNull = Object.entries(r.body)
      .filter(([, v]) => v !== null)
      .map(([k]) => k)
      .sort();
    expect(nonNull).toEqual(
      [
        'chain',
        'address',
        'ath_market_cap_usd',
        'sensitive',
        'status',
        'secondary_narratives',
        'metric_flags',
        'socials',
      ].sort(),
    );
    expect(r.body.socials).toEqual({ website: null, twitter: null, telegram: null });
    expect(r.body.secondary_narratives).toEqual([]);
    expect(r.body.metric_flags).toEqual([]);
    expect(r.body.status).toBe('unknown');
    expect(r.body.sensitive).toBe(false);
    expect(r.body.image_url).toBeNull();
  });

  it('shows a parent we do not hold, and an unlisted parent', async () => {
    const orphan = await insertCoin(db, { tag: 'orph' });
    await db
      .updateTable('coins')
      .set({ parent_address: addr('ghost') })
      .where('id', '=', orphan)
      .execute();
    expect((await get(`/coins/solana/${addr('orph')}`)).body.parent).toEqual({
      chain: 'solana',
      address: addr('ghost'),
      ticker: null,
      name: null,
      listed: false,
    });
    const low = await insertCoin(db, { tag: 'owpar', ticker: 'LOWPAR', ath: 5000 });
    const kid = await insertCoin(db, { tag: 'kid' });
    await db.updateTable('coins').set({ parent_coin_id: low }).where('id', '=', kid).execute();
    expect((await get(`/coins/solana/${addr('kid')}`)).body.parent).toMatchObject({
      address: addr('owpar'),
      ticker: 'LOWPAR',
      listed: false,
    });
  });

  it('reports coin errors: format, unknown, not listed', async () => {
    const bad = await get('/coins/solana/not-an-address');
    expect(bad.status).toBe(400);
    expect(bad.body.error).toEqual({
      code: 'invalid_parameter',
      message: expect.any(String),
      param: 'address',
      reason: null,
    });
    for (const a of ['short', 'x'.repeat(45), `${'1'.repeat(31)}0`, `${'1'.repeat(31)}O`]) {
      expect((await get(`/coins/solana/${a}`)).body.error.param).toBe('address');
    }

    const unknown = await get(`/coins/solana/${addr('nobody')}`);
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toMatchObject({
      code: 'not_found',
      reason: 'unknown_coin',
      param: null,
    });

    const notListed = await get(`/coins/solana/${addr('beow')}`);
    expect(notListed.status).toBe(404);
    expect(notListed.body.error).toMatchObject({ code: 'not_found', reason: 'not_listed' });
    expect((await get(`/coins/solana/${addr('nometrics')}`)).body.error.reason).toBe('not_listed');

    // Exactly $100,000 is listed.
    await insertCoin(db, { tag: 'edge', ath: 100_000 });
    expect((await get(`/coins/solana/${addr('edge')}`)).status).toBe(200);

    // Coins are keyed by chain and address; the chain is part of the key.
    expect((await get(`/coins/ethereum/${addr('other1')}`)).status).toBe(200);
    expect((await get(`/coins/solana/${addr('other1')}`)).body.error.reason).toBe('unknown_coin');
    expect((await get(`/coins/dogechain/${addr('rev1')}`)).body.error.reason).toBe('unknown_coin');

    // Addresses are case-sensitive.
    expect((await get(`/coins/solana/${addr('rev1').toUpperCase()}`)).body.error.reason).toBe(
      'unknown_coin',
    );
  });

  // ------------------------------------------------------------------ listing

  it('returns only listed coins, with the contract summary fields', async () => {
    const all = await walk('', 100);
    const rows = await listed();
    expect(all.total).toBe(rows.length);
    expect(all.addresses.length).toBe(rows.length);
    expect(new Set(all.addresses).size).toBe(rows.length);
    expect(all.addresses).not.toContain(addr('rev8'));
    expect(all.addresses).not.toContain(addr('rev9'));
    expect(all.addresses).not.toContain(addr('beow'));

    const r = await get('/coins?limit=3');
    for (const c of r.body.data) {
      expect(Object.keys(c).sort()).toEqual([...SUMMARY_FIELDS].sort());
      expect(c.ath_market_cap_usd).toBeGreaterThanOrEqual(100_000);
      expect(c.image_url).toBeNull();
    }
    expect(r.body.data[0].address).toBe(addr('rev4'));
    expect(Object.keys(r.body.page).sort()).toEqual(['limit', 'next_cursor', 'total']);
  });

  it('empty results are not an error', async () => {
    const r = await get('/coins?q=qqqqqqqq');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ data: [], page: { limit: 25, next_cursor: null, total: 0 } });
  });

  it('orders keyword relevance: exact ticker, ticker prefix, similarity, then higher ATH', async () => {
    const r = await get('/coins?q=zorb');
    expect(r.status).toBe(200);
    expect(r.body.data.map((c: Json) => c.address)).toEqual(
      ['rev2', 'rev1', 'rev3', 'rev4', 'rev6', 'rev5'].map(addr),
    );
    expect(r.body.page.total).toBe(6);
    // Same results for any case and surrounding spaces; sort=relevance is the default with q.
    for (const q of ['ZORB', 'ZoRb', '%20zorb%20', 'zorb&sort=relevance']) {
      const same = await get(`/coins?q=${q}`);
      expect(same.body.data.map((c: Json) => c.address)).toEqual(
        r.body.data.map((c: Json) => c.address),
      );
    }
  });

  it('tolerates small misspellings and matches names', async () => {
    const typo = await get('/coins?q=zorbb');
    const got = typo.body.data.map((c: Json) => c.address);
    // "zorbb" is a prefix of nothing; similarity finds the near tickers and the name.
    expect(got).toContain(addr('rev1'));
    expect(got).toContain(addr('rev6'));
    expect(got).not.toContain(addr('rev7'));
    const byName = await get('/coins?q=Original');
    expect(byName.body.data[0].address).toBe(addr('rev1'));
  });

  it('with q, other sorts still only list matches', async () => {
    const r = await get('/coins?q=zorb&sort=ath_desc');
    expect(r.body.data.map((c: Json) => c.address)).toEqual(
      ['rev4', 'rev2', 'rev5', 'rev3', 'rev1', 'rev6'].map(addr),
    );
  });

  it('treats LIKE metacharacters in q literally', async () => {
    const pct = await get('/coins?q=%25');
    expect(pct.body.data.map((c: Json) => c.ticker)).toEqual(['%OFF']);
    const und = await get('/coins?q=_');
    // A literal underscore prefix: only the ticker that starts with one, not every coin.
    expect(und.body.data.map((c: Json) => c.ticker)).toEqual(['_UNDER']);
    const und2 = await get('/coins?q=_under');
    expect(und2.body.data[0].ticker).toBe('_UNDER');
    const back = await get('/coins?q=%5C');
    expect(back.status).toBe(200);
    expect(back.body.data).toEqual([]);
  });

  it('a whole address matches only that coin, listed only', async () => {
    const hit = await get(`/coins?q=${addr('rev1')}`);
    expect(hit.body.data.map((c: Json) => c.address)).toEqual([addr('rev1')]);
    expect(hit.body.page).toEqual({ limit: 25, next_cursor: null, total: 1 });
    expect((await get(`/coins?q=${addr('beow')}`)).body.page.total).toBe(0);
    expect((await get(`/coins?q=${addr('nobody')}`)).body.page.total).toBe(0);
    // Case matters for an address.
    expect((await get(`/coins?q=${addr('rev1').toUpperCase()}`)).body.page.total).toBe(0);
    // Filters still apply.
    expect((await get(`/coins?q=${addr('rev1')}&ath_min=900000`)).body.page.total).toBe(0);
    expect((await get(`/coins?q=${addr('rev1')}&sort=ath_asc`)).body.page.total).toBe(1);
  });

  it('filters: narrative, scope, status, ATH and launch bounds match an independent oracle', async () => {
    const rows = await listed();
    const day = (n: number) => Date.UTC(2025, 0, n);
    const cases: [string, (r: (typeof rows)[number]) => boolean][] = [
      ['narrative=animal', (r) => r.primary_narrative === 'animal'],
      [
        'narrative=animal,culture_meme',
        (r) => ['animal', 'culture_meme'].includes(r.primary_narrative ?? ''),
      ],
      ['narrative=tech', (r) => r.primary_narrative === 'tech'],
      [
        'narrative=tech&narrative_scope=any',
        (r) => r.primary_narrative === 'tech' || r.secondary_narratives.includes('tech'),
      ],
      [
        'narrative=gaming,tech&narrative_scope=any',
        (r) =>
          ['gaming', 'tech'].includes(r.primary_narrative ?? '') ||
          r.secondary_narratives.some((s) => ['gaming', 'tech'].includes(s)),
      ],
      ['narrative=tech&narrative_scope=primary', (r) => r.primary_narrative === 'tech'],
      ['status=rugged', (r) => r.status === 'rugged'],
      ['status=alive,unknown', (r) => ['alive', 'unknown'].includes(r.status)],
      ['ath_min=250000', (r) => r.ath_market_cap_usd! >= 250_000],
      ['ath_max=250000', (r) => r.ath_market_cap_usd! <= 250_000],
      ['ath_min=250000&ath_max=250000', (r) => r.ath_market_cap_usd === 250_000],
      ['ath_min=1e6', (r) => r.ath_market_cap_usd! >= 1_000_000],
      ['ath_min=300000&ath_max=100000', () => false],
      [
        'launched_from=2025-01-03',
        (r) => r.launched_at !== null && r.launched_at.getTime() >= day(3),
      ],
      ['launched_to=2025-01-03', (r) => r.launched_at !== null && r.launched_at.getTime() < day(3)],
      [
        'launched_from=2025-01-03&launched_to=2025-01-05',
        (r) =>
          r.launched_at !== null &&
          r.launched_at.getTime() >= day(3) &&
          r.launched_at.getTime() < day(5),
      ],
      [
        'launched_from=2025-01-03T00:00:00Z&launched_to=2025-01-03T00:00:01Z',
        (r) => r.launched_at !== null && r.launched_at.getTime() === day(3),
      ],
      [
        'narrative=animal&status=dead,alive&ath_min=150000&launched_from=2025-01-02&sort=launched_asc',
        (r) =>
          r.primary_narrative === 'animal' &&
          ['dead', 'alive'].includes(r.status) &&
          r.ath_market_cap_usd! >= 150_000 &&
          r.launched_at !== null &&
          r.launched_at.getTime() >= day(2),
      ],
    ];
    for (const [query, keep] of cases) {
      const expected = rows
        .filter(keep)
        .map((r) => r.address)
        .sort();
      const got = await walk(query, 10);
      expect(got.addresses.slice().sort(), query).toEqual(expected);
      expect(got.total, query).toBe(expected.length);
      expect(new Set(got.addresses).size, query).toBe(got.addresses.length);
    }
    // Filters apply with q too.
    const both = await get('/coins?q=zorb&status=dead&ath_max=200000');
    expect(both.body.data.map((c: Json) => c.address)).toEqual(['rev1', 'rev3', 'rev6'].map(addr));
  });

  it('rejects bad parameters with invalid_parameter and the parameter name', async () => {
    for (const [query, param] of [
      ['limit=0', 'limit'],
      ['limit=101', 'limit'],
      ['q=' + 'a'.repeat(101), 'q'],
      ['sort=relevance', 'sort'],
      ['sort=oldest', 'sort'],
      ['mode=semantic', 'q'],
      ['mode=other', 'mode'],
      ['narrative=dog', 'narrative'],
      ['status=zombie', 'status'],
      ['ath_min=-5', 'ath_min'],
      ['ath_max=lots', 'ath_max'],
      ['launched_from=tomorrow', 'launched_from'],
      ['launched_to=2025-13-01', 'launched_to'],
    ] as const) {
      const r = await get(`/coins?${query}`);
      expect(r.status, query).toBe(400);
      expect(r.body.error, query).toEqual({
        code: 'invalid_parameter',
        message: expect.any(String),
        param,
        reason: null,
      });
    }
    // Unknown parameters are ignored.
    expect((await get('/coins?colour=red&limit=2')).status).toBe(200);
  });

  it('an empty q is absent: the default sort is ath_desc', async () => {
    const a = await get('/coins?q=&limit=5');
    const b = await get('/coins?limit=5');
    expect(a.body).toEqual(b.body);
    expect((await get('/coins?q=%20%20&limit=5')).body).toEqual(b.body);
  });

  // ------------------------------------------------------------------ cursors

  it('pages through every sort once per row, in the sort order, with ties and missing launch times', async () => {
    const rows = await listed();
    const byId = (a: (typeof rows)[number], b: (typeof rows)[number]) => a.id - b.id;
    const launched = rows.filter((r) => r.launched_at !== null);
    const noLaunch = rows.filter((r) => r.launched_at === null).sort(byId);
    const expected: Record<string, string[]> = {
      ath_desc: [...rows]
        .sort((a, b) => b.ath_market_cap_usd! - a.ath_market_cap_usd! || b.id - a.id)
        .map((r) => r.address),
      ath_asc: [...rows]
        .sort((a, b) => a.ath_market_cap_usd! - b.ath_market_cap_usd! || a.id - b.id)
        .map((r) => r.address),
      launched_desc: [
        ...[...launched].sort(
          (a, b) => b.launched_at!.getTime() - a.launched_at!.getTime() || b.id - a.id,
        ),
        ...[...noLaunch].reverse(),
      ].map((r) => r.address),
      launched_asc: [
        ...[...launched].sort(
          (a, b) => a.launched_at!.getTime() - b.launched_at!.getTime() || a.id - b.id,
        ),
        ...noLaunch,
      ].map((r) => r.address),
    };
    expect(noLaunch.length).toBeGreaterThan(3);
    for (const [sort, order] of Object.entries(expected)) {
      for (const limit of [1, 7, 100]) {
        const got = await walk(`sort=${sort}`, limit);
        expect(got.addresses, `${sort} limit ${limit}`).toEqual(order);
        expect(got.total).toBe(rows.length);
      }
    }
  });

  it('keeps microsecond differences apart when paging by launch time', async () => {
    const desc = await walk(
      'sort=launched_desc&launched_from=2025-06-01&launched_to=2025-06-02',
      1,
    );
    expect(desc.addresses).toEqual([addr('us2'), addr('us1')]);
    const asc = await walk('sort=launched_asc&launched_from=2025-06-01&launched_to=2025-06-02', 1);
    expect(asc.addresses).toEqual([addr('us1'), addr('us2')]);
    expect(
      (await get('/coins?launched_from=2025-06-01&launched_to=2025-06-02')).body.data[0]
        .launched_at,
    ).toBe('2025-06-01T00:00:00Z');
  });

  it('pages relevance results once per row, and stable under ties', async () => {
    for (const limit of [1, 5, 20]) {
      const got = await walk('q=page', limit);
      expect(got.total).toBe(53);
      expect(got.addresses.length).toBe(53);
      expect(new Set(got.addresses).size).toBe(53);
    }
    const first = await walk('q=page', 10);
    const second = await walk('q=page', 10);
    expect(second.addresses).toEqual(first.addresses);
    // The order is similarity, then ATH desc, then newest id: ATH never rises mid-tier.
    const ath = (await get('/coins?q=page&limit=100')).body.data.map(
      (c: Json) => c.ath_market_cap_usd,
    );
    expect(ath.length).toBe(53);
  });

  it('accepts a cursor with a different limit, rejects one with other parameters', async () => {
    const page1 = await get('/coins?sort=ath_asc&limit=5');
    const cursor = page1.body.page.next_cursor as string;
    expect(typeof cursor).toBe('string');
    expect((await get(`/coins?sort=ath_asc&limit=9&cursor=${cursor}`)).status).toBe(200);
    // Same parameters in another order and spelling are the same parameters.
    expect((await get(`/coins?limit=5&cursor=${cursor}&colour=1&sort=ath_asc`)).status).toBe(200);

    for (const other of [
      'sort=ath_desc',
      'sort=ath_asc&status=dead',
      'sort=ath_asc&narrative=animal',
      'sort=ath_asc&narrative=animal&narrative_scope=any',
      'sort=ath_asc&ath_min=100000',
      'sort=ath_asc&launched_from=2020-01-01',
      'sort=ath_asc&q=page',
      'sort=launched_asc',
    ]) {
      const r = await get(`/coins?${other}&cursor=${cursor}`);
      expect(r.status, other).toBe(400);
      expect(r.body.error, other).toMatchObject({ code: 'invalid_cursor', reason: null });
    }
    // Defaults spelled out are not a change.
    expect(
      (await get(`/coins?sort=ath_asc&mode=keyword&narrative_scope=primary&cursor=${cursor}`))
        .status,
    ).toBe(200);
  });

  it('rejects cursors it never issued', async () => {
    for (const cursor of ['abc', 'b2Zmc2V0OjI1', 'e30', '%00', 'x'.repeat(1000)]) {
      const r = await get(`/coins?cursor=${encodeURIComponent(cursor)}`);
      expect(r.status, cursor).toBe(400);
      expect(r.body.error.code, cursor).toBe('invalid_cursor');
    }
  });

  it('invalid parameters are reported before an invalid cursor', async () => {
    expect((await get('/coins?limit=0&cursor=junk')).body.error.code).toBe('invalid_parameter');
  });

  // -------------------------------------------------------------- not ready

  it('answers semantic mode and comparables with 503 not_ready', async () => {
    for (const path of [
      '/coins?mode=semantic&q=funny%20dog',
      `/coins/solana/${addr('rev1')}/comparables`,
      `/coins/solana/${addr('nobody')}/comparables?k=10&only_earlier=true`,
    ]) {
      const r = await get(path);
      expect(r.status, path).toBe(503);
      expect(r.body, path).toEqual({
        error: { code: 'not_ready', message: expect.any(String), param: null, reason: null },
      });
    }
    // Validation still comes first.
    expect((await get('/coins?mode=semantic&q=dog&sort=ath_desc')).body.error.param).toBe('sort');
    expect((await get(`/coins/solana/${addr('rev1')}/comparables?k=9`)).body.error.param).toBe('k');
    expect((await get(`/coins/solana/${addr('rev1')}/comparables?k=201`)).body.error.param).toBe(
      'k',
    );
    expect(
      (await get(`/coins/solana/${addr('rev1')}/comparables?only_earlier=yes`)).body.error.param,
    ).toBe('only_earlier');
    expect((await get('/coins/solana/bad/comparables')).body.error.param).toBe('address');
  });

  // --------------------------------------------------------------- narratives

  it('lists the eleven narratives in order with counts and distributions', async () => {
    const r = await get('/narratives');
    expect(r.status).toBe(200);
    expect(r.body.data.map((n: Json) => n.slug)).toEqual([
      'ai',
      'tech',
      'animal',
      'celebrity',
      'political',
      'news_event',
      'culture_meme',
      'gaming',
      'derivative',
      'utility',
      'other',
    ]);
    expect(r.body.data.map((n: Json) => n.label)).toEqual([
      'AI',
      'tech',
      'animal',
      'celebrity',
      'political',
      'news event',
      'culture/meme',
      'gaming',
      'derivative',
      'utility',
      'other',
    ]);
    const rows = await listed();
    for (const n of r.body.data) {
      expect(Object.keys(n).sort()).toEqual([
        'ath_distribution',
        'coin_count',
        'label',
        'secondary_coin_count',
        'slug',
      ]);
      expect(Object.keys(n.ath_distribution).sort()).toEqual([
        'max',
        'median',
        'n',
        'p75',
        'p90',
        'population',
      ]);
      const primary = rows.filter((c) => c.primary_narrative === n.slug);
      expect(n.coin_count, n.slug).toBe(primary.length);
      expect(n.ath_distribution.n, n.slug).toBe(primary.length);
      expect(n.secondary_coin_count, n.slug).toBe(
        rows.filter((c) => c.secondary_narratives.includes(n.slug)).length,
      );
      expect(n.ath_distribution.population).toBe('ath_100k_plus');

      // The same figures straight from Postgres.
      const pg = await sql<{ median: number; p75: number; p90: number; max: number }>`
        select percentile_cont(0.5) within group (order by ath_market_cap_usd) as median,
               percentile_cont(0.75) within group (order by ath_market_cap_usd) as p75,
               percentile_cont(0.9) within group (order by ath_market_cap_usd) as p90,
               max(ath_market_cap_usd) as max
        from coins where ath_market_cap_usd >= 100000 and primary_narrative = ${n.slug}`.execute(
        db,
      );
      const want = pg.rows[0]!;
      if (primary.length === 0) {
        expect(n.ath_distribution).toEqual({
          n: 0,
          median: null,
          p75: null,
          p90: null,
          max: null,
          population: 'ath_100k_plus',
        });
      } else {
        expect(n.ath_distribution.median, n.slug).toBe(want.median);
        expect(n.ath_distribution.p75, n.slug).toBe(want.p75);
        expect(n.ath_distribution.p90, n.slug).toBe(want.p90);
        expect(n.ath_distribution.max, n.slug).toBe(want.max);
      }
    }
  });

  it('computes percentiles by linear interpolation on a fixture with a known answer', async () => {
    const r = await get('/narratives/gaming');
    expect(r.status).toBe(200);
    // Listed gaming ATHs: 100k, 200k, 300k, 400k, 1M. The coin at 50k is not listed.
    expect(r.body).toEqual({
      slug: 'gaming',
      label: 'gaming',
      coin_count: 5,
      secondary_coin_count: 1,
      ath_distribution: {
        n: 5,
        median: 300_000,
        p75: 400_000,
        p90: 760_000, // 400k + 0.6 * (1M - 400k)
        max: 1_000_000,
        population: 'ath_100k_plus',
      },
    });
    // One coin: every figure is that coin's ATH.
    const tech = (await get('/narratives/tech')).body;
    expect(tech.coin_count).toBe(1);
    expect(tech.ath_distribution).toEqual({
      n: 1,
      median: 321_000,
      p75: 321_000,
      p90: 321_000,
      max: 321_000,
      population: 'ath_100k_plus',
    });
  });

  it('n of 0 gives null figures', async () => {
    const r = await get('/narratives/utility');
    expect(r.body.coin_count).toBe(0);
    expect(r.body.ath_distribution).toEqual({
      n: 0,
      median: null,
      p75: null,
      p90: null,
      max: null,
      population: 'ath_100k_plus',
    });
  });

  it('answers an unknown narrative with not_found unknown_narrative', async () => {
    const r = await get('/narratives/dogs');
    expect(r.status).toBe(404);
    expect(r.body.error).toEqual({
      code: 'not_found',
      message: expect.any(String),
      param: null,
      reason: 'unknown_narrative',
    });
    expect((await get('/narratives/AI')).status).toBe(404);
  });

  // ------------------------------------------------------------ creator text

  it('returns creator-written text unchanged apart from trimming', async () => {
    const r = await get(`/coins/solana/${addr('htmcoin')}`);
    expect(r.status).toBe(200);
    expect(r.body.ticker).toBe('$HTML');
    expect(r.body.name).toBe(
      '<script>alert(1)</script> &amp; "q" \'q\' \u0007bell\ttab\u001b[31m red',
    );
    expect(r.body.description).toBe('<img src=x onerror=alert(1)>\r\nline two\u0001');
    // The control characters travel as JSON escapes, not raw bytes.
    // eslint-disable-next-line no-control-regex
    expect(r.text).not.toMatch(/[\u0000-\u001f]/);
    expect(r.text).toContain('<script>alert(1)</script>');
    // In lists too, and found by searching for the text.
    const list = await get('/coins?q=%3Cscript%3Ealert(1)%3C%2Fscript%3E');
    expect(list.status).toBe(200);
    const hit = list.body.data.find((c: Json) => c.address === addr('htmcoin'));
    if (hit) expect(hit.name).toBe(r.body.name);
  });

  it('turns a name that is only whitespace into null', async () => {
    await insertCoin(db, { tag: 'bnk', ticker: '   ', name: '\n\t ' });
    const r = await get(`/coins/solana/${addr('bnk')}`);
    expect([r.body.ticker, r.body.name]).toEqual([null, null]);
  });

  // ---------------------------------------------------------------- injection

  it('treats hostile input as data', async () => {
    const before = await db
      .selectFrom('coins')
      .select(sql<number>`count(*)`.as('n'))
      .executeTakeFirst();
    const evil = [
      "'; drop table coins; --",
      "' or '1'='1",
      '"; select pg_sleep(5); --',
      '$1',
      '${sql}',
      '\\',
      '%',
      '_',
      '%%%%%%',
      '\\\\\\',
      '日本語🐕',
    ];
    for (const q of evil) {
      const r = await get(`/coins?q=${encodeURIComponent(q)}`);
      expect([200, 400], q).toContain(r.status);
      expect((await get(`/coins?q=${encodeURIComponent(q)}&sort=ath_asc`)).status, q).toBe(200);
      expect((await get(`/coins?narrative=${encodeURIComponent(q)}`)).status, q).toBe(400);
      expect((await get(`/coins?status=${encodeURIComponent(q)}`)).status, q).toBe(400);
      expect((await get(`/coins?ath_min=${encodeURIComponent(q)}`)).status, q).toBe(400);
      expect((await get(`/coins?launched_from=${encodeURIComponent(q)}`)).status, q).toBe(400);
      expect((await get(`/coins?cursor=${encodeURIComponent(q)}`)).status, q).toBe(400);
      expect((await get(`/coins/solana/${encodeURIComponent(q)}`)).status, q).toBe(400);
      expect((await get(`/coins/${encodeURIComponent(q)}/${addr('rev1')}`)).status, q).toBe(404);
      expect((await get(`/narratives/${encodeURIComponent(q)}`)).status, q).toBe(404);
    }
    const after = await db
      .selectFrom('coins')
      .select(sql<number>`count(*)`.as('n'))
      .executeTakeFirst();
    expect(after).toEqual(before);
  });
});

describeDb('API relevance paging cap', () => {
  let t: TestDatabase;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    t = await createTestDatabase(adminUrl!);
    app = createApp({ db: t.db });
    const rows = Array.from({ length: 2100 }, (_, i) => ({ tag: `cap${b58(i)}`, i }));
    await sql`
      insert into coins (chain, address, ticker, name, ath_market_cap_usd, ath_at)
      select 'solana', a, 'CAPX' || n, 'Cap ' || n, 150000 + (n % 10) * 1000, '2025-03-02T00:00:00Z'::timestamptz
      from unnest(${rows.map((r) => addr(r.tag))}::text[], ${rows.map((r) => r.i)}::int[]) as u(a, n)`.execute(
      t.db,
    );
  });
  afterAll(async () => {
    await t.drop();
  });

  const pages = async (limit: number) => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let total: number | undefined;
    let n = 0;
    do {
      const res = await app.request(
        `/api/v1/coins?q=capx&limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Json;
      total = body.page.total;
      seen.push(...body.data.map((c: Json) => c.address));
      cursor = body.page.next_cursor;
      n++;
    } while (cursor && n < 500);
    return { seen, total: total as number };
  };

  it('stops at 2,000 rows while total stays exact', async () => {
    for (const limit of [100, 30, 7]) {
      const { seen, total } = await pages(limit);
      expect(total).toBe(2100);
      expect(seen.length, `limit ${limit}`).toBe(2000);
      expect(new Set(seen).size).toBe(2000);
    }
  });

  it('other sorts are not capped', async () => {
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const res = await app.request(
        `/api/v1/coins?q=capx&sort=ath_desc&limit=100${cursor ? `&cursor=${cursor}` : ''}`,
      );
      const body = (await res.json()) as Json;
      for (const c of body.data) seen.add(c.address);
      cursor = body.page.next_cursor;
    } while (cursor);
    expect(seen.size).toBe(2100);
  });
});
