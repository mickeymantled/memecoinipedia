import { describe, expect, it } from 'vitest';
import {
  MetadataFetcher,
  parseTokenMetadata,
  stripNul,
  stripNulDeep,
} from '../../../src/sources/metadata/index.js';
import { fakeClock } from '../helpers.js';
import { fakeGetFetch, type GetReply, type GetRequest } from '../net-helpers.js';

const NUL = '\u0000';
const V0 = 'QmYfe8zVGHA1heej47AkBX3Nnetg2h2kqj5yymz1xyKeHb';
const V1 = 'bafkreicauvgfgkzpt66rewh6fih2by3mkqugwcx6zlgkx52gzkzohnreye';
const A = 'https://gw-a.example.test';

function setup(
  answer: ((req: GetRequest, n: number) => GetReply) | GetReply[],
  extra: ConstructorParameters<typeof MetadataFetcher>[0] = {},
) {
  const f = fakeGetFetch(answer);
  const clock = fakeClock();
  const fetcher = new MetadataFetcher({
    ipfsGateways: [A],
    fetch: f.fetch,
    now: clock.now,
    sleep: clock.sleep,
    gatewayMaxPerSecond: 1000,
    ...extra,
  });
  return { f, fetcher };
}

describe('NUL characters', () => {
  it('stripNul removes every NUL', () => {
    expect(stripNul(`a${NUL}b${NUL}${NUL}c`)).toBe('abc');
  });

  it('parseTokenMetadata strips NUL from name, symbol and description', () => {
    const m = parseTokenMetadata({
      name: `Na${NUL}me`,
      symbol: `S${NUL}Y`,
      description: `de${NUL}sc${NUL}`,
    });
    expect(m).toMatchObject({ name: 'Name', symbol: 'SY', description: 'desc' });
  });

  it('strips NUL before parsing the image and social URLs', () => {
    const m = parseTokenMetadata({
      image: `https://img.example.test/a${NUL}.png`,
      twitter: `http://x.com/fo${NUL}o`,
      telegram: `${NUL}https://t.me/bar`,
      website: `ht${NUL}tps://example.com/`,
    });
    expect(m.image).toBe('https://img.example.test/a.png');
    expect(m.twitter).toBe('https://x.com/foo');
    expect(m.telegram).toBe('https://t.me/bar');
    expect(m.website).toBe('https://example.com/');
  });

  it('stripNulDeep copies deeply, cleans keys and values, and leaves other types alone', () => {
    const input = {
      [`k${NUL}ey`]: `v${NUL}al`,
      list: [`a${NUL}`, 1, true, null, { [`n${NUL}`]: [`${NUL}x`] }],
      num: 5,
      yes: false,
      nothing: null,
    };
    const out = stripNulDeep(input);
    expect(out).toEqual({
      key: 'val',
      list: ['a', 1, true, null, { n: ['x'] }],
      num: 5,
      yes: false,
      nothing: null,
    });
    expect(JSON.stringify(out)).not.toContain('\\u0000');
    // The input is untouched, and the copy is a different object.
    expect(Object.keys(input)[0]).toBe(`k${NUL}ey`);
    expect(out).not.toBe(input);
  });

  it('keeps a "__proto__" key as plain data', () => {
    const input = JSON.parse('{"__proto__": {"polluted": true}}');
    const out = stripNulDeep(input) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(['__proto__']);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('the fetcher returns raw with NUL removed from keys and values, and parsed fields too', async () => {
    const body =
      '{"na\\u0000me":"A\\u0000B","symbol":"S\\u0000","nested":{"k\\u0000":["x\\u0000",3]}}';
    const { fetcher } = setup([{ body }]);
    const r = await fetcher.fetch(`ipfs://${V0}`);
    expect(r.outcome).toBe('ok');
    expect(r.raw).toEqual({ name: 'AB', symbol: 'S', nested: { k: ['x', 3] } });
    expect(JSON.stringify(r.raw)).not.toContain('\\u0000');
    expect(r.metadata).toMatchObject({ name: 'AB', symbol: 'S' });
  });
});

describe('tryOriginalHost requests the URI exactly as written', () => {
  it('a subdomain gateway URI is requested as the subdomain URL, not a path URL', async () => {
    const written = `https://${V1}.ipfs.dweb.link/m.json`;
    const { f, fetcher } = setup(
      (req) => (req.url === written ? { status: 404 } : { body: '{"name":"via gateway"}' }),
      { tryOriginalHost: true },
    );
    const r = await fetcher.fetch(written);
    expect(f.requests[0]?.url).toBe(written);
    expect(r.attempts[0]).toMatchObject({ gateway: `${V1}.ipfs.dweb.link`, result: 'not_found' });
    expect(r.outcome).toBe('ok');
    expect(f.requests[1]?.url).toBe(`${A}/ipfs/${V1}/m.json`);
  });

  it('a path gateway URI is requested as written, query included', async () => {
    const written = `https://ipfs.io/ipfs/${V0}/x.json?filename=a.json`;
    const { f, fetcher } = setup([{ body: '{"name":"x"}' }], { tryOriginalHost: true });
    await fetcher.fetch(written);
    expect(f.requests[0]?.url).toBe(written);
  });

  it('the safety checks still apply to the original host', async () => {
    const { f, fetcher } = setup([{ body: '{}' }], { tryOriginalHost: true });
    const r = await fetcher.fetch(`http://127.0.0.1/ipfs/${V0}`);
    expect(r.attempts[0]?.result).toBe('blocked');
    expect(f.requests.some((x) => x.url.includes('127.0.0.1'))).toBe(false);
  });
});
