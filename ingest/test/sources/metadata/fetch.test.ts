import { describe, expect, it } from 'vitest';
import { MetadataFetcher, fetchTokenMetadata } from '../../../src/sources/metadata/index.js';
import { fakeClock } from '../helpers.js';
import { fakeGetFetch, fixtureText, type GetReply, type GetRequest } from '../net-helpers.js';

const V0 = 'QmYfe8zVGHA1heej47AkBX3Nnetg2h2kqj5yymz1xyKeHb';
const V1 = 'bafkreicauvgfgkzpt66rewh6fih2by3mkqugwcx6zlgkx52gzkzohnreye';
const AR = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
const A = 'https://gw-a.example.test';
const B = 'https://gw-b.example.test';
const C = 'https://gw-c.example.test';

function setup(
  answer: ((req: GetRequest, n: number) => GetReply) | GetReply[],
  extra: ConstructorParameters<typeof MetadataFetcher>[0] = {},
) {
  const f = fakeGetFetch(answer);
  const clock = fakeClock();
  const fetcher = new MetadataFetcher({
    ipfsGateways: [A, B, C],
    fetch: f.fetch,
    now: clock.now,
    sleep: clock.sleep,
    random: () => 0.5,
    gatewayMaxPerSecond: 1000,
    ...extra,
  });
  return { f, clock, fetcher };
}

const ok = (json: unknown): GetReply => ({ body: JSON.stringify(json) });

describe('every URI form reaches the right URL', () => {
  const json = { name: 'x', symbol: 'X' };

  it('ipfs://<cid>', async () => {
    const { f, fetcher } = setup([ok(json)]);
    const r = await fetcher.fetch(`ipfs://${V0}`);
    expect(r.outcome).toBe('ok');
    expect(f.requests[0]?.url).toBe(`${A}/ipfs/${V0}`);
  });

  it('ipfs://<cid>/path with a CIDv1', async () => {
    const { f, fetcher } = setup([ok(json)]);
    await fetcher.fetch(`ipfs://${V1}/meta.json`);
    expect(f.requests[0]?.url).toBe(`${A}/ipfs/${V1}/meta.json`);
  });

  it('a path gateway URI uses the configured gateways, not its own host', async () => {
    const { f, fetcher } = setup([ok(json)]);
    await fetcher.fetch(`https://ipfs.io/ipfs/${V0}`);
    expect(f.requests.map((r) => r.url)).toEqual([`${A}/ipfs/${V0}`]);
  });

  it('a subdomain gateway URI', async () => {
    const { f, fetcher } = setup([ok(json)]);
    const r = await fetcher.fetch(`https://${V1}.ipfs.dweb.link/m.json`);
    expect(r.outcome).toBe('ok');
    expect(f.requests[0]?.url).toBe(`${A}/ipfs/${V1}/m.json`);
  });

  it('ar://', async () => {
    const { f, fetcher } = setup([ok(json)], { arweaveGateways: ['https://ar.example.test'] });
    const r = await fetcher.fetch(`ar://${AR}`);
    expect(r.outcome).toBe('ok');
    expect(f.requests[0]?.url).toBe(`https://ar.example.test/${AR}`);
  });

  it('https://arweave.net/<id>', async () => {
    const { f, fetcher } = setup([ok(json)], { arweaveGateways: ['https://ar.example.test'] });
    await fetcher.fetch(`https://arweave.net/${AR}`);
    expect(f.requests[0]?.url).toBe(`https://ar.example.test/${AR}`);
  });

  it('plain https is fetched as it is', async () => {
    const { f, fetcher } = setup([ok(json)]);
    const r = await fetcher.fetch('https://example.com/meta.json');
    expect(r.outcome).toBe('ok');
    expect(r.gateway).toBe('example.com');
    expect(f.requests[0]?.url).toBe('https://example.com/meta.json');
  });
});

describe('outcome: ok', () => {
  it('returns parsed fields, the untouched JSON and the answering gateway', async () => {
    const body = fixtureText('metadata', 'token-2024');
    const { fetcher } = setup([{ status: 404 }, { body }]);
    const r = await fetcher.fetch(`ipfs://${V0}`);
    expect(r.outcome).toBe('ok');
    expect(r.gateway).toBe('gw-b.example.test');
    expect(r.metadata?.name).toBe('Vincent Van Goat');
    expect(r.metadata?.twitter).toBe('https://x.com/TheVincentVanG');
    expect(r.raw).toEqual(JSON.parse(body));
    expect(r.attempts.map((a) => [a.gateway, a.result])).toEqual([
      ['gw-a.example.test', 'not_found'],
      ['gw-b.example.test', 'ok'],
    ]);
  });

  it('reads a UTF-8 BOM', async () => {
    const { fetcher } = setup([{ body: '﻿{"name":"b"}' }]);
    expect((await fetcher.fetch(`ipfs://${V0}`)).metadata?.name).toBe('b');
  });
});

