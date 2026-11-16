/**
 * Synthetic candidates and a simulated provider for the backfill's tests and bench.
 *
 * `writeCandidateFile` writes a Dune-format CSV (epoch seconds, exponent form for large numbers,
 * the literal `<nil>` for a coin with no hourly price) of any size, with the spread of rough peaks
 * the real file has. `synthProvider` answers Codex.io requests without a network: most coins get
 * the cheapest shape (screened out after a launch lookup and one daily-bars request, answered
 * from nothing), so a run measures the queue and the database, not the simulator. A few get the
 * trading of the `mid` coin of the candle tests.
 */
import fs from 'node:fs';
import type { FetchLike } from '../../src/sources/http.js';
import { minute, simProvider, type SimCoin, type SimMinute, type SimPool } from '../candles/sim.js';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** A small deterministic generator: the same seed gives the same numbers everywhere. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The i-th synthetic mint: 44 base58 characters, starting with `D`, distinct for distinct i. */
export function syntheticMint(i: number, seed = 1): string {
  const rnd = mulberry32(i * 2654435761 + seed);
  let s = 'D';
  for (let k = 0; k < 38; k++) s += B58[Math.floor(rnd() * 58)];
  // The index in base 58 makes the mint distinct whatever the random part does.
  let x = i;
  let tail = '';
  for (let k = 0; k < 5; k++) {
    tail = B58[x % 58]! + tail;
    x = Math.floor(x / 58);
  }
  return s + tail;
}

/**
 * Share of coins in each rough-peak cell, as in the real candidate file (347,598 rows): under
 * $30k, $30k-50k, $50k-100k, $100k-1M, $1M-10M, $10M and more, and no price.
 */
export const CELL_SHARES = [129_210, 57_341, 59_685, 74_030, 15_640, 9_816, 1_876].map(
  (c) => c / 347_598,
);
const CELL_RANGES: Array<[number, number]> = [
  [2_000, 30_000],
  [30_000, 50_000],
  [50_000, 100_000],
  [100_000, 1_000_000],
  [1_000_000, 10_000_000],
  [10_000_000, 200_000_000],
];

export interface SyntheticRow {
  mint: string;
  createdAt: number;
  creator: string;
  graduatedAt: number;
  hours: number | null;
  peakMax: number | null;
  peakP999: number | null;
  peakAt: number | null;
  lastHour: number | null;
}

export function syntheticRow(i: number, seed = 1): SyntheticRow {
  const rnd = mulberry32(i * 40503 + seed * 7919);
  let u = rnd();
  let cell = 0;
  while (cell < CELL_SHARES.length - 1 && u >= CELL_SHARES[cell]!) {
    u -= CELL_SHARES[cell]!;
    cell++;
  }
  const createdAt = 1_712_000_000 + Math.floor(rnd() * 60_000_000);
  const base = {
    mint: syntheticMint(i, seed),
    createdAt,
    creator: syntheticMint(i + 5_000_000, seed + 1),
    graduatedAt: createdAt + 600 + Math.floor(rnd() * 20_000),
  };
  if (cell === 6) {
    return { ...base, hours: null, peakMax: null, peakP999: null, peakAt: null, lastHour: null };
  }
  const [lo, hi] = CELL_RANGES[cell]!;
  const p999 = Math.round(lo + (hi - lo) * rnd() ** (cell >= 4 ? 3 : 1));
  return {
    ...base,
    hours: 24 + Math.floor(rnd() * 3000),
    peakMax: Math.round(p999 * (1 + rnd())),
    peakP999: p999,
    peakAt: base.graduatedAt + 3600,
    lastHour: base.graduatedAt + 86_400 * 30,
  };
}

const field = (v: number | null): string =>
  v === null ? '<nil>' : v >= 1_000_000 ? v.toExponential() : String(v);

