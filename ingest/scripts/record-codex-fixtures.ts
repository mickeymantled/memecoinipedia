/**
 * Re-records the Codex.io test fixtures in ingest/test/sources/fixtures/codex.
 *
 *   node --env-file=/path/to/.env --import tsx ingest/scripts/record-codex-fixtures.ts [--used N]
 *   (or: tsx --env-file=/path/to/.env ingest/scripts/record-codex-fixtures.ts)
 *
 * It uses the production client, so the fixtures hold exactly what the
 * client's queries return. Hard limit: 40 requests to graph.codex.io in total.
 * `--used N` says how many were already spent before this run. The script
 * stops before the request that would pass 40.
 *
 * Output is counts only. The API key is read from CODEX_API_KEY, goes into the
 * Authorization header and nowhere else: no header, URL or key is printed or
 * written. Fixtures hold response bodies only, with every array cut to 20
 * elements.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexClient } from '../src/sources/codex/client.js';
import { pickGraduationPool } from '../src/sources/codex/pools.js';
import { UnitBudget } from '../src/sources/budget.js';
import { RateLimiter } from '../src/sources/ratelimit.js';
import type { FetchLike } from '../src/sources/http.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, '..', 'test', 'sources', 'fixtures', 'codex');
const COINS = path.join(HERE, '..', '..', 'probes', 'coins.json');

const REQUEST_LIMIT = 40;
const MAX_ARRAY = 20;

const key = process.env['CODEX_API_KEY'];
if (!key) {
  console.error('CODEX_API_KEY is not set. Run with --env-file.');
  process.exit(1);
}

const usedArg = process.argv.indexOf('--used');
let requests = usedArg > 0 ? Number(process.argv[usedArg + 1]) : 0;
if (!Number.isInteger(requests) || requests < 0) {
  console.error('--used must be a non-negative integer');
  process.exit(1);
}
const startedAt = requests;

let label = '';
const bodies = new Map<string, string>();

const countingFetch: FetchLike = async (url, init) => {
  if (requests >= REQUEST_LIMIT) {
    throw new Error(`Request limit of ${REQUEST_LIMIT} reached; not calling the API.`);
  }
  requests++;
  const res = await fetch(url, init);
  const text = await res.text();
  bodies.set(label, text);
  return { status: res.status, ok: res.ok, headers: res.headers, text: async () => text };
};

function trim(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map(trim);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, trim(v)]));
  }
  return value;
}

function save(name: string): void {
  const body = bodies.get(name);
  if (body === undefined) throw new Error(`No response recorded for ${name}`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(trim(JSON.parse(body)), null, 2) + '\n');
}

interface Coin {
  mint: string;
  symbol: string;
  codexMigratedAt: number;
}
const coins: Coin[] = JSON.parse(fs.readFileSync(COINS, 'utf8'));
const find = (symbol: string): Coin => {
  const c = coins.find((x) => x.symbol.trim() === symbol);
  if (!c) throw new Error(`${symbol} is not in probes/coins.json`);
  return c;
};

const budget = new UnitBudget();
const client = new CodexClient({
  apiKey: key,
  fetch: countingFetch,
  budget,
  // Stay well under the free-tier 5 requests per second.
  limiter: new RateLimiter({ maxPerSecond: 4, burst: 1 }),
  http: { maxRetries: 0 },
});

// A 2024 Raydium coin (migrated pool address null) and a 2026 coin.
const cases = [
  { tag: '2024', coin: find('CHILLGUY'), resolution: '60' as const, span: 3 * 86_400 },
  { tag: '2026', coin: find('USOF'), resolution: '1' as const, span: 3_600 },
];

for (const { tag, coin, resolution, span } of cases) {
  const m = coin.codexMigratedAt;

  label = `filter-tokens-${tag}`;
  for await (const _ of client.discoverGraduated(
    { from: m - 300, to: m + 300 },
    { windowSeconds: 601 },
  )) {
    void _;
  }
  save(label);

  label = `token-${tag}`;
  const launch = await client.getLaunchInfo(coin.mint);
  save(label);

  label = `pairs-${tag}`;
  const { pools, truncated } = await client.getPools(coin.mint);
  save(label);

  const pick = pickGraduationPool({
    pools,
    migratedPoolAddress: launch?.migratedPoolAddress,
    migratedAt: launch?.migratedAt ?? m,
    truncated,
  });
  if (!pick) throw new Error(`no graduation pool for ${coin.symbol}`);
  const start = pick.pool?.createdAt ?? m;

  label = `bars-${resolution === '1' ? '1m' : '1h'}-${tag}`;
  await client.getPoolBars({
    pairAddress: pick.address,
    resolution,
    from: start - 120,
    to: start - 120 + span,
  });
  save(label);

  console.log(`${tag}: pools=${pools.length} truncated=${truncated} pick=${pick.source}`);
}

const s = client.spend();
console.log(
  `requests this run: ${requests - startedAt}, total requests: ${requests} of ${REQUEST_LIMIT}, ` +
    `units this run: ${s.units.toFixed(4)} (estimated part ${s.estimatedUnits.toFixed(4)})`,
);
