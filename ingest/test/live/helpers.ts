/**
 * A simulated world for the live loops: a Codex.io that lists graduates by migration time (with the
 * API's real limits: 200 rows a page, 10,000 deep) and answers the candle queries from simulated
 * 1-minute trading, a Jupiter that prices the same coins, and a clock the test moves by hand.
 * Nothing here reaches a provider; nothing sleeps.
 */
import { createRun, type Database, type StageName } from '@memecoinipedia/db';
import { createTestDatabase, getTestAdminUrl } from '@memecoinipedia/db/testing';
import type { TestDatabase } from '@memecoinipedia/db/testing';
import type { Kysely } from 'kysely';
import { describe } from 'vitest';
import { buildBackfillRegistry, BACKFILL_STAGES } from '../../src/backfill/setup.js';
import { CodexDayGate } from '../../src/live/gate.js';
import type { LiveDeps } from '../../src/live/deps.js';
import { LIVE_RUN_KIND } from '../../src/live/constants.js';
import { createPoolListQueue } from '../../src/live/topup.js';
import { UnitBudget } from '../../src/sources/budget.js';
import { CodexClient } from '../../src/sources/codex/index.js';
import type { FetchLike } from '../../src/sources/http.js';
import type { JupiterToken } from '../../src/sources/jupiter/client.js';
import { executeStage, type ExecuteOutcome } from '../../src/worker/execute.js';
import type { Logger } from '../../src/worker/log.js';
import type { SourceClients } from '../../src/worker/run.js';
import { UsageMeter } from '../../src/worker/usage.js';
import { syntheticMint } from '../backfill/synthetic.js';
import { minute, simProvider, type SimCoin } from '../candles/sim.js';
import { asset, okResult, token } from '../worker/helpers.js';

export const adminUrl = getTestAdminUrl();
export const describeDb = describe.skipIf(!adminUrl);

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

export class FakeClock {
  constructor(public ms: number) {}
  now = (): Date => new Date(this.ms);
  advance(ms: number): void {
    this.ms += ms;
  }
  set(iso: string): void {
    this.ms = Date.parse(iso);
  }
  get sec(): number {
    return Math.floor(this.ms / 1000);
  }
}

export function captureLog(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  const push = (level: string) => (m: string, f?: Record<string, unknown>) =>
    lines.push(`${level} ${m}${f ? ` ${JSON.stringify(f)}` : ''}`);
  return { log: { info: push('info'), warn: push('warn'), error: push('error') }, lines };
}

// ----------------------------------------------------------------------- the world

export interface WorldCoin {
  mint: string;
  symbol: string;
  name: string;
  createdAt: number;
  /** Graduation time, unix seconds. */
  migratedAt: number;
  /** Market cap in USD at a unix second at or after graduation. */
  capAt(t: number): number;
  /**
   * Market cap at the close of the 1-minute bar starting at `t`, when it differs from `capAt` (the
   * price Jupiter shows, which is also the bar's high): a coin whose price wicks above its closes.
   */
  closeAt?(t: number): number;
  /**
   * More pools of the coin, quoted in SOL: each appears in the pool list from `listedFrom` (unix
   * seconds) and trades from its own `createdAt` at `capAt`.
   */
  extraPools?: Array<{
    address: string;
    createdAt: number;
    listedFrom: number;
    liquidity: number;
    capAt(t: number): number;
  }>;
}

export const poolOf = (mint: string): string => `C${mint.slice(1)}`;
const mintOfPool = (pool: string): string => `D${pool.slice(1)}`;

export interface WorldStats {
  filterRequests: number;
  /** The largest `limit + offset` any filterTokens request asked for. */
  maxDepth: number;
  /** Requests the API would have refused: limit above 200 or depth above 10,000. */
  violations: number;
  otherRequests: number;
  /** Pool-list requests (`listPairsWithMetadataForToken`). */
  lists: number;
  /** Every getBars request: the mint, resolution code and range asked for. */
  bars: Array<{ mint: string; pool: string; resolution: string; from: number; to: number }>;
}

export interface World {
  coins: WorldCoin[];
  add(c: WorldCoin): void;
  byMint(mint: string): WorldCoin | undefined;
  fetch: FetchLike;
  stats: WorldStats;
  /** Makes filterTokens requests fail (HTTP 500) while this says so. */
  failFilter: (() => boolean) | null;
}

