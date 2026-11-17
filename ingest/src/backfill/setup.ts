/**
 * The pieces of a backfill that differ from the sample run: the provider clients (a Codex.io
 * client with a configurable rate, one reused connection pool and a limiter that backs off when
 * the provider says to), and the stage registry with the backfill's stage order.
 *
 * Stage order in a backfill, expressed in the stage contract and not in the worker:
 *
 *   discovered -> candles -> metrics -> metadata (only for coins with an ATH of $100,000 or more)
 *
 * `candles` and `metrics` keep the default requirements. `metadata` is registered with
 * `requires: 'metrics'` and `onlyIf: { minAthMarketCapUsd: LISTED_ATH_USD }`: it runs after the
 * metrics are known, and only for coins that came out listed. The sample run registers the same
 * stage without those two fields, so it keeps its behaviour (metadata for every coin).
 */
import type { Database } from '@memecoinipedia/db';
import type { Kysely } from 'kysely';
import { UnitBudget } from '../sources/budget.js';
import {
  CODEX_PROVIDER,
  CodexClient,
  createCodexTransport,
  type CodexTransport,
} from '../sources/codex/index.js';
import { HELIUS_PROVIDER } from '../sources/helius/costs.js';
import { HeliusClient } from '../sources/helius/client.js';
import { JupiterClient, jupiterPauseUsage } from '../sources/jupiter/client.js';
import { MetadataFetcher } from '../sources/metadata/fetch.js';
import { RateLimiter } from '../sources/ratelimit.js';
import { DEFAULT_GATEWAY_RPS, type IngestEnv, type SourceClients } from '../worker/run.js';
import { LISTED_ATH_USD, StageRegistry, type Stage } from '../worker/stage.js';
import { createCandlesStage, type CandlesStage } from '../worker/stages/candles.js';
import { discoveredStage } from '../worker/stages/discovered.js';
import {
  createMetadataLoaders,
  createMetadataStage,
  type MetadataStage,
  type HeliusAssets,
  type JupiterPrices,
} from '../worker/stages/metadata.js';
import { createMetadataFileStage } from '../worker/stages/metadataFile.js';
import { metricsStage } from '../worker/stages/metrics.js';
import type { UsageMeter } from '../worker/usage.js';

export type BackfillStageName = 'candles' | 'metrics' | 'metadata' | 'metadata_file';
export const BACKFILL_STAGES: readonly BackfillStageName[] = [
  'candles',
  'metrics',
  'metadata',
  'metadata_file',
];
/**
 * The stages a backfill runs when `--stages` is not given. `metadata_file` is left out: it is
 * paced by the gateways and is run by itself (`--stages metadata_file`).
 */
export const DEFAULT_BACKFILL_STAGES: readonly BackfillStageName[] = [
  'candles',
  'metrics',
  'metadata',
];

export interface BackfillClientOptions {
  codexRps: number;
  maxCodexUnits: number | null;
  maxHeliusCredits: number | null;
  gatewayRps: number;
  needCodex: boolean;
  needHelius: boolean;
  /** Told when the provider asks for a long pause. */
  onWarning?: (message: string) => void;
}

export interface BackfillClients extends SourceClients {
  /** Closes the connection pool of the Codex.io transport. */
  close(): Promise<void>;
  /** The Codex.io limiter, for the run summary. */
  codexLimiter?: RateLimiter;
}

export function createBackfillClients(env: IngestEnv, o: BackfillClientOptions): BackfillClients {
  if (o.needHelius && !env.HELIUS_API_KEY) throw new Error('HELIUS_API_KEY is not set');
  let codex: CodexClient | undefined;
  let transport: CodexTransport | undefined;
  let codexLimiter: RateLimiter | undefined;
  if (o.needCodex) {
    if (!env.CODEX_API_KEY) throw new Error('CODEX_API_KEY is not set');
    transport = createCodexTransport();
    // A small bucket smooths timer jitter; the sustained rate is `codexRps`.
    codexLimiter = new RateLimiter({
      maxPerSecond: o.codexRps,
      burst: Math.max(1, Math.ceil(o.codexRps / 20)),
      ...(o.onWarning ? { onWarning: o.onWarning } : {}),
    });
    codex = new CodexClient({
      apiKey: env.CODEX_API_KEY,
      budget: new UnitBudget(o.maxCodexUnits === null ? {} : { ceilingUnits: o.maxCodexUnits }),
      limiter: codexLimiter,
      fetch: transport.fetch,
    });
  }
  const helius = new HeliusClient({
    apiKey: env.HELIUS_API_KEY ?? '',
    budget: new UnitBudget(o.maxHeliusCredits === null ? {} : { ceilingUnits: o.maxHeliusCredits }),
    limiter: new RateLimiter({ maxPerSecond: 1, burst: 1 }),
  });
  const jupiter = new JupiterClient(env.JUPITER_API_KEY ? { apiKey: env.JUPITER_API_KEY } : {});
  // One rate limiter per host inside the fetcher: a gateway is never asked faster than this.
  const fetcher = new MetadataFetcher({ gatewayMaxPerSecond: o.gatewayRps });
  return {
    helius,
    jupiter,
    fetchMetadata: (uri) => fetcher.fetch(uri),
    ...(codex ? { codex } : {}),
    ...(codexLimiter ? { codexLimiter } : {}),
    readUsage: () => {
      const h = helius.spend();
      const c = codex?.spend();
      return {
        [HELIUS_PROVIDER]: { requests: h.requests, units: h.units },
        jupiter: { requests: jupiter.requestCount(), units: 0 },
        ...jupiterPauseUsage(jupiter),
        ...(c ? { [CODEX_PROVIDER]: { requests: c.requests, units: c.units } } : {}),
      };
    },
    close: async () => {
      await transport?.close();
    },
  };
}

