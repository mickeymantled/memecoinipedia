import { describe, expect, it } from 'vitest';
import {
  BodyTooLargeError,
  HttpError,
  TooManyRedirectsError,
  getBytes,
  getFollowingRedirects,
} from '../../src/sources/http.js';
import { fakeClock } from './helpers.js';
import { fakeGetFetch } from './net-helpers.js';

const URL1 = 'https://gw.example.test/ipfs/abc';
const text = (b: Uint8Array) => new TextDecoder().decode(b);

function opts(f: ReturnType<typeof fakeGetFetch>, extra: Record<string, unknown> = {}) {
  const clock = fakeClock();
  return {
    fetch: f.fetch,
    sleep: clock.sleep,
    random: () => 0.5,
    baseDelayMs: 100,
    maxBytes: 1000,
    clock,
    ...extra,
  };
}

describe('getBytes', () => {
  it('returns the body, the status and one attempt', async () => {
    const f = fakeGetFetch([{ body: '{"ok":true}' }]);
    const res = await getBytes(URL1, opts(f, { headers: { accept: 'x' } }));
    expect(res.status).toBe(200);
    expect(text(res.body)).toBe('{"ok":true}');
    expect(res.attempts).toBe(1);
    expect(f.requests[0]?.headers['accept']).toBe('x');
  });

  it('retries 429 with Retry-After and 5xx with backoff, like postJson', async () => {
    const f = fakeGetFetch([
      { status: 429, headers: { 'retry-after': '3' } },
      { status: 503 },
      { body: 'fine' },
    ]);
    const o = opts(f);
    const res = await getBytes(URL1, o);
    expect(res.attempts).toBe(3);
    // First wait follows Retry-After, second is 100 * 2 * 0.75.
    expect(o.clock.sleeps).toEqual([3000, 150]);
  });

  it('retries a network error and then gives up with the attempt count', async () => {
    const f = fakeGetFetch([{ throws: new Error('boom') }]);
    const err = await getBytes(URL1, opts(f, { maxRetries: 2 })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).attempts).toBe(3);
    expect((err as HttpError).status).toBeNull();
  });

  it('does not retry a 404 and reports it', async () => {
    const f = fakeGetFetch([{ status: 404, body: 'nope' }]);
    const err = await getBytes(URL1, opts(f)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(404);
    expect((err as HttpError).bodySnippet).toBe('nope');
    expect(f.requests).toHaveLength(1);
  });

  it('stops reading at the cap and does not retry', async () => {
    const chunk = new Uint8Array(400).fill(65);
    const f = fakeGetFetch([{ body: [chunk, chunk, chunk, chunk, chunk, chunk] }]);
    const err = await getBytes(URL1, opts(f)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BodyTooLargeError);
    expect(f.requests).toHaveLength(1);
    // 1,000-byte cap: the third 400-byte chunk passes it. The other three were never pulled.
    expect(f.pulled[0]).toBe(3);
  });

  it('refuses at once when Content-Length is over the cap', async () => {
    const f = fakeGetFetch([{ body: 'x', headers: { 'content-length': '5000' } }]);
    const err = await getBytes(URL1, opts(f)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BodyTooLargeError);
    expect(f.pulled[0]).toBe(0);
  });

  it('accepts a body exactly at the cap', async () => {
    const f = fakeGetFetch([{ body: 'a'.repeat(1000) }]);
    const res = await getBytes(URL1, opts(f));
    expect(res.body.byteLength).toBe(1000);
  });

  it('asks for redirects to be returned, not followed', async () => {
    let seen = '';
    const f = fakeGetFetch(() => ({ status: 302, headers: { location: 'https://x.test/' } }));
    const inner = f.fetch;
    const res = await getBytes(URL1, {
      ...opts(f),
      fetch: async (u, init) => {
        seen = init.redirect;
        return inner(u, init);
      },
    });
    expect(seen).toBe('manual');
    expect(res.status).toBe(302);
  });
});

describe('getFollowingRedirects', () => {
  it('follows a redirect, resolving a relative Location, and counts requests', async () => {
    const f = fakeGetFetch((req) =>
      req.url.endsWith('/start')
        ? { status: 301, headers: { location: '/moved' } }
        : { body: 'done' },
    );
    const res = await getFollowingRedirects('https://a.test/start', opts(f));
    expect(res.finalUrl).toBe('https://a.test/moved');
    expect(res.redirects).toBe(1);
    expect(res.requests).toBe(2);
    expect(text(res.body)).toBe('done');
  });

  it('follows at most three redirects by default', async () => {
    const f = fakeGetFetch((_req, n) => ({
      status: 302,
      headers: { location: `https://a.test/${n + 1}` },
    }));
    const err = await getFollowingRedirects('https://a.test/0', opts(f)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TooManyRedirectsError);
    // The first request plus three redirects.
    expect(f.requests).toHaveLength(4);
  });

  it('allows exactly three redirects', async () => {
    const f = fakeGetFetch((_req, n) =>
      n < 3 ? { status: 302, headers: { location: `https://a.test/${n + 1}` } } : { body: 'ok' },
    );
    const res = await getFollowingRedirects('https://a.test/0', opts(f));
    expect(res.redirects).toBe(3);
  });

  it('checks the first URL and every hop before requesting it', async () => {
    const f = fakeGetFetch((_req, n) =>
      n === 0 ? { status: 302, headers: { location: 'http://10.0.0.1/' } } : { body: 'secret' },
    );
    const checked: string[] = [];
    const err = await getFollowingRedirects('https://a.test/0', {
      ...opts(f),
      checkUrl: (u) => {
        checked.push(u.hostname);
        if (u.hostname === '10.0.0.1') throw new Error('refused');
      },
    }).catch((e: unknown) => e);
    expect((err as Error).message).toBe('refused');
    expect(checked).toEqual(['a.test', '10.0.0.1']);
    expect(f.requests).toHaveLength(1);
  });

  it('returns a 3xx without a Location as it is', async () => {
    const f = fakeGetFetch([{ status: 304 }]);
    const res = await getFollowingRedirects('https://a.test/', opts(f));
    expect(res.status).toBe(304);
  });
});
