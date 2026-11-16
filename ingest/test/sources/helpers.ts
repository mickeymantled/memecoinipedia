import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FetchLike } from '../../src/sources/http.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function loadFixtureText(name: string): string {
  return fs.readFileSync(path.join(HERE, 'fixtures', 'codex', `${name}.json`), 'utf8');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function loadFixture(name: string): any {
  return JSON.parse(loadFixtureText(name));
}

/** A fake clock: `sleep` advances time and returns at once, so nothing waits in real time. */
export function fakeClock(start = 0) {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
    sleeps,
  };
}

export interface FakeReply {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
  throws?: Error;
}

export interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
  query: string;
}

/** A fetch that answers from a function or a queue and records every request. */
export function fakeFetch(answer: ((req: RecordedRequest, n: number) => FakeReply) | FakeReply[]) {
  const requests: RecordedRequest[] = [];
  const fn: FetchLike = async (url, init) => {
    const query = (JSON.parse(init.body) as { query?: string }).query ?? '';
    const req = { url, headers: init.headers, query };
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

/** A GraphQL success body with an optional cost in micro-units (as Codex sends it). */
export function gqlBody(data: Record<string, unknown>, computeUnitsMicro?: string): string {
  return JSON.stringify({
    data: {
      ...data,
      ...(computeUnitsMicro === undefined
        ? {}
        : { usageData: { total: { computeUnits: computeUnitsMicro } } }),
    },
  });
}
