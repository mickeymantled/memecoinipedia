import type { FetchLike } from '../../src/sources/http.js';

/** One minute of trading in a simulated pool. */
export interface SimMinute {
  /** Minute start, unix seconds, a multiple of 60. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  volume: number;
  liquidity: number;
}

export interface SimPool {
  address: string;
  exchange: string;
  protocol: string;
  createdAt: number;
  /** Listed liquidity, USD. */
  liquidity: number;
  minutes: SimMinute[];
  /** The quote (backing) token the pool lists; wrapped SOL when absent. */
  quote?: { address: string; symbol: string };
}

export interface SimCoin {
  mint: string;
  createdAt: number;
  migratedAt: number | null;
  /** What launch info names as the migrated pool; null makes the fetcher look the pool list up. */
  migratedPoolAddress: string | null;
  pools: SimPool[];
}

const RES_SEC: Record<string, number> = { '1': 60, '60': 3600, '1D': 86400 };
const usage = { total: { computeUnits: 4_000_000 } };

/** A minute that traded at one price. */
export const minute = (
  t: number,
  price: number,
  volume = 2_000,
  liquidity = 20_000,
): SimMinute => ({
  t,
  o: price,
  h: price,
  l: price,
  c: price,
  volume,
  liquidity,
});

/**
 * A provider that answers from simulated 1-minute trading, building hourly and
 * daily bars on demand, the way the real one does (only buckets with trades).
 * Counts every query. Each call reports 4 compute units.
 */
export function simProvider(coin: SimCoin): {
  fetch: FetchLike;
  queries: string[];
  barsQueries(): string[];
  lookups(): string[];
} {
  const queries: string[] = [];
  const respond = (data: unknown) => {
    const text = JSON.stringify({ data });
    return { status: 200, ok: true, headers: { get: () => null }, text: async () => text };
  };
  const fetchImpl: FetchLike = async (_url, init) => {
    const query = (JSON.parse(init.body) as { query: string }).query;
    queries.push(query);
    if (query.includes('token(input')) {
      return respond({
        token: {
          address: coin.mint,
          symbol: 'SIM',
          name: 'Sim',
          createdAt: coin.createdAt,
          creatorAddress: null,
          launchpad: {
            launchpadName: 'Pump.fun',
            migrated: coin.migratedAt !== null,
            migratedAt: coin.migratedAt,
            migratedPoolAddress: coin.migratedPoolAddress,
            completed: coin.migratedAt !== null,
            completedAt: coin.migratedAt,
            poolAddress: null,
          },
        },
        usageData: usage,
      });
    }
    if (query.includes('listPairsWithMetadataForToken')) {
      return respond({
        listPairsWithMetadataForToken: {
          results: coin.pools.map((p) => ({
            liquidity: p.liquidity,
            volume: 0,
            quoteToken: 'token1',
            backingToken: p.quote ?? {
              address: 'So11111111111111111111111111111111111111112',
              symbol: 'SOL',
            },
            exchange: { name: p.exchange },
            pair: {
              address: p.address,
              createdAt: p.createdAt,
              protocol: p.protocol,
              exchangeHash: null,
              token0: coin.mint,
              token1: null,
            },
          })),
        },
        usageData: usage,
      });
    }
    const m = /getBars\(symbol:"([^:]+):\d+", from:(\d+), to:(\d+), resolution:"(\w+)"/.exec(query);
    if (!m) throw new Error(`Unexpected query: ${query.slice(0, 120)}`);
    const [, address, fromS, toS, res] = m;
    const pool = coin.pools.find((p) => p.address === address);
    const step = RES_SEC[res!]!;
    const from = Number(fromS);
    const to = Number(toS);
    const buckets = new Map<number, SimMinute[]>();
    for (const mn of pool?.minutes ?? []) {
      const b = Math.floor(mn.t / step) * step;
      if (b < from || b > to) continue;
      (buckets.get(b) ?? buckets.set(b, []).get(b)!).push(mn);
    }
    const ts = [...buckets.keys()].sort((a, b) => a - b);
    const cols = {
      t: ts as number[],
      o: [],
      h: [],
      l: [],
      c: [],
      volume: [],
      transactions: [],
      traders: [],
      liquidity: [],
    } as Record<string, number[]>;
    for (const b of ts) {
      const ms = buckets.get(b)!.sort((x, y) => x.t - y.t);
      cols['o']!.push(ms[0]!.o);
      cols['h']!.push(Math.max(...ms.map((x) => x.h)));
      cols['l']!.push(Math.min(...ms.map((x) => x.l)));
      cols['c']!.push(ms[ms.length - 1]!.c);
      cols['volume']!.push(ms.reduce((s, x) => s + x.volume, 0));
      cols['transactions']!.push(ms.length * 20);
      cols['traders']!.push(10);
      cols['liquidity']!.push(ms[ms.length - 1]!.liquidity);
    }
    return respond({ getBars: cols, usageData: usage });
  };
  return {
    fetch: fetchImpl,
    queries,
    barsQueries: () => queries.filter((q) => q.includes('getBars(')),
    lookups: () => queries.filter((q) => !q.includes('getBars(')),
  };
}
