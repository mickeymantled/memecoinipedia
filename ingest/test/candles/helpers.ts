import { readFileSync } from 'node:fs';
import { describe } from 'vitest';
import { sql, type Kysely } from 'kysely';
import { getTestAdminUrl } from '@memecoinipedia/db/testing';
import type { Database } from '@memecoinipedia/db';
import type { FetchLike } from '../../src/sources/http.js';

export const adminUrl = getTestAdminUrl();
if (!adminUrl) {
  process.stderr.write(
    '\n*** TEST_DATABASE_ADMIN_URL is not set: candle database tests are SKIPPED. ***\n\n',
  );
}
/** `describe` that skips when no test database server is configured. */
export const describeDb = describe.skipIf(!adminUrl);

export interface CandleFixture {
  symbol: string;
  mint: string;
  /** The clock the recording ran at, unix seconds. Tests set their clock to it. */
  asOf: number;
  responses: [query: string, body: unknown][];
}

export function loadCandleFixture(symbol: string): CandleFixture {
  const url = new URL(`./fixtures/${symbol.toLowerCase()}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as CandleFixture;
}

export interface Replay {
  fetch: FetchLike;
  /** Every query sent, in order. */
  queries: string[];
  /** The bars requests among them. */
  barsQueries(): string[];
}

/**
 * A fetch that answers from recorded responses by exact query and throws on a
 * query that was not recorded, so a test fails when the code asks for something new.
 * `fail` can make chosen queries answer with an HTTP status instead.
 */
export function replayFetch(
  fixtures: readonly CandleFixture[],
  opts: { fail?: (query: string, n: number) => number | null } = {},
): Replay {
  const answers = new Map<string, unknown>();
  for (const f of fixtures) for (const [q, body] of f.responses) answers.set(q, body);
  const queries: string[] = [];
  const fetchImpl: FetchLike = async (_url, init) => {
    const query = (JSON.parse(init.body) as { query: string }).query;
    queries.push(query);
    const status = opts.fail?.(query, queries.length);
    if (status) {
      return { status, ok: false, headers: { get: () => null }, text: async () => 'error' };
    }
    if (!answers.has(query)) throw new Error(`Unrecorded request: ${query.slice(0, 160)}`);
    const text = JSON.stringify(answers.get(query));
    return { status: 200, ok: true, headers: { get: () => null }, text: async () => text };
  };
  return {
    fetch: fetchImpl,
    queries,
    barsQueries: () => queries.filter((q) => q.includes('getBars(')),
  };
}

/** Every row of the tables a fetch writes, as plain JSON, for before-and-after comparison. */
export async function snapshotTables(db: Kysely<Database>): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const [name, order] of [
    ['coins', 'id'],
    ['pools', 'id'],
    ['candle_chunks', 'pool_id, resolution_sec, chunk_start'],
    ['candle_coverage', 'pool_id, resolution_sec, from_t, to_t'],
    ['data_issues', 'id'],
  ] as const) {
    const { rows } = await sql<Record<string, unknown>>`
      select * from ${sql.table(name)} order by ${sql.raw(order)}`.execute(db);
    out[name] = JSON.parse(JSON.stringify(rows)) as unknown[];
    // Every list request stores the time it was made (`coins.pools_listed_at`, migration 0022), so
    // a second refresh that finds nothing new still moves it: it is not part of what must not change.
    if (name === 'coins')
      for (const r of out[name] as Record<string, unknown>[]) delete r['pools_listed_at'];
  }
  return out;
}
