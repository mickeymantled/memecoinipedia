/**
 * Live check and fixture recorder for the Helius, metadata-gateway and
 * Jupiter clients (issue #19).
 *
 *   node --env-file=/path/to/.env --import tsx ingest/scripts/record-metadata-fixtures.ts \
 *     --phase assets|create|jupiter|gateways|codex --out DIR [--used-helius-requests N] ...
 *
 * Phases, each run on its own so spending is deliberate:
 *   assets    one getAssetBatch for the 20 probe coins plus one non-token address
 *   create    getCreateEvent for each probe coin
 *   jupiter   getTokens for the 20 probe coins plus one non-token address
 *   gateways  fetchTokenMetadata for every probe coin through each gateway given in --gateways
 *   codex     Codex.io `token` lookups (createdAt and creator) for the 20 probe coins
 *
 * Hard limits for the whole task. `--used-*` says how much was spent before
 * this run, and each request is checked against the limit before it is made:
 *   Helius 60 requests and 3,000 credits   (--used-helius-requests, --used-helius-credits)
 *   Jupiter 30 requests                    (--used-jupiter)
 *   public gateways 200 requests           (--used-gateway)
 *   Codex.io 25 requests and 120 units     (--used-codex-requests, --used-codex-units)
 *
 * Keys come from HELIUS_API_KEY, CODEX_API_KEY and (optionally) JUPITER_API_KEY.
 * They go into headers only. Nothing prints a URL, a header or a key. The
 * output files hold response bodies and counts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexClient } from '../src/sources/codex/client.js';
import { UnitBudget } from '../src/sources/budget.js';
import { HeliusClient } from '../src/sources/helius/client.js';
import { JupiterClient } from '../src/sources/jupiter/client.js';
import { MetadataFetcher } from '../src/sources/metadata/fetch.js';
import { createSafeFetch } from '../src/sources/metadata/safe-fetch.js';
import { RateLimiter } from '../src/sources/ratelimit.js';
import type { FetchLike, GetFetchLike } from '../src/sources/http.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COINS = path.join(HERE, '..', '..', 'probes', 'coins.json');
/** A real account that is not a token: the System Program. */
const NON_TOKEN = '11111111111111111111111111111111';

const LIMITS = {
  heliusRequests: 60,
  heliusCredits: 3_000,
  jupiterRequests: 30,
  gatewayRequests: 200,
  codexRequests: 25,
  codexUnits: 120,
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
function used(name: string): number {
  const v = arg(name);
  if (v === undefined) return 0;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) {
    console.error(`--${name} must be a non-negative integer`);
    process.exit(1);
  }
  return n;
}
function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`${name} is not set. Run with --env-file.`);
    process.exit(1);
  }
  return v;
}

const phase = arg('phase');
const outDir = arg('out');
if (!phase || !outDir) {
  console.error('usage: --phase assets|create|jupiter|gateways|codex --out DIR');
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });

interface Coin {
  mint: string;
  symbol: string;
  era: string;
}
const coins: Coin[] = JSON.parse(fs.readFileSync(COINS, 'utf8'));
const write = (name: string, value: unknown) =>
  fs.writeFileSync(path.join(outDir, name), JSON.stringify(value, null, 2) + '\n');
const read = (name: string) => JSON.parse(fs.readFileSync(path.join(outDir, name), 'utf8'));

/** Raw response bodies by label, kept so they can be saved as fixtures. */
const bodies: Array<{ label: string; body: string }> = [];

async function main(): Promise<void> {
  switch (phase) {
    case 'assets':
      return runAssets();
    case 'create':
      return runCreate();
    case 'jupiter':
      return runJupiter();
    case 'gateways':
      return runGateways();
    case 'codex':
      return runCodex();
    default:
      throw new Error(`unknown phase ${phase}`);
  }
}

function heliusClient(): { client: HeliusClient; requests: () => number } {
  let requests = used('used-helius-requests');
  const budget = new UnitBudget({
    ceilingUnits: LIMITS.heliusCredits - used('used-helius-credits'),
  });
  const base: FetchLike = async (url, init) => {
    if (requests >= LIMITS.heliusRequests) {
      throw new Error(
        `Helius request limit of ${LIMITS.heliusRequests} reached; not calling the API.`,
      );
    }
    requests++;
    const res = await fetch(url, init);
    const text = await res.text();
    bodies.push({ label: 'helius', body: text });
    return { status: res.status, ok: res.ok, headers: res.headers, text: async () => text };
  };
  const client = new HeliusClient({
    apiKey: need('HELIUS_API_KEY'),
    fetch: base,
    budget,
    limiter: new RateLimiter({ maxPerSecond: 5, burst: 1 }),
    http: { maxRetries: 0 },
  });
  return { client, requests: () => requests };
}

async function runAssets(): Promise<void> {
  const { client, requests } = heliusClient();
  const assets = await client.getAssets([...coins.map((c) => c.mint), NON_TOKEN]);
  write('assets.json', assets);
  write('assets-raw.json', JSON.parse(bodies[0]!.body));
  const s = client.spend();
  console.log(`assets: ${assets.length} rows, found ${assets.filter((a) => a.found).length}`);
  console.log(
    `token-2022: ${assets
      .filter((a) => a.tokenProgram === 'token-2022')
      .map((a) => coins.find((c) => c.mint === a.mint)?.symbol)
      .join(',')}`,
  );
  console.log(
    `helius requests this run ${requests() - used('used-helius-requests')}, credits ${s.units}`,
  );
}

