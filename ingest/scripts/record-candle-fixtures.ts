/**
 * Records the Codex.io responses for the candle tests in
 * ingest/test/candles/fixtures, one file per coin, by running the production
 * fetch for three probe coins of different shapes:
 *
 *   USOF     2026, PumpSwap with a migrated pool address, dead within days
 *   VANGOAT  2024, Raydium, no migrated pool address, curve bars, six pools
 *   WIZARD   2025, PumpSwap, peaked a year after launch (peak refinement)
 *
 *   tsx --env-file=/path/to/.env ingest/scripts/record-candle-fixtures.ts --max-units N [--json out.json]
 *
 * Needs TEST_DATABASE_ADMIN_URL (a throwaway `mcp_test_` database is created
 * and dropped). N is a hard ceiling on compute units. After each coin it
 * fetches a second time at the same clock and prints how many requests that
 * made (it should be 0).
 *
 * A fixture holds the GraphQL queries and the response bodies, nothing else:
 * no header, no key. The tests replay them with the clock set to `asOf`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UnitBudget } from '../src/sources/budget.js';
import { CodexClient } from '../src/sources/codex/index.js';
import type { FetchLike } from '../src/sources/http.js';
import { RateLimiter } from '../src/sources/ratelimit.js';
import {
  checkCoin,
  printRow,
  symbolsFromProbe,
  withThrowawayDb,
  type CheckRow,
} from './lib/candle-check.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, '..', 'test', 'candles', 'fixtures');
const COINS = path.join(HERE, '..', '..', 'probes', 'coins.json');
const SYMBOLS = ['USOF', 'VANGOAT', 'WIZARD'];

const key = process.env['CODEX_API_KEY'];
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const argv = process.argv.slice(2);
const maxUnitsArg = argv.indexOf('--max-units');
const maxUnits = maxUnitsArg >= 0 ? Number(argv[maxUnitsArg + 1]) : NaN;
const jsonArg = argv.indexOf('--json');
if (!key) throw new Error('CODEX_API_KEY is not set. Run with --env-file.');
if (!adminUrl) throw new Error('TEST_DATABASE_ADMIN_URL is not set.');
if (!(maxUnits > 0)) throw new Error('--max-units N is required.');

const symbols = symbolsFromProbe(COINS);
const mintOf = (symbol: string): string => {
  for (const [mint, s] of symbols) if (s === symbol) return mint;
  throw new Error(`${symbol} is not in probes/coins.json`);
};

/** Drops the bar columns the client never reads, to keep fixtures small. */
function slim(body: { data?: { getBars?: Record<string, unknown> | null } }): unknown {
  const bars = body.data?.getBars;
  if (bars) for (const k of ['buyers', 'sellers', 'buys', 'sells', 's']) delete bars[k];
  return body;
}

/** Responses of the coin being processed, keyed by the exact GraphQL query. */
let recording = new Map<string, unknown>();
const recordingFetch: FetchLike = async (url, init) => {
  const res = await fetch(url, init);
  const text = await res.text();
  if (res.ok) {
    const query = (JSON.parse(init.body) as { query: string }).query;
    recording.set(query, slim(JSON.parse(text)));
  }
  return { status: res.status, ok: res.ok, headers: res.headers, text: async () => text };
};

const budget = new UnitBudget({ ceilingUnits: maxUnits });
const client = new CodexClient({
  apiKey: key,
  fetch: recordingFetch,
  budget,
  limiter: new RateLimiter({ maxPerSecond: 10, burst: 1 }),
});

const rows: CheckRow[] = [];
await withThrowawayDb(adminUrl, async (t) => {
  for (const symbol of SYMBOLS) {
    const mint = mintOf(symbol);
    recording = new Map();
    const asOfDate = new Date();
    const row = await checkCoin({
      t,
      client,
      mint,
      symbol,
      clock: () => asOfDate,
      verifyRerun: true,
    });
    rows.push(row);
    printRow(row);
    if (!row.ok) throw new Error(`${symbol} did not finish; no fixture written`);
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const file = path.join(OUT_DIR, `${symbol.toLowerCase()}.json`);
    const doc = {
      symbol,
      mint,
      asOf: Math.floor(asOfDate.getTime() / 1000),
      responses: [...recording.entries()],
    };
    fs.writeFileSync(file, JSON.stringify(doc) + '\n');
    console.log(
      `  wrote ${path.relative(process.cwd(), file)} (${recording.size} responses, ${fs.statSync(file).size} bytes)`,
    );
  }
});
const s = client.spend();
console.log(`\nTotal: ${s.units.toFixed(2)} units in ${s.requests} requests.`);
if (jsonArg >= 0) {
  fs.writeFileSync(
    argv[jsonArg + 1]!,
    JSON.stringify({ totalUnits: s.units, rows }, null, 2) + '\n',
  );
}
