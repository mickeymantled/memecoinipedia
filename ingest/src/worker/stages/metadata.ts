/**
 * The `metadata` stage: what a coin is called, where its metadata file lives, and its price.
 *
 * For one coin it
 *   1. takes the on-chain asset from Helius `getAssetBatch` (one request per
 *      1,000 coins, through a prefetching loader, not one per coin),
 *   2. takes the current price from Jupiter (100 coins per request),
 *   3. stores ticker, name, token program id, metadata URI, the description and the image
 *      reference when Helius carries them, and the price.
 *
 * It makes no gateway request and fetches no image: the metadata file is the `metadata_file`
 * stage (see metadataFile.ts). The image reference has no gateway host (see image.ts).
 *
 * Social links from Jupiter's token answer are stored (cleaned like a file's links) only for coins
 * whose file was not read (`socials_source` is not `metadata_file`), with source `jupiter`; `decideSocials`
 * (socials.ts) is the one rule, shared with the file stage.
 *
 * Description and image from Helius are written only while `metadata_file` is not done for the
 * coin. Once the file stage is done, its values (the file is the record of what the creator wrote
 * at launch) are never replaced by a re-run of this stage.
 *
 * Data issues this stage owns: Helius knowing no asset for the mint (`asset_not_found`), a row of
 * the wrong shape (`asset_invalid`), an asset with no URI (`metadata_no_uri`) and a price of the
 * wrong shape (`price_invalid`). Each is `done` with the issue, because a retry cannot change it.
 * A Helius or Jupiter error fails the stage as retryable.
 *
 * Token program: the program id is stored (`TokenkegQ...` or `TokenzQd...`),
 * not a label, because it is exact and the label can be derived from it.
 * Market cap is price times the coin's `total_supply` (1 billion for pump.fun).
 */
import {
  listCoinsNotDone,
  replaceCoinIssues,
  type Database,
  type NewIssue,
  type StageName,
} from '@memecoinipedia/db';
import { sql, type Kysely } from 'kysely';
import { BudgetExceededError } from '../../sources/budget.js';
import type { AssetInfo } from '../../sources/helius/client.js';
import { JupiterRateLimitedError, type JupiterToken } from '../../sources/jupiter/client.js';
import { cleanText } from '../../sources/metadata/parse.js';
import { decideSocials } from './socials.js';
import { PrefetchLoader } from '../batch.js';
import { done, failed, type Stage, type StageContext, type StageCoin } from '../stage.js';
import { imageReference } from './image.js';

/** 3: Jupiter's social links are stored for coins whose metadata file is not done (issue #89). */
export const METADATA_STAGE_VERSION = 3;

/** Issue kinds this stage owns: it replaces them on every run. */
export const METADATA_ISSUE_KINDS = [
  'asset_not_found',
  'asset_invalid',
  'metadata_no_uri',
  'price_invalid',
] as const;

export interface AssetLookup {
  get(mint: string): Promise<AssetInfo>;
}
export interface PriceLookup {
  get(mint: string): Promise<JupiterToken>;
}

export interface MetadataStageDeps {
  assets: AssetLookup;
  prices: PriceLookup;
  /**
   * How long the stage takes no new coin after Jupiter kept answering 429, in milliseconds.
   * Absent: until the process ends (a backfill run stops on it).
   */
  stopHoldMs?: number;
  /** Milliseconds, for `stopHoldMs`. Default `Date.now`. */
  now?: () => number;
}

