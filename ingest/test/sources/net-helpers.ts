import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FetchLike, GetFetchLike } from '../../src/sources/http.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function fixtureText(dir: string, name: string): string {
  return fs.readFileSync(path.join(HERE, 'fixtures', dir, `${name}.json`), 'utf8');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fixture(dir: string, name: string): any {
  return JSON.parse(fixtureText(dir, name));
}

export interface RpcReply {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
  throws?: Error;
}

export interface RpcRequest {
  url: string;
  headers: Record<string, string>;
  method: string;
  params: unknown;
}

/** A JSON-RPC fetch that answers from a function or a queue (the last reply repeats) and records requests. */
export function fakeRpcFetch(answer: ((req: RpcRequest, n: number) => RpcReply) | RpcReply[]) {
  const requests: RpcRequest[] = [];
  const fn: FetchLike = async (url, init) => {
    const payload = JSON.parse(init.body) as { method?: string; params?: unknown };
    const req: RpcRequest = {
      url,
      headers: init.headers,
      method: payload.method ?? '',
      params: payload.params,
    };
    requests.push(req);
    const n = requests.length - 1;
    const reply =
      typeof answer === 'function'
        ? answer(req, n)
        : (answer[Math.min(n, answer.length - 1)] ?? {});
    if (reply.throws) throw reply.throws;
    const status = reply.status ?? 200;
    const headers = reply.headers ?? {};
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      text: async () => reply.body ?? '{}',
    };
  };
  return { fetch: fn, requests };
}

export const rpcResult = (result: unknown): string =>
  JSON.stringify({ jsonrpc: '2.0', id: 1, result });

export interface GetReply {
  status?: number;
  /** A string, or chunks delivered one by one. */
  body?: string | Uint8Array[];
  headers?: Record<string, string>;
  throws?: Error;
}

export interface GetRequest {
  url: string;
  headers: Record<string, string>;
}

/** A GET fetch that answers by URL or from a queue, with real `Response` bodies, and records requests. */
export function fakeGetFetch(answer: ((req: GetRequest, n: number) => GetReply) | GetReply[]) {
  const requests: GetRequest[] = [];
  /** How many body chunks were pulled by readers, per request. */
  const pulled: number[] = [];
  const fn: GetFetchLike = async (url, init) => {
    const req: GetRequest = { url, headers: init.headers };
    requests.push(req);
    const n = requests.length - 1;
    const reply =
      typeof answer === 'function'
        ? answer(req, n)
        : (answer[Math.min(n, answer.length - 1)] ?? {});
    if (reply.throws) throw reply.throws;
    pulled.push(0);
    const chunks =
      typeof reply.body === 'string'
        ? [new TextEncoder().encode(reply.body)]
        : (reply.body ?? [new Uint8Array(0)]);
    let i = 0;
    // highWaterMark 0: nothing is read ahead, so `pulled` counts what the reader asked for.
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (i < chunks.length) {
            controller.enqueue(chunks[i++]!);
            pulled[n] = (pulled[n] ?? 0) + 1;
          } else controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const headers = reply.headers ?? {};
    return {
      status: reply.status ?? 200,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      body: stream,
    };
  };
  return { fetch: fn, requests, pulled };
}
