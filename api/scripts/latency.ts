/**
 * Latency check for the API on synthetic data.
 *
 *   pnpm --filter @memecoinipedia/api latency [--rows 300000] [--rounds 5] [--explain] [--keep]
 *
 * Creates a throwaway `mcp_test_<hex>` database on TEST_DATABASE_ADMIN_URL
 * (default postgres://localhost:5432/postgres), loads synthetic coins, serves
 * the API on an ephemeral local port and sends real HTTP requests one at a
 * time. Drops the database at the end (unless --keep). Exits 1 when the
 * overall 95th percentile of the search mix is 200 ms or more.
 *
 * --explain also prints EXPLAIN (ANALYZE, BUFFERS) for the SQL each kind of
 * request runs, with the same parameters.
 */
import os from 'node:os';
import { serve } from '@hono/node-server';
import pg from 'pg';
import { createDb, migrate } from '@memecoinipedia/db';
import { insertSyntheticCoins } from '@memecoinipedia/db/synthetic';
import {
  createDatabase,
  dropDatabase,
  TEST_DB_PREFIX,
  urlForDatabase,
} from '@memecoinipedia/db/testing';
import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { createApp } from '../src/app.js';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string, fallback: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const ROWS = option('rows', 300_000);
const ROUNDS = option('rounds', 5);
const BUDGET_MS = 200;

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://localhost:5432/postgres';

interface Case {
  kind: string;
  url: string;
}

const percentile = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;

