import { describe, expect, it } from 'vitest';
import { HttpError, parseRetryAfter, postJson } from '../../src/sources/http.js';
import { fakeClock, fakeFetch } from './helpers.js';

const URL = 'https://graph.example.test/graphql';
const SECRET = 'sk-test-0123456789-secret';

function opts(f: ReturnType<typeof fakeFetch>, clock = fakeClock()) {
  return {
    fetch: f.fetch,
    sleep: clock.sleep,
    random: () => 0.5, // jitter factor 0.75
    baseDelayMs: 100,
    headers: { Authorization: SECRET },
    clock,
  };
}

describe('postJson', () => {
  it('returns the body on success', async () => {
    const f = fakeFetch([{ body: '{"ok":true}' }]);
    const res = await postJson(URL, { query: 'x' }, opts(f));
    expect(res).toEqual({ status: 200, body: '{"ok":true}', attempts: 1 });
    expect(f.requests[0]?.headers['Authorization']).toBe(SECRET);
    expect(f.requests[0]?.headers['content-type']).toBe('application/json');
  });

  it('retries 429 and honours Retry-After (seconds)', async () => {
    const f = fakeFetch([
      { status: 429, headers: { 'retry-after': '3' } },
      { body: '{"ok":true}' },
    ]);
    const o = opts(f);
    const res = await postJson(URL, {}, o);
    expect(res.attempts).toBe(2);
    expect(o.clock.sleeps).toEqual([3000]);
  });

  it('retries 5xx with exponential backoff and jitter', async () => {
    const f = fakeFetch([{ status: 500 }, { status: 502 }, { status: 503 }, { body: '{}' }]);
    const o = opts(f);
    const res = await postJson(URL, {}, o);
    expect(res.attempts).toBe(4);
    // base 100 * 2^n * jitter 0.75
    expect(o.clock.sleeps).toEqual([75, 150, 300]);
  });

  it('uses the exponential delay when it is longer than Retry-After', async () => {
    const f = fakeFetch([{ status: 503, headers: { 'retry-after': '0' } }, { body: '{}' }]);
    const o = opts(f);
    await postJson(URL, {}, o);
    expect(o.clock.sleeps).toEqual([75]);
  });

  it('retries a network error', async () => {
    const f = fakeFetch([{ throws: new Error(`connect failed ${SECRET}`) }, { body: '{}' }]);
    const res = await postJson(URL, {}, opts(f));
    expect(res.attempts).toBe(2);
  });

  it('does not retry a 400', async () => {
    const f = fakeFetch([{ status: 400, body: '{"errors":[{"message":"bad"}]}' }]);
    const o = opts(f);
    const err = await postJson(URL, {}, o).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(400);
    expect(f.requests).toHaveLength(1);
    expect(o.clock.sleeps).toHaveLength(0);
  });

  it('does not retry a 401 or 404', async () => {
    for (const status of [401, 404]) {
      const f = fakeFetch([{ status }]);
      await expect(postJson(URL, {}, opts(f))).rejects.toBeInstanceOf(HttpError);
      expect(f.requests).toHaveLength(1);
    }
  });

  it('gives up after maxRetries and reports the attempts', async () => {
    const f = fakeFetch([{ status: 500 }]);
    const err = (await postJson(URL, {}, { ...opts(f), maxRetries: 2 }).catch(
      (e: unknown) => e,
    )) as HttpError;
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(500);
    expect(err.attempts).toBe(3);
    expect(f.requests).toHaveLength(3);
  });

  it('caps a single wait at maxDelayMs', async () => {
    const f = fakeFetch([{ status: 429, headers: { 'retry-after': '3600' } }, { body: '{}' }]);
    const o = { ...opts(f), maxDelayMs: 5_000 };
    await postJson(URL, {}, o);
    expect(o.clock.sleeps).toEqual([5_000]);
  });

  it('never puts the Authorization value in an error', async () => {
    const cases = [
      fakeFetch([{ throws: new Error(`boom ${SECRET}`) }]),
      fakeFetch([{ status: 401, body: 'unauthorized' }]),
      fakeFetch([{ status: 503, headers: { authorization: SECRET } }]),
    ];
    for (const f of cases) {
      const err = (await postJson(URL, {}, { ...opts(f), maxRetries: 1 }).catch(
        (e: unknown) => e,
      )) as HttpError;
      expect(err).toBeInstanceOf(HttpError);
      const everything = [
        err.message,
        err.bodySnippet,
        String(err),
        err.stack ?? '',
        JSON.stringify(err),
      ].join('\n');
      expect(everything).not.toContain(SECRET);
    }
  });
});

describe('parseRetryAfter', () => {
  it('parses seconds, dates and junk', () => {
    expect(parseRetryAfter('2')).toBe(2000);
    expect(parseRetryAfter('1.5')).toBe(1500);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('soon')).toBeNull();
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:10 GMT', now)).toBe(10_000);
    expect(parseRetryAfter('Wed, 31 Dec 2025 23:59:00 GMT', now)).toBe(0);
  });
});
