/**
 * The HTTP transport for a long Codex.io run: one keep-alive connection pool for the whole run, so
 * a request does not pay for a new TCP and TLS handshake. Redirects are not followed (the API
 * key travels in a header and must not go to another origin); a 3xx answer comes back as it is
 * and the client rejects it as not JSON.
 */
import { Agent, fetch as undiciFetch } from 'undici';
import type { FetchLike } from '../http.js';

export interface CodexTransportOptions {
  /** Most connections open at once. Default 64: enough for 100 requests a second at 600 ms each. */
  connections?: number;
  /** Idle connections are kept this long. Default 30 seconds. */
  keepAliveMs?: number;
}

export interface CodexTransport {
  fetch: FetchLike;
  close(): Promise<void>;
}

export function createCodexTransport(opts: CodexTransportOptions = {}): CodexTransport {
  const agent = new Agent({
    connections: opts.connections ?? 64,
    keepAliveTimeout: opts.keepAliveMs ?? 30_000,
    keepAliveMaxTimeout: opts.keepAliveMs ?? 30_000,
  });
  const fetchImpl: FetchLike = async (url, init) => {
    const res = await undiciFetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      ...(init.signal ? { signal: init.signal } : {}),
      redirect: 'manual',
      dispatcher: agent,
    });
    return {
      status: res.status,
      ok: res.ok,
      headers: { get: (name) => res.headers.get(name) },
      text: () => res.text(),
    };
  };
  return { fetch: fetchImpl, close: () => agent.close() };
}