describe('outcome: not_found', () => {
  it('when every gateway answered 404', async () => {
    const { f, fetcher } = setup([{ status: 404 }]);
    const r = await fetcher.fetch(`ipfs://${V0}`);
    expect(r.outcome).toBe('not_found');
    expect(r.gateway).toBeNull();
    expect(f.requests).toHaveLength(3);
    expect(r.attempts.every((a) => a.result === 'not_found' && a.status === 404)).toBe(true);
  });

  it('a mix of 404 and 410 is still not_found', async () => {
    const { fetcher } = setup([{ status: 404 }, { status: 410 }, { status: 404 }]);
    expect((await fetcher.fetch(`ipfs://${V0}`)).outcome).toBe('not_found');
  });
});

describe('outcome: unreachable', () => {
  it('when every gateway timed out or failed', async () => {
    const { fetcher } = setup([
      { throws: Object.assign(new Error('aborted'), { name: 'AbortError' }) },
      { status: 503 },
      { throws: new Error('ECONNRESET') },
    ]);
    const r = await fetcher.fetch(`ipfs://${V0}`);
    expect(r.outcome).toBe('unreachable');
    expect(r.attempts.map((a) => a.result)).toEqual(['timeout', 'server_error', 'network_error']);
  });

  it('a 404 next to a 429 is not "not found": someone could not answer', async () => {
    const { fetcher } = setup([{ status: 404 }, { status: 429 }, { status: 404 }]);
    const r = await fetcher.fetch(`ipfs://${V0}`);
    expect(r.outcome).toBe('unreachable');
    expect(r.attempts[1]?.result).toBe('rate_limited');
  });

  it('other 4xx statuses count as unreachable', async () => {
    const { fetcher } = setup([{ status: 403 }, { status: 402 }, { status: 403 }]);
    const r = await fetcher.fetch(`ipfs://${V0}`);
    expect(r.outcome).toBe('unreachable');
    expect(r.attempts[0]?.result).toBe('bad_status');
  });
});

describe('gateway fall-through', () => {
  it('moves on after a timeout, a 429, a 5xx and a 404, and stops at the first success', async () => {
    const { f, fetcher } = setup(
      [
        { throws: Object.assign(new Error('t'), { name: 'AbortError' }) },
        { status: 429 },
        { status: 502 },
        { status: 404 },
        ok({ name: 'found' }),
      ],
      {
        ipfsGateways: [
          A,
          B,
          C,
          'https://gw-d.example.test',
          'https://gw-e.example.test',
          'https://gw-f.example.test',
        ],
      },
    );
    const r = await fetcher.fetch(`ipfs://${V0}`);
    expect(r.outcome).toBe('ok');
    expect(r.gateway).toBe('gw-e.example.test');
    expect(f.requests).toHaveLength(5); // gw-f is never asked
  });

  it('a dead original host does not stop the fall-through', async () => {
    const { f, fetcher } = setup(
      (req) =>
        req.url.startsWith('https://cf-ipfs.com')
          ? { throws: Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }) }
          : ok({ name: 'via gateway' }),
      { tryOriginalHost: true },
    );
    const r = await fetcher.fetch(`https://cf-ipfs.com/ipfs/${V0}`);
    expect(r.outcome).toBe('ok');
    expect(r.attempts.map((a) => [a.gateway, a.result])).toEqual([
      ['cf-ipfs.com', 'network_error'],
      ['gw-a.example.test', 'ok'],
    ]);
    expect(f.requests[0]?.url).toBe(`https://cf-ipfs.com/ipfs/${V0}`);
  });

  it('does not ask the same host twice when the original host is also a configured gateway', async () => {
    const { f, fetcher } = setup([{ status: 404 }], { tryOriginalHost: true });
    await fetcher.fetch(`${A}/ipfs/${V0}`);
    expect(f.requests.filter((r) => r.url.startsWith(A))).toHaveLength(1);
  });

  it('an invalid body on one gateway does not hide a good one on the next', async () => {
    const { fetcher } = setup([{ body: '<html>interstitial</html>' }, ok({ name: 'real' })]);
    const r = await fetcher.fetch(`ipfs://${V0}`);
    expect(r.outcome).toBe('ok');
    expect(r.attempts.map((a) => a.result)).toEqual(['invalid', 'ok']);
  });
});