/** The metadata stage, with the stop that Jupiter's rate limit can put on it (like the candles stage's ceiling stop). */
export interface MetadataStage extends Stage {
  /** True while Jupiter's 429s have stopped the stage. */
  readonly stopped: boolean;
  /** Why it stopped, for the run summary; null when it has not. */
  readonly stopReason: string | null;
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const errorText = (err: unknown): string =>
  clip(err instanceof Error ? err.message : String(err), 300);

export function createMetadataStage(deps: MetadataStageDeps): MetadataStage {
  const clock = deps.now ?? Date.now;
  let stopReason: string | null = null;
  let stoppedAt = 0;
  const isStopped = (): boolean => {
    if (stopReason === null) return false;
    if (deps.stopHoldMs !== undefined && clock() - stoppedAt >= deps.stopHoldMs) {
      stopReason = null;
      return false;
    }
    return true;
  };
  return {
    get stopped() {
      return isStopped();
    },
    get stopReason() {
      return isStopped() ? stopReason : null;
    },
    admit: () => !isStopped(),
    name: 'metadata',
    version: METADATA_STAGE_VERSION,
    async run(ctx: StageContext, coin: StageCoin) {
      const issues: NewIssue[] = [];

      // 1. On-chain asset.
      let asset: AssetInfo;
      try {
        asset = await deps.assets.get(coin.address);
      } catch (err) {
        if (err instanceof BudgetExceededError) throw err;
        return failed(`helius_error: ${errorText(err)}`, true);
      }
      if (!asset.found) {
        issues.push({ kind: 'asset_not_found', detail: { source: 'helius' } });
      } else if (asset.invalid) {
        issues.push({
          kind: 'asset_invalid',
          detail: { source: 'helius', problems: asset.invalid },
        });
      }
      const usable = asset.found && !asset.invalid;
      const ticker = usable ? cleanText(asset.symbol) : null;
      const name = usable ? cleanText(asset.name) : null;
      const uri = usable ? cleanText(asset.uri) : null;
      if (usable && uri === null) issues.push({ kind: 'metadata_no_uri' });

      // What the chain says is kept even if the rest of the stage has to be retried.
      if (usable) {
        await ctx.db
          .updateTable('coins')
          .set({
            ticker,
            name,
            token_program: asset.tokenProgramId,
            metadata_uri: uri,
            updated_at: ctx.now(),
          })
          .where('id', '=', coin.id)
          .execute();
        // The description and image Helius holds. Once the `metadata_file` stage is done for the
        // coin, the file's values stand (the file is the record of what the creator wrote at
        // launch): a later run of this stage, after a version bump, must not put Helius's back.
        // The condition is part of the UPDATE, so a file stage finishing in between is not undone.
        await ctx.db
          .updateTable('coins')
          .set({
            description: cleanText(asset.description),
            image_url: imageReference(asset.image),
            updated_at: ctx.now(),
          })
          .where('id', '=', coin.id)
          .where((eb) =>
            eb.not(
              eb.exists(
                eb
                  .selectFrom('coin_stages as f')
                  .select(sql.lit(1).as('one'))
                  .where('f.coin_id', '=', coin.id)
                  .where('f.stage', '=', 'metadata_file')
                  .where('f.status', '=', 'done'),
              ),
            ),
          )
          .execute();
      }

      // 2. Current price.
      let price: JupiterToken;
      try {
        price = await deps.prices.get(coin.address);
      } catch (err) {
        if (err instanceof BudgetExceededError) throw err;
        if (err instanceof JupiterRateLimitedError) {
          // The run's doing, not this coin's: stop taking coins, put this one back, keep its attempt.
          if (!isStopped()) {
            stopReason = err.message;
            stoppedAt = clock();
          }
          return failed(`jupiter_rate_limited: ${errorText(err)}`, true, true);
        }
        return failed(`price_error: ${errorText(err)}`, true);
      }
      if (price.invalid) {
        issues.push({
          kind: 'price_invalid',
          detail: { source: 'jupiter', problems: price.invalid },
        });
      }

      // 3. Store.
      if (price.found && !price.invalid) {
        const supply = Number(coin.total_supply);
        await ctx.db
          .updateTable('coins')
          .set({
            current_price_usd: price.priceUsd,
            current_liquidity_usd: price.liquidityUsd,
            current_volume_24h_usd: price.volume24hUsd,
            current_market_cap_usd:
              price.priceUsd !== null && Number.isFinite(supply) ? price.priceUsd * supply : null,
            current_refreshed_at: ctx.now(),
            updated_at: ctx.now(),
          })
          .where('id', '=', coin.id)
          .execute();
      }
      await replaceCoinIssues(ctx.db, coin.id, METADATA_ISSUE_KINDS, issues);

      // 4. Social links from Jupiter, unless the coin's own file was read (the record of launch).
      if (price.found && !price.invalid) {
        const stored = await ctx.db
          .selectFrom('coins')
          .select('socials_source')
          .where('id', '=', coin.id)
          .executeTakeFirst();
        const decision = decideSocials({
          from: 'jupiter',
          links: { website: price.website, twitter: price.twitter, telegram: price.telegram },
          currentSource: stored?.socials_source ?? null,
        });
        if (decision) {
          // The condition is part of the UPDATE, so a file stage finishing in between is not undone.
          const res = await ctx.db
            .updateTable('coins')
            .set({
              socials: JSON.stringify(decision.socials),
              socials_source: decision.source,
              updated_at: ctx.now(),
            })
            .where('id', '=', coin.id)
            // The column is the guard: a file read in between has set `metadata_file`.
            .where((eb) =>
              eb.or([
                eb('socials_source', 'is', null),
                eb('socials_source', '<>', 'metadata_file'),
              ]),
            )
            .executeTakeFirst();
          if (Number(res.numUpdatedRows) === 1) {
            await replaceCoinIssues(
              ctx.db,
              coin.id,
              ['social_links_dropped'],
              decision.dropped.length > 0
                ? [
                    {
                      kind: 'social_links_dropped',
                      detail: { links: decision.dropped, source: 'jupiter' },
                    },
                  ]
                : [],
            );
          }
        }
      }
      return done();
    },
  };
}

// ----------------------------------------------------------------- the loaders

export interface HeliusAssets {
  getAssets(mints: readonly string[]): Promise<AssetInfo[]>;
}
export interface JupiterPrices {
  getTokens(mints: readonly string[]): Promise<JupiterToken[]>;
}

export interface MetadataLoadersOptions {
  db: Kysely<Database>;
  helius: HeliusAssets;
  jupiter: JupiterPrices;
  /** Restrict prefetching to these addresses (the run's coins). Default: any coin that needs metadata. */
  addresses?: readonly string[];
  /** Helius batch size. Default 1,000, its maximum. */
  assetBatch?: number;
  /** Jupiter batch size. Default 100, its maximum. */
  priceBatch?: number;
  errorCooldownMs?: number;
  /** Failed coins that used this many attempts are not prefetched. Default 3. */
  maxAttempts?: number;
  /** The stage a coin needs done before its metadata is fetched. Default `discovered`. */
  requires?: StageName;
  /** Prefetch only coins with an ATH at or above this (the backfill's listed coins). */
  minAthMarketCapUsd?: number;
  /**
   * Prefetch only these coins, asked for when a batch is built: the coins the worker takes next
   * (the head of the stage's queue, `PipelineWorker.queuedCoinIds`), the first `limit` of them.
   * Without it, any coin that needs metadata (in id order) is a candidate.
   */
  candidateIds?: (limit: number) => readonly number[] | Promise<readonly number[]>;
}

const notFoundAsset = (mint: string): AssetInfo => ({
  mint,
  found: false,
  name: null,
  symbol: null,
  uri: null,
  description: null,
  image: null,
  layout: null,
  tokenProgram: null,
  tokenProgramId: null,
  decimals: null,
  supply: null,
  assetInterface: null,
  invalid: null,
});

const notFoundToken = (mint: string): JupiterToken => ({
  mint,
  found: false,
  priceUsd: null,
  liquidityUsd: null,
  volume24hUsd: null,
  holderCount: null,
  marketCapUsd: null,
  fdvUsd: null,
  circulatingSupply: null,
  totalSupply: null,
  isVerified: null,
  updatedAt: null,
  website: null,
  twitter: null,
  telegram: null,
  invalid: null,
});

/**
 * Loaders that batch across coins. A miss for one coin fetches it together
 * with the next coins (in id order) whose metadata is still to do.
 */
export function createMetadataLoaders(o: MetadataLoadersOptions) {
  const candidates = async (_first: string, limit: number): Promise<string[]> => {
    const ids = await o.candidateIds?.(limit);
    const rows = await listCoinsNotDone(o.db, 'metadata', {
      version: METADATA_STAGE_VERSION,
      requires: o.requires ?? 'discovered',
      ...(o.addresses ? { addresses: o.addresses } : {}),
      ...(o.minAthMarketCapUsd !== undefined ? { minAthMarketCapUsd: o.minAthMarketCapUsd } : {}),
      ...(ids ? { ids } : {}),
      maxAttempts: o.maxAttempts ?? 3,
      limit,
    });
    // The query answers in id order; the loader takes the first of what it is given, so the
    // coins named by `candidateIds` keep the order they were named in (the order the worker takes them).
    if (ids) {
      const rank = new Map(ids.map((id, i) => [id, i]));
      rows.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
    }
    return rows.map((r) => r.address);
  };
  const cooldown = o.errorCooldownMs === undefined ? {} : { errorCooldownMs: o.errorCooldownMs };
  const assets = new PrefetchLoader<AssetInfo>({
    maxBatch: o.assetBatch ?? 1000,
    candidates,
    missing: notFoundAsset,
    fetch: async (mints) => new Map((await o.helius.getAssets(mints)).map((a) => [a.mint, a])),
    ...cooldown,
  });
  const prices = new PrefetchLoader<JupiterToken>({
    maxBatch: o.priceBatch ?? 100,
    candidates,
    missing: notFoundToken,
    fetch: async (mints) => new Map((await o.jupiter.getTokens(mints)).map((t) => [t.mint, t])),
    ...cooldown,
  });
  return { assets, prices };
}