/** Writes `rows` synthetic candidates as a Dune-format CSV; returns how many were written. */
export async function writeCandidateFile(path: string, rows: number, seed = 1): Promise<number> {
  const out = fs.createWriteStream(path);
  const write = (text: string) =>
    new Promise<void>((resolve, reject) => {
      if (out.write(text)) resolve();
      else out.once('drain', resolve);
      out.once('error', reject);
    });
  await write(
    'mint,created_at,creator,graduated_at,hours,peak_max_usd,peak_p999_usd,peak_at,last_hour\n',
  );
  let buf = '';
  for (let i = 0; i < rows; i++) {
    const r = syntheticRow(i, seed);
    buf += `${r.mint},${r.createdAt},${r.creator},${r.graduatedAt},${field(r.hours)},${field(r.peakMax)},${field(r.peakP999)},${field(r.peakAt)},${field(r.lastHour)}\n`;
    if (buf.length > 1 << 20) {
      await write(buf);
      buf = '';
    }
  }
  if (buf) await write(buf);
  await new Promise<void>((resolve, reject) => {
    out.end(() => resolve());
    out.once('error', reject);
  });
  return rows;
}

// ---------------------------------------------------------------- the provider

const SMALL_PRICE = 20_000 / 1e9;
const poolOf = (mint: string): string => `C${mint.slice(1)}`;
const mintOfPool = (pool: string): string => `D${pool.slice(1)}`;
const usage = { total: { computeUnits: 4_000_000 } };

const DAY = 86_400;

/** The index a synthetic mint was made from (its last five characters). */
export function indexOfMint(mint: string): number {
  let x = 0;
  for (const ch of mint.slice(-5)) x = x * 58 + B58.indexOf(ch);
  return x;
}

/** Launch and graduation times of a synthetic coin: the ones its candidate row carries. */
function timesOf(mint: string, seed: number): { launch: number; grad: number } {
  const r = syntheticRow(indexOfMint(mint), seed);
  return { launch: r.createdAt, grad: r.graduatedAt };
}
const dense = (start: number, n: number, price: (i: number) => number): SimMinute[] =>
  Array.from({ length: n }, (_, i) => minute(start + i * 60, price(i), 3_000));

/** A coin that climbs to $500,000: past the screen, so it fetches minute and hourly bars. */
function midCoin(mint: string, launch: number, gradAt: number): SimCoin {
  const LAUNCH = launch;
  const GRAD = Math.floor(gradAt / 60) * 60;
  const grad: SimPool = {
    address: poolOf(mint),
    exchange: 'PumpSwap',
    protocol: 'PumpAmm',
    createdAt: GRAD,
    liquidity: 30_000,
    minutes: [
      ...dense(GRAD, 200, (i) => (60_000 + i * 2_211) / 1e9),
      ...Array.from({ length: 6 }, (_, k) => minute(GRAD + 2 * DAY + k * 600, 200_000 / 1e9)),
    ],
  };
  return {
    mint,
    createdAt: LAUNCH,
    migratedAt: GRAD,
    migratedPoolAddress: grad.address,
    pools: [grad],
  };
}

/** One in this many coins takes the heavier `mid` path. */
export const MID_ONE_IN = 20;
const isMid = (mint: string): boolean => {
  let h = 0;
  for (let i = 1; i < 12; i++) h = (h * 31 + mint.charCodeAt(i)) >>> 0;
  return h % MID_ONE_IN === 0;
};

export interface SynthProvider {
  fetch: FetchLike;
  /** Requests answered (every attempt, including refused ones). */
  requests(): number;
  /** Requests answered with a rate-limit refusal. */
  refused(): number;
}

export interface SynthOptions {
  /** The seed the candidate file was written with. Default 1. */
  seed?: number;
  /** Milliseconds each answer takes. Default 0: answered at once. */
  latencyMs?: number;
  /**
   * Decides, for the n-th request (1-based) with this query, to answer with something else:
   * return a status for an HTTP error, or `'graphql_rate_limit'` for the 200 answer carrying
   * Codex's `TOO_MANY_REQUESTS` error.
   */
  refuse?: (n: number, query: string) => 429 | 'graphql_rate_limit' | undefined;
}

