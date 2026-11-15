import { describe, expect, it } from 'vitest';
import {
  JsonTooDeepError,
  MAX_JSON_DEPTH,
  MetadataFetcher,
  stripNulDeep,
} from '../../../src/sources/metadata/index.js';
import { fakeClock } from '../helpers.js';
import { fakeGetFetch } from '../net-helpers.js';

const V0 = 'QmYfe8zVGHA1heej47AkBX3Nnetg2h2kqj5yymz1xyKeHb';

/** `{"name":"x","a":[[...]]}` holding exactly `levels` containers, the outer object included. */
function nestedBody(levels: number): string {
  const inner = levels - 1; // arrays under the outer object
  return `{"name":"x","a":${'['.repeat(inner)}${']'.repeat(inner)}}`;
}

function fetcherFor(body: string) {
  const f = fakeGetFetch([{ body }]);
  const clock = fakeClock();
  const fetcher = new MetadataFetcher({
    ipfsGateways: ['https://gw-a.example.test'],
    fetch: f.fetch,
    now: clock.now,
    sleep: clock.sleep,
  });
  return fetcher;
}

describe('maximum JSON depth', () => {
  it('the limit is 64', () => {
    expect(MAX_JSON_DEPTH).toBe(64);
  });

  it('exactly 64 levels is ok', async () => {
    const r = await fetcherFor(nestedBody(64)).fetch(`ipfs://${V0}`);
    expect(r.outcome).toBe('ok');
    expect(r.metadata?.name).toBe('x');
  });

  it('65 levels is invalid', async () => {
    const r = await fetcherFor(nestedBody(65)).fetch(`ipfs://${V0}`);
    expect(r.outcome).toBe('invalid');
    expect(r.raw).toBeNull();
    expect(r.attempts[0]?.result).toBe('invalid');
  });

  for (const levels of [5_000, 20_000, 100_000]) {
    it(`${levels} levels is invalid and does not throw`, async () => {
      const r = await fetcherFor(nestedBody(levels)).fetch(`ipfs://${V0}`);
      expect(r.outcome).toBe('invalid');
    });
  }

  it('a deep body at one gateway does not hide a good one at the next', async () => {
    const f = fakeGetFetch([{ body: nestedBody(100) }, { body: '{"name":"fine"}' }]);
    const clock = fakeClock();
    const fetcher = new MetadataFetcher({
      ipfsGateways: ['https://gw-a.example.test', 'https://gw-b.example.test'],
      fetch: f.fetch,
      now: clock.now,
      sleep: clock.sleep,
    });
    const r = await fetcher.fetch(`ipfs://${V0}`);
    expect(r.outcome).toBe('ok');
    expect(r.attempts.map((a) => a.result)).toEqual(['invalid', 'ok']);
  });
});

describe('stripNulDeep depth', () => {
  const deepArray = (levels: number): unknown => {
    let v: unknown = [];
    for (let i = 1; i < levels; i++) v = [v];
    return v;
  };

  it('does not overflow the stack on a 100,000-level value; throws the typed error', () => {
    expect(() => stripNulDeep(deepArray(100_000))).toThrow(JsonTooDeepError);
  });

  it('copies exactly 64 levels and refuses 65', () => {
    expect(() => stripNulDeep(deepArray(64))).not.toThrow();
    expect(() => stripNulDeep(deepArray(65))).toThrow(JsonTooDeepError);
  });

  it('the limit can be changed', () => {
    expect(() => stripNulDeep(deepArray(3), 2)).toThrow(JsonTooDeepError);
    expect(stripNulDeep([[1]], 2)).toEqual([[1]]);
  });

  it('keeps the order of keys and array items, and cleans NUL', () => {
    const out = stripNulDeep({ b: ['x\u0000', { c: 1, 'd\u0000': 2 }], a: null });
    expect(JSON.stringify(out)).toBe('{"b":["x",{"c":1,"d":2}],"a":null}');
  });
});