const respond = (body: unknown, status = 200) => ({
  status,
  ok: status < 400,
  headers: { get: () => null },
  text: async () => JSON.stringify(body),
});

/** A simulated pump.fun graduate whose market cap follows `capAt`. */
export function worldCoin(
  i: number,
  migratedAt: number,
  capAt: (t: number) => number,
  extra: Partial<WorldCoin> = {},
): WorldCoin {
  return {
    mint: syntheticMint(i, 9),
    symbol: `S${i}`,
    name: `Coin ${i}`,
    createdAt: migratedAt - 900,
    migratedAt,
    capAt,
    ...extra,
  };
}

export function createWorld(clock: FakeClock): World {
  const coins: WorldCoin[] = [];
  const index = new Map<string, WorldCoin>();
  const stats: WorldStats = {
    filterRequests: 0,
    maxDepth: 0,
    violations: 0,
    otherRequests: 0,
    lists: 0,
    bars: [],
  };
  const world: World = {
    coins,
    add(c) {
      coins.push(c);
      index.set(c.mint, c);
    },
    byMint: (m) => index.get(m),
    stats,
    failFilter: null,
    fetch: async (url, init) => {
      const query = (JSON.parse(init.body) as { query: string }).query;
      const f = /gte:(\d+), lte:(\d+)\}\}.*?limit:(\d+), offset:(\d+)\)/.exec(query);
      if (query.includes('filterTokens') && f) {
        stats.filterRequests++;
        if (world.failFilter?.()) return respond({ errors: [{ message: 'down' }] }, 500);
        const [gte, lte, limit, offset] = [f[1], f[2], f[3], f[4]].map(Number) as [
          number,
          number,
          number,
          number,
        ];
        stats.maxDepth = Math.max(stats.maxDepth, limit + offset);
        if (limit > 200 || limit + offset > 10_000) {
          stats.violations++;
          return respond({ errors: [{ message: 'limit + offset may not exceed 10000' }] });
        }
        const rows = coins
          .filter((c) => c.migratedAt >= gte && c.migratedAt <= lte && c.migratedAt <= clock.sec)
          .sort((a, b) => a.migratedAt - b.migratedAt || (a.mint < b.mint ? -1 : 1))
          .slice(offset, offset + limit);
        return respond({
          data: {
            filterTokens: {
              count: rows.length,
              page: Math.floor(offset / limit),
              results: rows.map((c) => ({
                token: {
                  address: c.mint,
                  symbol: c.symbol,
                  name: c.name,
                  createdAt: c.createdAt,
                  creatorAddress: null,
                  launchpad: {
                    launchpadName: 'Pump.fun',
                    migrated: true,
                    migratedAt: c.migratedAt,
                    migratedPoolAddress: poolOf(c.mint),
                    completed: true,
                    completedAt: c.migratedAt,
                    poolAddress: null,
                  },
                },
                pair: { address: poolOf(c.mint) },
                liquidity: 30_000,
              })),
            },
            usageData: { total: { computeUnits: Math.round((5 + 0.0048 * rows.length) * 1e6) } },
          },
        });
      }
      stats.otherRequests++;
      if (query.includes('listPairsWithMetadataForToken')) stats.lists++;
      const m =
        /address:"([1-9A-HJ-NP-Za-km-z]{32,44})"/.exec(query)?.[1] ??
        /tokenAddress:"([1-9A-HJ-NP-Za-km-z]{32,44})"/.exec(query)?.[1] ??
        (() => {
          const b = /getBars\(symbol:"([^:]+):/.exec(query);
          if (!b) return undefined;
          return (
            coins.find((c) => c.extraPools?.some((x) => x.address === b[1]))?.mint ??
            mintOfPool(b[1]!)
          );
        })();
      const coin = m ? index.get(m) : undefined;
      const bar = /getBars\(symbol:"[^"]+", from:(\d+), to:(\d+), resolution:"([^"]+)"/.exec(query);
      if (bar && coin) {
        stats.bars.push({
          mint: coin.mint,
          from: Number(bar[1]),
          to: Number(bar[2]),
          resolution: bar[3]!,
          pool: /getBars\(symbol:"([^:]+):/.exec(query)![1]!,
        });
      }
      if (!coin) throw new Error(`Unexpected query: ${query.slice(0, 100)}`);
      // The trading up to the clock: 1-minute bars from graduation on.
      const first = Math.floor(coin.migratedAt / 60) * 60;
      const last = Math.floor(clock.sec / 60) * 60;
      const minutes = [];
      for (let t = first; t <= last; t += 60) {
        const bar = minute(t, (coin.closeAt?.(t) ?? coin.capAt(t)) / 1e9, 3_000, 30_000);
        bar.h = Math.max(bar.h, coin.capAt(t) / 1e9);
        minutes.push(bar);
      }
      const sim: SimCoin = {
        mint: coin.mint,
        createdAt: coin.createdAt,
        migratedAt: coin.migratedAt,
        migratedPoolAddress: poolOf(coin.mint),
        pools: [
          {
            address: poolOf(coin.mint),
            exchange: 'PumpSwap',
            protocol: 'PumpAmm',
            createdAt: coin.migratedAt,
            liquidity: 30_000,
            minutes,
          },
          ...(coin.extraPools ?? [])
            .filter((x) => clock.sec >= x.listedFrom)
            .map((x) => {
              const own = [];
              for (let t = Math.floor(x.createdAt / 60) * 60; t <= last; t += 60) {
                // Busier than the main pool's 3,000 a minute, so its minutes win the one-window-per-time rule.
                own.push(minute(t, x.capAt(t) / 1e9, 60_000, x.liquidity));
              }
              return {
                address: x.address,
                exchange: 'Raydium',
                protocol: 'Raydium',
                createdAt: x.createdAt,
                liquidity: x.liquidity,
                minutes: own,
              };
            }),
        ],
      };
      return simProvider(sim).fetch(url, init);
    },
  };
  return world;
}

export interface FakeJupiter {
  getTokens(mints: readonly string[]): Promise<JupiterToken[]>;
  requests: number;
  /** Every mint asked for, in order, one entry per request. */
  asked: string[][];
  /** Mints this Jupiter does not know. */
  unknown: Set<string>;
  /** Supply to report for `fdv`/market cap. Default 1 billion. */
  supply: number;
  /** Overrides for what Jupiter answers for a mint (liquidity, volume, `found`...), by mint. */
  figures: Map<string, Partial<JupiterToken>>;
  /** Overrides for every mint at once: a function of the mint (return undefined for none). */
  figuresFor?: (mint: string) => Partial<JupiterToken> | undefined;
  /** Set to make the client report a pause (as `JupiterClient.pausedForMs`). */
  pausedForMs?: () => number;
  /** Set to make `getTokens` throw (a client that gave up on 429). The request is counted first. */
  failWith?: Error | null;
}

export function fakeJupiter(world: World, clock: FakeClock): FakeJupiter {
  const j: FakeJupiter = {
    requests: 0,
    asked: [],
    unknown: new Set(),
    supply: 1e9,
    figures: new Map(),
    async getTokens(mints) {
      j.requests++;
      j.asked.push([...mints]);
      if (j.failWith) throw j.failWith;
      return mints.map((mint) => {
        const over = j.figures.get(mint) ?? j.figuresFor?.(mint);
        if (over?.found === false)
          return token(mint, {
            found: false,
            priceUsd: null,
            marketCapUsd: null,
            liquidityUsd: null,
            volume24hUsd: null,
            totalSupply: null,
          });
        const c = world.byMint(mint);
        if (over && !c) return token(mint, over);
        if (!c || j.unknown.has(mint) || clock.sec < c.migratedAt) {
          return token(mint, {
            found: false,
            priceUsd: null,
            marketCapUsd: null,
            liquidityUsd: null,
            volume24hUsd: null,
            totalSupply: null,
          });
        }
        const price = c.capAt(clock.sec) / 1e9;
        return token(mint, { priceUsd: price, marketCapUsd: price * j.supply, ...over });
      });
    },
  };
  return j;
}

// -------------------------------------------------------------------------- fixture

export interface LiveFixture {
  t: TestDatabase;
  db: Kysely<Database>;
  clock: FakeClock;
  world: World;
  jupiter: FakeJupiter;
  codex: CodexClient;
  gate: CodexDayGate;
  runId: number;
  deps: LiveDeps;
  clients: SourceClients;
  /** Jobs the loops queued, in order. */
  queued: Array<{ stage: StageName; ids: number[] }>;
  logs: string[];
  /**
   * Runs the stages for the coins queued so far, the way the worker would: candles, then metrics,
   * then metadata, then the metadata file, each when the one before is done. No queue: the stage
   * is executed directly. Returns the outcome of every stage run.
   */
  drain(): Promise<Array<{ coinId: number; stage: StageName; outcome: ExecuteOutcome['kind'] }>>;
  cleanup(): Promise<void>;
}

export async function liveFixture(
  o: {
    startIso?: string;
    ceilingUnits?: number;
  } = {},
): Promise<LiveFixture> {
  const t = await createTestDatabase(adminUrl!);
  const clock = new FakeClock(Date.parse(o.startIso ?? '2026-11-15T10:00:00Z'));
  const world = createWorld(clock);
  const jupiter = fakeJupiter(world, clock);
  const codex = new CodexClient({
    apiKey: 'test-key-not-real',
    fetch: world.fetch,
    budget: new UnitBudget(),
    http: { maxRetries: 0, sleep: async () => {} },
  });
  const runId = await createRun(t.db, { kind: LIVE_RUN_KIND });
  const { log, lines } = captureLog();
  const gate = new CodexDayGate({
    db: t.db,
    ceilingUnits: o.ceilingUnits ?? 40_000,
    now: clock.now,
    runId,
    localUnits: () => {
      const s = codex.spend();
      return s.units + s.reservedUnits;
    },
    log,
  });
  const queued: LiveFixture['queued'] = [];
  const poolLists = createPoolListQueue(gate);
  const deps: LiveDeps = {
    db: t.db,
    codex,
    jupiter,
    enqueue: async (stage, ids) => {
      queued.push({ stage, ids: [...ids] });
    },
    gate,
    poolLists,
    now: clock.now,
    log,
  };
  const clients: SourceClients = {
    codex,
    helius: {
      getAssets: async (m) => m.map((x) => asset(x, { uri: `https://example.test/${x}.json` })),
    },
    jupiter,
    fetchMetadata: async (uri) => okResult({ description: `about ${uri.slice(-12)}` }),
  };
  const { registry } = buildBackfillRegistry({
    db: t.db,
    clients,
    meter: new UsageMeter(),
    stages: BACKFILL_STAGES,
    maxAttempts: 3,
    metadataCandidateIds: () => [],
    candlesAdmit: () => gate.admit(),
    topUpPools: (id) => poolLists.take(id),
  });
  const exec = { db: t.db, registry, now: clock.now, log, runId, maxAttempts: 3 };
  const chain: StageName[] = ['candles', 'metrics', 'metadata', 'metadata_file'];
  let drained = 0;
  return {
    t,
    db: t.db,
    clock,
    world,
    jupiter,
    codex,
    gate,
    runId,
    deps,
    clients,
    queued,
    logs: lines,
    async drain() {
      const out: Array<{ coinId: number; stage: StageName; outcome: ExecuteOutcome['kind'] }> = [];
      const ids = new Set<number>();
      for (; drained < queued.length; drained++) {
        const q = queued[drained]!;
        if (q.stage === 'candles') for (const id of q.ids) ids.add(id);
      }
      for (const coinId of ids) {
        for (const stage of chain) {
          const r = await executeStage(exec, stage, coinId);
          out.push({ coinId, stage, outcome: r.kind });
          if (r.kind !== 'done' && r.kind !== 'skipped' && r.kind !== 'final') break;
        }
      }
      return out;
    },
    cleanup: () => t.drop(),
  };
}

const MIN_S = 60;
const HOUR_S = 3_600;
const DAY_S = 86_400;
type Bar = WorldStats['bars'][number];

export const BUCKET: Record<string, number> = { '1D': DAY_S, '60': HOUR_S, '1': MIN_S };

/**
 * The requests of a later fetch that ask again for bars the first fetch held: same resolution, a
 * range overlapping what the first fetch covered. The bucket that was still forming when the
 * first fetch ended (today's daily bar, this hour's hourly bar) is not held, so it may be asked.
 */
export function reAsked(first: readonly Bar[], later: readonly Bar[], firstAsOf: number): Bar[] {
  return later.filter((b) =>
    first.some((h) => {
      if (h.resolution !== b.resolution) return false;
      const size = BUCKET[h.resolution]!;
      const heldEnd = Math.min(h.to + 1, Math.floor(firstAsOf / size) * size);
      return b.from < heldEnd && b.to + 1 > h.from;
    }),
  );
}
