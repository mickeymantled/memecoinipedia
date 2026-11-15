/**
 * The `metadata` stage: what a coin is called and what its creator said about it.
 *
 * For one coin it
 *   1. takes the on-chain asset from Helius `getAssetBatch` (one request per
 *      1,000 coins, through a prefetching loader, not one per coin),
 *   2. fetches the metadata JSON at the on-chain URI with `fetchTokenMetadata`,
 *   3. takes the current price from Jupiter (100 coins per request),
 *   4. stores ticker, name, token program id, metadata URI, description,
 *      socials, the raw metadata JSON and the image reference.
 *
 * It fetches no image. The image reference has no gateway host (see image.ts).
 *
 * Outcomes of the metadata fetch:
 *   ok                                  stored.
 *   not_found, invalid, too_large,
 *   unsupported_uri                     the stage is `done`; the reason is a data issue
 *                                       (`metadata_<outcome>`), and the coin keeps its on-chain fields.
 *   unreachable                         the stage `failed`, retryable.
 * Beyond the issue: Helius knowing no asset for the mint (`asset_not_found`), a
 * row of the wrong shape (`asset_invalid`) or an asset with no URI
 * (`metadata_no_uri`) are also `done` with a data issue, because a retry
 * cannot change them.
 *
 * Socials. A link is kept only when it is a full http(s) URL without
 * credentials (the rule in `normalizeSocialUrl`). A handle or a bare domain
 * is dropped, and each drop is recorded in the `social_links_dropped` issue so
 * the count can be read back from the database.
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
} from '@memecoinipedia/db';
import type { Kysely } from 'kysely';
import { BudgetExceededError } from '../../sources/budget.js';
import type { AssetInfo } from '../../sources/helius/client.js';
import type { JupiterToken } from '../../sources/jupiter/client.js';
import type { MetadataResult } from '../../sources/metadata/fetch.js';
import { PrefetchLoader } from '../batch.js';
import { done, failed, type Stage, type StageContext, type StageCoin } from '../stage.js';
import type { UsageMeter } from '../usage.js';
import { imageReference } from './image.js';

export const METADATA_STAGE_VERSION = 1;
export const SOCIAL_FIELDS = ['twitter', 'telegram', 'website'] as const;

/** Issue kinds this stage owns: it replaces them on every run. */
export const METADATA_ISSUE_KINDS = [
  'asset_not_found',
  'asset_invalid',
  'metadata_no_uri',
  'metadata_not_found',
  'metadata_invalid',
  'metadata_too_large',
  'metadata_unsupported_uri',
  'social_links_dropped',
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
  fetchMetadata(uri: string): Promise<MetadataResult>;
  usage?: UsageMeter;
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const errorText = (err: unknown): string =>
  clip(err instanceof Error ? err.message : String(err), 300);
const blankToNull = (s: string | null): string | null => (s === null || s.trim() === '' ? null : s);

export interface DroppedLink {
  field: string;
  value: string;
}

/** Social fields the JSON gave a value for that `normalizeSocialUrl` refused. */
export function droppedSocialLinks(
  raw: Record<string, unknown>,
  kept: Record<(typeof SOCIAL_FIELDS)[number], string | null>,
): DroppedLink[] {
  const out: DroppedLink[] = [];
  for (const field of SOCIAL_FIELDS) {
    const v = raw[field];
    const present = v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '');
    if (present && kept[field] === null) {
      out.push({ field, value: clip(typeof v === 'string' ? v : JSON.stringify(v), 200) });
    }
  }
  return out;
}

export function createMetadataStage(deps: MetadataStageDeps): Stage {
  return {
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
      const ticker = usable ? blankToNull(asset.symbol) : null;
      const name = usable ? blankToNull(asset.name) : null;
      const uri = usable ? blankToNull(asset.uri) : null;
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
      }

      // 2. Metadata JSON.
      let result: MetadataResult | null = null;
      if (uri !== null) {
        try {
          result = await deps.fetchMetadata(uri);
        } catch (err) {
          return failed(`metadata_error: ${errorText(err)}`, true);
        }
        deps.usage?.add(
          'metadata-fetch',
          result.attempts.reduce((n, a) => n + a.requests, 0),
        );
        if (result.outcome === 'unreachable') {
          const why = result.attempts.map((a) => `${a.gateway} ${a.result}`).join(', ');
          return failed(`metadata_unreachable: ${clip(why, 300)}`, true);
        }
        if (result.outcome !== 'ok') {
          issues.push({
            kind: `metadata_${result.outcome}`,
            detail: {
              uri: clip(uri, 300),
              gateway: result.gateway,
              reason: result.detail,
              attempts: result.attempts.map((a) => ({
                gateway: a.gateway,
                result: a.result,
                status: a.status,
              })),
            },
          });
        }
      }

      // 3. Current price.
      let price: JupiterToken;
      try {
        price = await deps.prices.get(coin.address);
      } catch (err) {
        if (err instanceof BudgetExceededError) throw err;
        return failed(`price_error: ${errorText(err)}`, true);
      }
      if (price.invalid) {
        issues.push({
          kind: 'price_invalid',
          detail: { source: 'jupiter', problems: price.invalid },
        });
      }

      // 4. Store.
      const meta = result?.outcome === 'ok' ? result.metadata : null;
      const raw = result?.outcome === 'ok' ? result.raw : null;
      const socials: Record<string, string> = {};
      if (meta) {
        for (const f of SOCIAL_FIELDS) {
          const v = meta[f];
          if (v !== null) socials[f] = v;
        }
        const dropped = droppedSocialLinks(raw ?? {}, meta);
        if (dropped.length > 0)
          issues.push({ kind: 'social_links_dropped', detail: { links: dropped } });
      }

      const set: Record<string, unknown> = { updated_at: ctx.now() };
      if (meta) {
        if (ticker === null && meta.symbol !== null) set['ticker'] = blankToNull(meta.symbol);
        if (name === null && meta.name !== null) set['name'] = blankToNull(meta.name);
        set['description'] = blankToNull(meta.description);
        set['image_url'] = imageReference(meta.image);
        set['socials'] = JSON.stringify(socials);
        set['metadata_raw'] = JSON.stringify(raw);
      }
      if (price.found && !price.invalid) {
        const supply = Number(coin.total_supply);
        set['current_price_usd'] = price.priceUsd;
        set['current_liquidity_usd'] = price.liquidityUsd;
        set['current_volume_24h_usd'] = price.volume24hUsd;
        set['current_market_cap_usd'] =
          price.priceUsd !== null && Number.isFinite(supply) ? price.priceUsd * supply : null;
        set['current_refreshed_at'] = ctx.now();
      }
      await ctx.db
        .updateTable('coins')
        .set(set as never)
        .where('id', '=', coin.id)
        .execute();
      await replaceCoinIssues(ctx.db, coin.id, METADATA_ISSUE_KINDS, issues);
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
}

const notFoundAsset = (mint: string): AssetInfo => ({
  mint,
  found: false,
  name: null,
  symbol: null,
  uri: null,
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
  invalid: null,
});

/**
 * Loaders that batch across coins. A miss for one coin fetches it together
 * with the next coins (in id order) whose metadata is still to do.
 */
export function createMetadataLoaders(o: MetadataLoadersOptions) {
  const candidates = async (_first: string, limit: number): Promise<string[]> => {
    const rows = await listCoinsNotDone(o.db, 'metadata', {
      version: METADATA_STAGE_VERSION,
      requires: 'discovered',
      ...(o.addresses ? { addresses: o.addresses } : {}),
      maxAttempts: o.maxAttempts ?? 3,
      limit,
    });
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