export function synthProvider(opts: SynthOptions = {}): SynthProvider {
  let requests = 0;
  let refused = 0;
  const mids = new Map<string, ReturnType<typeof simProvider>>();
  const respond = (data: unknown) => {
    const text = JSON.stringify({ data });
    return { status: 200, ok: true, headers: { get: () => null }, text: async () => text };
  };
  const fetchImpl: FetchLike = async (url, init) => {
    const query = (JSON.parse(init.body) as { query: string }).query;
    const n = ++requests;
    if (opts.latencyMs) await new Promise((r) => setTimeout(r, opts.latencyMs));
    const refusal = opts.refuse?.(n, query);
    if (refusal === 429) {
      refused++;
      return {
        status: 429,
        ok: false,
        headers: { get: (h: string) => (h.toLowerCase() === 'retry-after' ? '1' : null) },
        text: async () =>
          '{"errors":[{"message":"rate limited","extensions":{"code":"TOO_MANY_REQUESTS"}}]}',
      };
    }
    if (refusal === 'graphql_rate_limit') {
      refused++;
      const text = JSON.stringify({
        errors: [
          {
            message: 'Your account has been rate limited, please upgrade your plan',
            extensions: { code: 'TOO_MANY_REQUESTS' },
          },
        ],
      });
      return { status: 200, ok: true, headers: { get: () => null }, text: async () => text };
    }
    const mintMatch = /address:"([1-9A-HJ-NP-Za-km-z]{32,44})"/.exec(query);
    const listMatch = /tokenAddress:"([1-9A-HJ-NP-Za-km-z]{32,44})"/.exec(query);
    const barsMatch =
      /getBars\(symbol:"([^:]+):\d+", from:(\d+), to:(\d+), resolution:"(\w+)"/.exec(query);
    const mint = mintMatch?.[1] ?? listMatch?.[1] ?? (barsMatch ? mintOfPool(barsMatch[1]!) : null);
    if (!mint) throw new Error(`Unexpected query: ${query.slice(0, 100)}`);
    if (isMid(mint)) {
      let sim = mids.get(mint);
      if (!sim) {
        const tm = timesOf(mint, opts.seed ?? 1);
        sim = simProvider(midCoin(mint, tm.launch, tm.grad));
        mids.set(mint, sim);
        // Bounded: the oldest simulated coins are forgotten.
        if (mids.size > 500) mids.delete(mids.keys().next().value as string);
      }
      return sim.fetch(url, init);
    }
    const tm = timesOf(mint, opts.seed ?? 1);
    if (mintMatch) {
      return respond({
        token: {
          address: mint,
          symbol: 'SYN',
          name: 'Synthetic',
          createdAt: tm.launch,
          creatorAddress: null,
          launchpad: {
            launchpadName: 'Pump.fun',
            migrated: true,
            migratedAt: tm.grad,
            migratedPoolAddress: poolOf(mint),
            completed: true,
            completedAt: tm.grad,
            poolAddress: null,
          },
        },
        usageData: usage,
      });
    }
    if (listMatch) {
      return respond({
        listPairsWithMetadataForToken: {
          results: [
            {
              liquidity: 30_000,
              volume: 0,
              quoteToken: 'token1',
              backingToken: {
                address: 'So11111111111111111111111111111111111111112',
                symbol: 'SOL',
              },
              exchange: { name: 'PumpSwap' },
              pair: {
                address: poolOf(mint),
                createdAt: tm.grad,
                protocol: 'PumpAmm',
                exchangeHash: null,
                token0: mint,
                token1: null,
              },
            },
          ],
        },
        usageData: usage,
      });
    }
    // A bars request: one daily bar at a price that stays under the screen.
    const from = Number(barsMatch![2]);
    const t = Math.floor(from / DAY) * DAY;
    return respond({
      getBars: {
        t: [t],
        o: [SMALL_PRICE],
        h: [SMALL_PRICE],
        l: [SMALL_PRICE],
        c: [SMALL_PRICE],
        volume: [3_000],
        transactions: [200],
        traders: [10],
        liquidity: [20_000],
      },
      usageData: usage,
    });
  };
  return { fetch: fetchImpl, requests: () => requests, refused: () => refused };
}
