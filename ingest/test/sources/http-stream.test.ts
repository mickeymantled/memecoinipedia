import { describe, expect, it } from 'vitest';
import { getStream, HttpError } from '../../src/sources/http.js';
import { fakeClock } from './helpers.js';
import { fakeGetFetch } from './net-helpers.js';

const URL_ = 'https://api.example.test/big';

function opts(f: ReturnType<typeof fakeGetFetch>) {
  const clock = fakeClock();
  return { fetch: f.fetch, sleep: clock.sleep, random: () => 0.5, baseDelayMs: 10, maxRetries: 2 };
}

describe('getStream', () => {
  it('returns a 2xx body unread, for the caller to read', async () => {
    const f = fakeGetFetch([{ body: 'hello' }]);
    const res = await getStream(URL_, opts(f));
    expect(res.status).toBe(200);
    expect(f.pulled[0]).toBe(0);
    expect(await new Response(res.body).text()).toBe('hello');
  });

  it('retries 5xx and 429, then returns the good body', async () => {
    const f = fakeGetFetch([
      { status: 503 },
      { status: 429, headers: { 'retry-after': '1' } },
      { body: 'ok' },
    ]);
    const res = await getStream(URL_, opts(f));
    expect(res.attempts).toBe(3);
    expect(await new Response(res.body).text()).toBe('ok');
  });

  it('throws HttpError for a 4xx without retrying, with a short snippet of the body', async () => {
    const f = fakeGetFetch([{ status: 404, body: '{"error":"gone"}' }]);
    const err = await getStream(URL_, opts(f)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(404);
    expect((err as HttpError).bodySnippet).toContain('gone');
    expect(f.requests).toHaveLength(1);
  });

  it('gives up after the retries on a persistent 5xx', async () => {
    const f = fakeGetFetch([{ status: 500 }]);
    await expect(getStream(URL_, opts(f))).rejects.toThrow(/after 3 attempts/);
    expect(f.requests).toHaveLength(3);
  });

  it('returns a redirect with no body and does not follow it', async () => {
    const f = fakeGetFetch([{ status: 302, headers: { location: 'https://other.test/' } }]);
    const res = await getStream(URL_, opts(f));
    expect(res.status).toBe(302);
    expect(res.body).toBeNull();
    expect(f.requests).toHaveLength(1);
  });
});
