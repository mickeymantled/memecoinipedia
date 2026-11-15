/**
 * Scale check for the backfill machinery, on a throwaway database and the simulated provider.
 * No provider is called and no real database is touched.
 *
 *   TEST_DATABASE_ADMIN_URL=postgres://localhost:5432/postgres \
 *     node --import tsx ingest/scripts/bench-backfill.ts [--seed-rows 350000] [--run-coins 20000] \
 *       [--order hash] [--floor 30000] [--keep-file]
 *
 * It writes a synthetic candidate file (in the system temp directory, deleted at the end), seeds it
 * into a new `mcp_test_<hex>` database (timing the seed, then seeding again to check that no row
 * changes), runs the backfill on `--run-coins` coins with a provider that answers at once, samples
 * the process's memory every second, and prints the figures. The database is dropped at the end.
 */
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createTestDatabase } from '@memecoinipedia/db/testing';
import { sql } from 'kysely';
import { runBackfill } from '../src/backfill/run.js';
import { seedFromCandidateFile } from '../src/backfill/seed.js';
import { UnitBudget } from '../src/sources/budget.js';
import { CodexClient } from '../src/sources/codex/index.js';
import { RateLimiter } from '../src/sources/ratelimit.js';
import { silentLogger, consoleLogger } from '../src/worker/log.js';
import type { SourceClients } from '../src/worker/run.js';
import { asset, okResult, token } from '../test/worker/helpers.js';
import { synthProvider, writeCandidateFile } from '../test/backfill/synthetic.js';

const { values } = parseArgs({
  options: {
    'seed-rows': { type: 'string', default: '350000' },
    'run-coins': { type: 'string', default: '20000' },
    order: { type: 'string', default: 'hash' },
    floor: { type: 'string', default: '30000' },
    'candles-concurrency': { type: 'string' },
    verbose: { type: 'boolean', default: false },
  },
  strict: true,
});
const seedRows = Number(values['seed-rows']);
const runCoins = Number(values['run-coins']);
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) throw new Error('TEST_DATABASE_ADMIN_URL is not set');
if (values.order !== 'hash' && values.order !== 'peak') throw new Error('--order is hash or peak');

const mb = (b: number) => Math.round(b / 1e6);
const fmt = (n: number) => n.toLocaleString('en-US');

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'bench-backfill-'));
  const file = join(dir, 'candidates.csv');
  const t = await createTestDatabase(adminUrl!);
  try {
    let t0 = Date.now();
    await writeCandidateFile(file, seedRows);
    console.log(
      `file: ${fmt(seedRows)} rows, ${mb((await stat(file)).size)} MB, written in ${((Date.now() - t0) / 1000).toFixed(1)} s`,
    );

    // 1. Seed, then seed again.
    t0 = Date.now();
    const first = await seedFromCandidateFile({ file, confirm: true, db: t.db });
    const seedSeconds = (Date.now() - t0) / 1000;
    console.log(
      `seed: ${seedSeconds.toFixed(1)} s (${fmt(Math.round(seedRows / seedSeconds))} rows/s); ` +
        `${fmt(first.written!.inserted)} inserted, ${fmt(first.badRows)} rejected`,
    );
    const digest = async () =>
      (
        await sql<{ h: string }>`
          select md5(string_agg(md5(c::text), '' order by c.id)) as h from coins c`.execute(t.db)
      ).rows[0]!.h;
    const before = await digest();
    t0 = Date.now();
    const second = await seedFromCandidateFile({ file, confirm: true, db: t.db });
    const reseedSeconds = (Date.now() - t0) / 1000;
    const after = await digest();
    console.log(
      `seed again: ${reseedSeconds.toFixed(1)} s; inserted ${second.written!.inserted}, ` +
        `changed ${second.written!.updated}, unchanged ${fmt(second.written!.unchanged)}; ` +
        `coins table ${before === after ? 'identical' : 'DIFFERENT'} before and after`,
    );
    const size1 = Number(
      (await sql<{ n: string }>`select pg_database_size(current_database())::text n`.execute(t.db))
        .rows[0]!.n,
    );
    console.log(`database after seeding: ${mb(size1)} MB`);

    // 2. Run.
    const provider = synthProvider();
    const limiter = new RateLimiter({ maxPerSecond: 100_000, burst: 1000 });
    const codex = new CodexClient({
      apiKey: 'bench-key-not-real',
      fetch: provider.fetch,
      budget: new UnitBudget({ ceilingUnits: 100_000_000 }),
      limiter,
      http: { maxRetries: 0, sleep: async () => {} },
    });
    const clients: SourceClients = {
      codex,
      helius: {
        getAssets: async (m) => m.map((x) => asset(x, { uri: `https://example.test/${x}.json` })),
      },
      jupiter: { getTokens: async (m) => m.map((x) => token(x)) },
      fetchMetadata: async (uri) => okResult({ description: `about ${uri.slice(-12)}` }),
    };

    const samples: Array<{ at: number; rss: number; heap: number }> = [];
    const runStart = Date.now();
    const timer = setInterval(() => {
      const m = process.memoryUsage();
      samples.push({ at: Date.now() - runStart, rss: m.rss, heap: m.heapUsed });
    }, 1000);
    const startRss = process.memoryUsage().rss;
    const lines: string[] = [];
    const report = await runBackfill({
      selection: {
        chain: 'solana',
        minRoughPeakUsd: Number(values.floor),
        includeNoPrice: false,
        order: values.order as 'hash' | 'peak',
        limit: runCoins,
      },
      confirm: true,
      maxCodexUnits: 100_000_000,
      ...(values['candles-concurrency']
        ? { candlesConcurrency: Number(values['candles-concurrency']) }
        : {}),
      env: { DATABASE_URL: t.url },
      log: values.verbose ? consoleLogger() : silentLogger,
      out: (x) => lines.push(x),
      clients,
    });
    clearInterval(timer);
    const seconds = (Date.now() - runStart) / 1000;
    const done = Number(
      (
        await sql<{ n: string }>`
          select count(*)::text n from coin_stages where stage = 'metrics' and status = 'done'`.execute(
          t.db,
        )
      ).rows[0]!.n,
    );
    const half = Math.floor(samples.length / 2);
    const peak = (xs: typeof samples) => Math.max(0, ...xs.map((s) => s.rss));
    const size2 = Number(
      (await sql<{ n: string }>`select pg_database_size(current_database())::text n`.execute(t.db))
        .rows[0]!.n,
    );
    console.log(lines.join('\n'));
    console.log('');
    console.log(
      `run: ${report.status}; ${fmt(done)} of ${fmt(runCoins)} coins through candles and metrics in ` +
        `${seconds.toFixed(1)} s = ${(done / seconds).toFixed(1)} coins/s; ` +
        `${fmt(provider.requests())} simulated requests`,
    );
    console.log(
      `memory (rss): start ${mb(startRss)} MB, first half peak ${mb(peak(samples.slice(0, half)))} MB, ` +
        `second half peak ${mb(peak(samples.slice(half)))} MB, overall peak ${mb(peak(samples))} MB`,
    );
    console.log(`database after the run: ${mb(size2)} MB`);
  } finally {
    await t.drop();
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`bench failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