describe('outcome: invalid', () => {
  for (const [label, body] of [
    ['not JSON', '<html>hi</html>'],
    ['a JSON array', '[1,2,3]'],
    ['JSON null', 'null'],
    ['a JSON string', '"hello"'],
    ['a JSON number', '42'],
    ['empty', ''],
  ] as const) {
    it(`${label}`, async () => {
      const { fetcher } = setup([{ body }]);
      const r = await fetcher.fetch(`ipfs://${V0}`);
      expect(r.outcome).toBe('invalid');
      expect(r.gateway).toBe('gw-a.example.test');
      expect(r.metadata).toBeNull();
      expect(r.raw).toBeNull();
    });
  }

  it('invalid wins over 404 elsewhere: a gateway did answer, with junk', async () => {
    const { fetcher } = setup([{ status: 404 }, { body: 'junk' }, { status: 404 }]);
    expect((await fetcher.fetch(`ipfs://${V0}`)).outcome).toBe('invalid');
  });
});

describe('outcome: too_large', () => {
  it('cuts the body off at 256 KB by default and stops without trying other gateways', async () => {
    const chunk = new Uint8Array(100 * 1024).fill(32);
    const { f, fetcher } = setup([{ body: [chunk, chunk, chunk, chunk, chunk] }]);
    const r = await fetcher.fetch(`ipfs://${V0}`);
    expect(r.outcome).toBe('too_large');
    expect(r.gateway).toBe('gw-a.example.test');
    expect(f.requests).toHaveLength(1);
    // 100 KB chunks: the third passes 256 KB. Chunks four and five are never read.
    expect(f.pulled[0]).toBe(3);
  });

  it('a declared Content-Length over the cap is refused before reading', async () => {
    const { f, fetcher } = setup([{ body: '{}', headers: { 'content-length': '300000' } }]);
    expect((await fetcher.fetch(`ipfs://${V0}`)).outcome).toBe('too_large');
    expect(f.pulled[0]).toBe(0);
  });

  it('a body of exactly 256 KB is accepted', async () => {
    const pad = ' '.repeat(256 * 1024 - 2);
    const { fetcher } = setup([{ body: `{}${pad}` }]);
    expect((await fetcher.fetch(`ipfs://${V0}`)).outcome).toBe('ok');
  });

  it('the cap is configurable', async () => {
    const { fetcher } = setup([{ body: JSON.stringify({ name: 'a'.repeat(200) }) }], {
      maxBytes: 100,
    });
    expect((await fetcher.fetch(`ipfs://${V0}`)).outcome).toBe('too_large');
  });
});

describe('outcome: unsupported_uri', () => {
  for (const uri of [
    '',
    'ftp://example.com/x',
    'data:text/plain,hi',
    'ipfs://nope',
    'not a uri',
    'https://user:pw@example.com/x',
  ]) {
    it(`${uri || '(empty)'}`, async () => {
      const { f, fetcher } = setup([ok({})]);
      const r = await fetcher.fetch(uri);
      expect(r.outcome).toBe('unsupported_uri');
      expect(r.detail).toBeTruthy();
      expect(r.attempts).toEqual([]);
      expect(f.requests).toHaveLength(0);
    });
  }
});

describe('private-address block (the fetcher)', () => {
  const targets = [
    'http://127.0.0.1/meta.json',
    'http://localhost/meta.json',
    'http://10.0.0.1/meta.json',
    'http://192.168.1.1/meta.json',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/meta.json',
    'http://[::ffff:7f00:1]/meta.json',
    'http://[fd00::1]/meta.json',
  ];
  for (const uri of targets) {
    it(`never requests ${uri}`, async () => {
      const { f, fetcher } = setup([ok({ name: 'secret' })]);
      const r = await fetcher.fetch(uri);
      expect(r.outcome).toBe('unsupported_uri');
      expect(r.attempts[0]?.result).toBe('blocked');
      expect(f.requests).toHaveLength(0);
    });
  }

  it('refuses a redirect to a private address, after the first hop', async () => {
    const { f, fetcher } = setup((req) =>
      req.url.startsWith(A)
        ? { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } }
        : ok({ name: 'secret' }),
    );
    const r = await fetcher.fetch(`ipfs://${V0}`);
    expect(r.attempts[0]).toMatchObject({ gateway: 'gw-a.example.test', result: 'blocked' });
    expect(f.requests.some((x) => x.url.includes('169.254'))).toBe(false);
    // The next gateway is still asked and answers.
    expect(r.outcome).toBe('ok');
  });

  it('when every attempt is refused the outcome is unsupported_uri', async () => {
    const { fetcher } = setup(() => ({ status: 301, headers: { location: 'http://10.1.1.1/' } }));
    const r = await fetcher.fetch(`ipfs://${V0}`);
    expect(r.outcome).toBe('unsupported_uri');
    expect(r.attempts.map((a) => a.result)).toEqual(['blocked', 'blocked', 'blocked']);
  });
});