export interface BackfillRegistryOptions {
  db: Kysely<Database>;
  clients: SourceClients;
  meter: UsageMeter;
  stages: readonly BackfillStageName[];
  maxAttempts: number;
  /** The coin ids the worker takes next for metadata (the first `limit`), for the loaders to prefetch with. */
  metadataCandidateIds: (limit: number) => readonly number[] | Promise<readonly number[]>;
  /**
   * An extra condition on the candles stage taking a coin, asked before the stage's own (the live
   * process closes it while the day's unit ceiling is reached). Absent: the stage as it is.
   */
  candlesAdmit?: () => boolean;
  /** Coins whose candles stage lists the pools again (a refresh run). */
  refreshPools?: (coinId: number) => boolean;
  /** Coins whose old pool list the live top-up reads again (issue #87). */
  topUpPools?: (coinId: number) => boolean;
  /** How long Jupiter's rate limit holds the metadata stage, in milliseconds. Absent: for the run (a backfill stops on it). */
  metadataStopHoldMs?: number;
}

/** The stage `metadata` (or `metadata_file`) as the backfill runs it: after `metrics`, for listed coins only. */
export function backfillMetadataStage<S extends Stage>(stage: S): S {
  // `Object.create` keeps the stage's getters (`stopped`), which a spread would freeze.
  return Object.create(stage, {
    requires: { value: 'metrics', enumerable: true },
    onlyIf: { value: { minAthMarketCapUsd: LISTED_ATH_USD }, enumerable: true },
  }) as S;
}

/** The stage `metadata_file` as the backfill runs it: after `metadata`, for listed coins only. */
export function backfillMetadataFileStage(stage: Stage): Stage {
  return { ...stage, requires: 'metadata', onlyIf: { minAthMarketCapUsd: LISTED_ATH_USD } };
}

export function buildBackfillRegistry(o: BackfillRegistryOptions): {
  registry: StageRegistry;
  candles: CandlesStage | null;
  metadata: MetadataStage | null;
} {
  const registry = new StageRegistry().register(discoveredStage);
  let candles: CandlesStage | null = null;
  let metadata: MetadataStage | null = null;
  if (o.stages.includes('candles')) {
    if (!o.clients.codex) throw new Error('The candles stage needs a Codex.io client');
    candles = createCandlesStage({
      codex: o.clients.codex,
      ...(o.refreshPools ? { refreshPools: o.refreshPools } : {}),
      ...(o.topUpPools ? { topUpPools: o.topUpPools } : {}),
    });
    const own = candles;
    const extra = o.candlesAdmit;
    // The stage object keeps its getters (`stopped`): the registered one is a view of it.
    registry.register(
      extra
        ? Object.create(own, {
            admit: { value: () => extra() && own.admit!(), enumerable: true },
          })
        : own,
    );
  }
  if (o.stages.includes('metrics')) registry.register(metricsStage);
  if (o.stages.includes('metadata')) {
    const { assets, prices } = createMetadataLoaders({
      db: o.db,
      helius: o.clients.helius as HeliusAssets,
      jupiter: o.clients.jupiter as JupiterPrices,
      maxAttempts: o.maxAttempts,
      requires: 'metrics',
      minAthMarketCapUsd: LISTED_ATH_USD,
      candidateIds: o.metadataCandidateIds,
    });
    metadata = createMetadataStage({
      assets,
      prices,
      ...(o.metadataStopHoldMs !== undefined ? { stopHoldMs: o.metadataStopHoldMs } : {}),
    });
    registry.register(backfillMetadataStage(metadata));
  }
  if (o.stages.includes('metadata_file')) {
    registry.register(
      backfillMetadataFileStage(
        createMetadataFileStage({ fetchMetadata: o.clients.fetchMetadata, usage: o.meter }),
      ),
    );
  }
  return { registry, candles, metadata };
}

export { DEFAULT_GATEWAY_RPS };