async function main() {
  const name = `${TEST_DB_PREFIX}${randomBytes(6).toString('hex')}`;
  await createDatabase(adminUrl, name);
  const url = urlForDatabase(adminUrl, name);
  const captured: { sql: string; params: readonly unknown[] }[] = [];
  const db = createDb(url, (event) => {
    if (event.level === 'query') {
      captured.push({ sql: event.query.sql, params: event.query.parameters });
    }
  });
  try {
    await migrate(url);
    const t = Date.now();
    await insertSyntheticCoins(db, { count: ROWS, seed: 7 });
    console.log(`loaded ${ROWS} synthetic coins in ${((Date.now() - t) / 1000).toFixed(1)}s`);

    const server = serve({ fetch: createApp({ db }).fetch, port: 0 });
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
    const get = async (path: string) => {
      const res = await fetch(base + path);
      return { status: res.status, body: (await res.json()) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
    };

    // Sample real values to build requests from.
    const sample = await sql<{ address: string; ticker: string; name: string }>`
      select address, ticker, name from coins
      where ath_market_cap_usd >= 100000 order by id limit 40 offset 1000`.execute(db);
    const addresses = sample.rows.map((r) => r.address);
    const dec = (s: string) => encodeURIComponent(s);

    const cases: Case[] = [];
    const add = (kind: string, ...paths: string[]) =>
      paths.forEach((p) => cases.push({ kind, url: p }));

    // Fuzzy text: misspellings, prefixes, short and long queries, name words.
    add(
      'search: fuzzy text',
      '/coins?q=pepee',
      '/coins?q=dogg',
      '/coins?q=bonkk',
      '/coins?q=pepe',
      '/coins?q=pepe%20the%20frog',
      '/coins?q=moon',
      '/coins?q=do',
      '/coins?q=a',
      '/coins?q=wif',
      '/coins?q=baby%20doge',
      '/coins?q=trumpp&limit=100',
      '/coins?q=elonn',
      '/coins?q=catcoin',
      '/coins?q=zzzzz',
      '/coins?q=gpt%20ai',
      ...sample.rows
        .slice(0, 10)
        .map((r) => `/coins?q=${dec((r.ticker ?? '').slice(0, -1) + 'x')}`),
      ...sample.rows.slice(10, 20).map((r) => `/coins?q=${dec(r.name ?? '')}`),
    );
    // Whole address.
    add('search: whole address', ...addresses.slice(0, 10).map((a) => `/coins?q=${a}`));
    // Filters, no text.
    add(
      'filters',
      '/coins?narrative=animal',
      '/coins?narrative=political',
      '/coins?narrative=utility,gaming&narrative_scope=any',
      '/coins?narrative=ai&narrative_scope=any&sort=launched_desc',
      '/coins?status=rugged',
      '/coins?status=alive,unknown&sort=ath_asc',
      '/coins?ath_min=1000000',
      '/coins?ath_min=500000&ath_max=2000000&sort=launched_asc',
      '/coins?ath_max=120000',
      '/coins?launched_from=2025-01-01&launched_to=2025-02-01',
      '/coins?launched_from=2026-06-01&sort=ath_desc',
      '/coins?narrative=animal&status=dead&ath_min=300000&launched_from=2025-03-01',
      '/coins?narrative=political&status=alive&sort=launched_desc',
      '/coins?narrative=culture_meme&sort=ath_asc&limit=100',
      '/coins?q=pepe&narrative=animal',
      '/coins?q=dog&status=rugged&ath_min=200000',
      '/coins?q=moon&launched_from=2025-01-01&sort=ath_desc',
      '/coins?q=cat&sort=launched_desc',
    );
    // Small result sets: paging reaches the coins that have no launch time.
    add(
      'filters',
      '/coins?status=unknown&narrative=utility&sort=launched_desc&limit=10',
      '/coins?status=unknown&narrative=utility&sort=launched_asc&limit=10',
    );
    // Each sort, no filters, first page.
    add(
      'sorts: first page',
      '/coins',
      '/coins?sort=ath_desc&limit=100',
      '/coins?sort=ath_asc',
      '/coins?sort=launched_desc',
      '/coins?sort=launched_asc&limit=100',
      '/coins?q=pepe&sort=relevance',
      '/coins?q=pepe&sort=ath_desc',
    );

    // Deep pages: walk the cursors untimed, then time the request at depth.
    const deepKinds: [string, string, number][] = [
      ['ath_desc', '/coins?sort=ath_desc&limit=100', 250],
      ['ath_asc', '/coins?sort=ath_asc&limit=100', 250],
      ['launched_desc', '/coins?sort=launched_desc&limit=100', 250],
      ['launched_asc', '/coins?sort=launched_asc&limit=100', 250],
      ['narrative+ath_desc', '/coins?narrative=animal&sort=ath_desc&limit=100', 70],
      ['relevance q=pepe', '/coins?q=pepe&limit=100', 19],
      ['relevance q=do', '/coins?q=do&limit=100', 19],
    ];
    for (const [, path, depth] of deepKinds) {
      let cursor: string | null = null;
      const steps = [Math.floor(depth / 3), Math.floor((2 * depth) / 3), depth];
      let page = 0;
      for (let i = 0; i < depth; i++) {
        const res: { body: any } = await get(path + (cursor ? `&cursor=${cursor}` : '')); // eslint-disable-line @typescript-eslint/no-explicit-any
        cursor = res.body.page.next_cursor;
        page++;
        if (!cursor) break;
        if (steps.includes(page))
          cases.push({ kind: 'deep pages', url: `${path}&cursor=${cursor}` });
      }
    }

    // Small result sets, walked to the end: the last pages hold coins without a launch time.
    for (const path of [
      '/coins?status=unknown&narrative=utility&sort=launched_desc&limit=10',
      '/coins?status=unknown&narrative=utility&sort=launched_asc&limit=10',
    ]) {
      let cursor: string | null = null;
      do {
        const url: string = path + (cursor ? `&cursor=${cursor}` : '');
        cases.push({ kind: 'small set, to the last page', url });
        const res: { body: any } = await get(url); // eslint-disable-line @typescript-eslint/no-explicit-any
        cursor = res.body.page.next_cursor;
      } while (cursor);
    }

    const extra: Case[] = [];
    const addExtra = (kind: string, ...paths: string[]) =>
      paths.forEach((p) => extra.push({ kind, url: p }));
    addExtra('coin by address', ...addresses.map((a) => `/coins/solana/${a}`));
    addExtra('narratives', '/narratives', '/narratives/animal', '/narratives/other');

    // Warm up (not timed), then measure.
    for (const c of [...cases, ...extra]) await get(c.url);
    const times = new Map<string, number[]>();
    const slowest = new Map<string, { ms: number; url: string }>();
    const record = (kind: string, ms: number, url: string) => {
      (times.get(kind) ?? times.set(kind, []).get(kind)!).push(ms);
      if (ms > (slowest.get(kind)?.ms ?? 0)) slowest.set(kind, { ms, url });
    };
    for (let round = 0; round < ROUNDS; round++) {
      for (const c of [...cases, ...extra]) {
        const start = performance.now();
        const res = await get(c.url);
        const ms = performance.now() - start;
        if (res.status !== 200) throw new Error(`${c.url} answered ${res.status}`);
        record(c.kind, ms, c.url);
      }
    }

    const searchKinds = [...new Set(cases.map((c) => c.kind))];
    const row = (label: string, xs: number[]) => {
      const s = [...xs].sort((a, b) => a - b);
      return `| ${label} | ${xs.length} | ${percentile(s, 50).toFixed(1)} | ${percentile(s, 95).toFixed(1)} | ${percentile(s, 99).toFixed(1)} | ${s[s.length - 1]!.toFixed(1)} |`;
    };
    const pgVersion = (
      await sql<{ v: string }>`select current_setting('server_version') as v`.execute(db)
    ).rows[0]!.v;
    console.log(
      `\nMachine: ${os.cpus()[0]?.model} (${os.cpus().length} cores), ${(os.totalmem() / 2 ** 30).toFixed(0)} GiB RAM, ${os.platform()} ${os.arch()}, node ${process.version}, PostgreSQL ${pgVersion} on the same machine`,
    );
    console.log(
      `Rows: ${ROWS} (listed: ${(await sql<{ n: number }>`select count(*)::int n from coins where ath_market_cap_usd >= 100000`.execute(db)).rows[0]!.n}), rounds: ${ROUNDS}, one client, real HTTP on loopback\n`,
    );
    console.log('| kind of request | requests | p50 ms | p95 ms | p99 ms | max ms |');
    console.log('|---|---|---|---|---|---|');
    for (const k of searchKinds) console.log(row(k, times.get(k)!));
    const all = searchKinds.flatMap((k) => times.get(k)!);
    console.log(row('**search mix (all of the above)**', all));
    for (const k of ['coin by address', 'narratives']) console.log(row(k, times.get(k)!));
    console.log('\nSlowest request of each kind:');
    for (const [k, v] of slowest) console.log(`  ${k}: ${v.ms.toFixed(1)} ms  ${v.url}`);

    const p95 = percentile(
      [...all].sort((a, b) => a - b),
      95,
    );
    console.log(
      `\nsearch mix p95 = ${p95.toFixed(1)} ms (budget ${BUDGET_MS} ms): ${p95 < BUDGET_MS ? 'PASS' : 'FAIL'}`,
    );

    if (flag('explain')) {
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      const seen = new Set<string>();
      for (const c of [...cases, ...extra]) {
        const key = c.kind + (c.kind === 'deep pages' ? c.url : '');
        if (seen.has(key) && !args.includes('--explain-all')) continue;
        seen.add(key);
        captured.length = 0;
        await get(c.url);
        console.log(`\n==== ${c.kind}: ${c.url}`);
        for (const q of captured.filter(
          (x) => /^\s*select/i.test(x.sql) && !/set_config/.test(x.sql),
        )) {
          await client.query('BEGIN');
          await client.query("select set_config('pg_trgm.similarity_threshold', '0.3', true)");
          const plan = await client.query(`EXPLAIN (ANALYZE, BUFFERS, TIMING OFF) ${q.sql}`, [
            ...q.params,
          ]);
          await client.query('ROLLBACK');
          console.log('--', q.sql.replace(/\s+/g, ' ').slice(0, 200));
          console.log(plan.rows.map((r: Record<string, string>) => r['QUERY PLAN']).join('\n'));
        }
      }
      await client.end();
    }

    await new Promise((resolve) => server.close(resolve));
    if (p95 >= BUDGET_MS) process.exitCode = 1;
  } finally {
    await db.destroy();
    if (flag('keep')) console.log(`\nkept database ${name}`);
    else await dropDatabase(adminUrl, name);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