describe('redirects', () => {
  it('follows up to three by hand and counts the requests', async () => {
    const { f, fetcher } = setup((_req, n) =>
      n < 3 ? { status: 302, headers: { location: `${A}/hop${n + 1}` } } : ok({ name: 'end' }),
    );
    const r = await fetcher.fetch(`ipfs://${V0}`);
    expect(r.outcome).toBe('ok');
    expect(r.attempts[0]?.requests).toBe(4);
    expect(f.requests).toHaveLength(4);
  });

  it('gives up on a fourth redirect from that gateway and moves on', async () => {
    const { f, fetcher } = setup((req, n) =>
      req.url.startsWith(A)
        ? { status: 302, headers: { location: `${A}/hop${n + 1}` } }
        : ok({ name: 'b' }),
    );
    const r = await fetcher.fetch(`ipfs://${V0}`);
    expect(r.attempts[0]?.result).toBe('redirect_limit');
    expect(r.attempts[0]?.requests).toBe(4);
    expect(r.outcome).toBe('ok');
    expect(r.gateway).toBe('gw-b.example.test');
    expect(f.requests.filter((x) => x.url.startsWith(A))).toHaveLength(4);
  });

  it('a redirect loop on every gateway is unreachable', async () => {
    const { fetcher } = setup((req) => ({ status: 302, headers: { location: req.url } }));
    const r = await fetcher.fetch(`ipfs://${V0}`);
    expect(r.outcome).toBe('unreachable');
    expect(r.attempts.every((a) => a.result === 'redirect_limit')).toBe(true);
  });
});

describe('per-gateway rate limit', () => {
  it('spaces calls to one gateway by its own rate, with a fake clock', async () => {
    const { clock, fetcher } = setup([{ status: 404 }], {
      ipfsGateways: [{ url: A, maxPerSecond: 2, burst: 1 }],
    });
    await fetcher.fetch(`ipfs://${V0}`);
    await fetcher.fetch(`ipfs://${V1}`);
    await fetcher.fetch(`ipfs://${V0}/x`);
    // 2 per second with a burst of 1: 500 ms between calls.
    expect(clock.sleeps).toEqual([500, 500]);
  });

  it('gives each gateway its own limiter, so a slow one does not delay another', async () => {
    const { clock, fetcher } = setup([{ status: 404 }], {
      ipfsGateways: [
        { url: A, maxPerSecond: 1, burst: 1 },
        { url: B, maxPerSecond: 1, burst: 1 },
      ],
    });
    await fetcher.fetch(`ipfs://${V0}`); // one call to each, neither waits
    expect(clock.sleeps).toEqual([]);
    await fetcher.fetch(`ipfs://${V1}`); // second call to each, each waits for its own bucket
    expect(clock.sleeps).toEqual([1000]);
  });

  it('counts retries against the limiter too', async () => {
    const { f, fetcher } = setup([{ status: 503 }, ok({ name: 'ok' })], {
      ipfsGateways: [{ url: A, maxPerSecond: 1, burst: 1 }],
      maxRetriesPerGateway: 1,
    });
    const r = await fetcher.fetch(`ipfs://${V0}`);
    expect(r.outcome).toBe('ok');
    expect(r.attempts[0]?.requests).toBe(2);
    expect(f.requests).toHaveLength(2);
  });
});

describe('request hygiene', () => {
  it('sends a generic User-Agent and no credentials', async () => {
    const { f, fetcher } = setup([ok({})]);
    await fetcher.fetch(`ipfs://${V0}`);
    const h = f.requests[0]!.headers;
    expect(h['user-agent']).toMatch(/^metadata-fetcher\//);
    expect(Object.keys(h).sort()).toEqual(['accept', 'user-agent']);
  });
});

describe('fetchTokenMetadata', () => {
  it('takes options and does not throw for a bad coin', async () => {
    const f = fakeGetFetch([{ status: 404 }]);
    const r = await fetchTokenMetadata(`ipfs://${V0}`, { fetch: f.fetch, ipfsGateways: [A] });
    expect(r.outcome).toBe('not_found');
  });

  it('reports unsupported URIs without any network use', async () => {
    const r = await fetchTokenMetadata('gopher://x/');
    expect(r.outcome).toBe('unsupported_uri');
  });
});
