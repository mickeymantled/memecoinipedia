import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpError, postJson } from '../../src/sources/http.js';

describe('postJson default fetch refuses redirects', () => {
  let server: http.Server;
  let port: number;
  let targetHits = 0;
  let sourceHits = 0;
  let seenKey: string | undefined;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/target') {
        targetHits++;
        seenKey = req.headers['x-api-key'] as string | undefined;
        res.end('{}');
        return;
      }
      sourceHits++;
      res.statusCode = 307;
      res.setHeader('location', `http://127.0.0.1:${port}/target`);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('ends as an HttpError naming the host, is not retried, and never reaches the target', async () => {
    const err = await postJson(
      `http://127.0.0.1:${port}/start`,
      {},
      { headers: { 'x-api-key': 'secret-value' }, maxRetries: 3, sleep: async () => undefined },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    const e = err as HttpError;
    expect(e.message).toContain(`127.0.0.1:${port}`);
    expect(e.message.toLowerCase()).toContain('redirect refused');
    expect(e.attempts).toBe(1);
    expect(sourceHits).toBe(1);
    expect(targetHits).toBe(0);
    expect(seenKey).toBeUndefined();
    expect(e.message).not.toContain('secret-value');
  });
});