async function runCreate(): Promise<void> {
  const { client, requests } = heliusClient();
  const rows: unknown[] = [];
  const raw: Record<string, unknown> = {};
  for (const c of coins) {
    const before = bodies.length;
    const r = await client.getCreateEvent(c.mint);
    if (bodies.length > before) raw[c.symbol.trim()] = JSON.parse(bodies[before]!.body);
    rows.push({ symbol: c.symbol.trim(), era: c.era, mint: c.mint, ...r });
    console.log(
      `${c.symbol.trim().padEnd(10)} ${r.status}${r.status === 'resolved' ? ` slot ${r.slot} t ${r.blockTime}` : ''}`,
    );
  }
  write('create-events.json', rows);
  write('create-raw.json', raw);
  console.log(
    `helius requests this run ${requests() - used('used-helius-requests')}, credits ${client.spend().units}`,
  );
}

async function runJupiter(): Promise<void> {
  let requests = used('used-jupiter');
  const base: GetFetchLike = async (url, init) => {
    if (requests >= LIMITS.jupiterRequests) {
      throw new Error(
        `Jupiter request limit of ${LIMITS.jupiterRequests} reached; not calling the API.`,
      );
    }
    requests++;
    const res = await fetch(url, init);
    const text = await res.text();
    bodies.push({ label: 'jupiter', body: text });
    return new Response(text, { status: res.status, headers: res.headers });
  };
  const apiKey = process.env['JUPITER_API_KEY'];
  const client = new JupiterClient({
    ...(apiKey ? { apiKey } : {}),
    fetch: base,
    http: { maxRetries: 0 },
  });
  const tokens = await client.getTokens([...coins.map((c) => c.mint), NON_TOKEN]);
  write('jupiter.json', tokens);
  write('jupiter-raw.json', JSON.parse(bodies[0]!.body));
  console.log(
    `jupiter: ${tokens.length} rows, found ${tokens.filter((t) => t.found).length}, priced ${tokens.filter((t) => t.priceUsd !== null).length}`,
  );
  console.log(`jupiter requests this run ${requests - used('used-jupiter')}`);
}

async function runGateways(): Promise<void> {
  const gateways = (arg('gateways') ?? '').split(',').filter(Boolean);
  if (gateways.length === 0)
    throw new Error('--gateways needs a comma-separated list of base URLs');
  const assets: Array<{ mint: string; uri: string | null; found: boolean }> = read('assets.json');
  let requests = used('used-gateway');
  const real = createSafeFetch();
  const counting: GetFetchLike = async (url, init) => {
    if (requests >= LIMITS.gatewayRequests) {
      throw new Error(`Gateway request limit of ${LIMITS.gatewayRequests} reached; not calling.`);
    }
    requests++;
    return real(url, init);
  };
  const table: Record<string, Record<string, string>> = {};
  const raws: Record<string, unknown> = {};
  for (const gw of gateways) {
    const host = new URL(gw).host;
    const fetcher = new MetadataFetcher({
      ipfsGateways: [{ url: gw, maxPerSecond: 1 }],
      fetch: counting,
      timeoutMs: 15_000,
    });
    table[host] = {};
    for (const c of coins) {
      const uri = assets.find((a) => a.mint === c.mint)?.uri;
      if (!uri) {
        table[host]![c.symbol.trim()] = 'no_uri';
        continue;
      }
      const r = await fetcher.fetch(uri);
      const a = r.attempts[0];
      table[host]![c.symbol.trim()] =
        `${r.outcome}${a ? `:${a.result}${a.status ? `:${a.status}` : ''}` : ''}`;
      if (r.outcome === 'ok') raws[`${host}/${c.symbol.trim()}`] = r.raw;
    }
    const counts: Record<string, number> = {};
    for (const v of Object.values(table[host]!)) counts[v] = (counts[v] ?? 0) + 1;
    console.log(host, JSON.stringify(counts));
  }
  write(`gateways-${Date.now()}.json`, { table, raws });
  console.log(`gateway requests this run ${requests - used('used-gateway')}`);
}

async function runCodex(): Promise<void> {
  let requests = used('used-codex-requests');
  const budget = new UnitBudget({ ceilingUnits: LIMITS.codexUnits - used('used-codex-units') });
  const base: FetchLike = async (url, init) => {
    if (requests >= LIMITS.codexRequests) {
      throw new Error(
        `Codex request limit of ${LIMITS.codexRequests} reached; not calling the API.`,
      );
    }
    requests++;
    const res = await fetch(url, init);
    const text = await res.text();
    return { status: res.status, ok: res.ok, headers: res.headers, text: async () => text };
  };
  const client = new CodexClient({
    apiKey: need('CODEX_API_KEY'),
    fetch: base,
    budget,
    limiter: new RateLimiter({ maxPerSecond: 4, burst: 1 }),
    http: { maxRetries: 0 },
  });
  const rows: unknown[] = [];
  for (const c of coins) {
    const info = await client.getLaunchInfo(c.mint);
    rows.push({
      symbol: c.symbol.trim(),
      mint: c.mint,
      createdAt: info?.createdAt ?? null,
      creator: info?.creator ?? null,
    });
  }
  write('codex.json', rows);
  console.log(
    `codex requests this run ${requests - used('used-codex-requests')}, units ${client.spend().units}`,
  );
}

main().catch((err: unknown) => {
  // Never print more than the message: errors from the clients carry no URLs or keys.
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : 'failed');
  process.exit(1);
});
