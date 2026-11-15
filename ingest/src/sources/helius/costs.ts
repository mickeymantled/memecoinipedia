/**
 * Helius credit costs per method. Helius responses do not report their cost,
 * so credits are metered from this table.
 *
 * Source: https://www.helius.dev/docs/billing/credits, read 2026-11-15:
 * - getAssetBatch (DAS): 10 credits per request, whatever the batch size.
 * - getTransactionsForAddress: 10 credits per 100 full transactions returned,
 *   rounded up, 10 at the least; 10 flat for a signatures-only response.
 *   Failed API responses to it are free, says that page.
 * - The page gives no general rule for failed requests to other methods, so
 *   this client charges every failed attempt in full.
 *
 * Plan limits: that page does not say whether getTransactionsForAddress works
 * on the free plan. It does on this project's key (checked live on 2026-11-15).
 */

export type HeliusMethod = 'getAssetBatch' | 'getTransactionsForAddress';

export const HELIUS_PROVIDER = 'helius';

/** DAS batch size limit, from https://www.helius.dev/docs/api-reference/das/getassetbatch. */
export const MAX_ASSETS_PER_REQUEST = 1_000;

export const GET_ASSET_BATCH_CREDITS = 10;

/** Credits for one getTransactionsForAddress request returning up to `limit` full transactions. */
export function transactionsForAddressCredits(limit: number): number {
  return 10 * Math.max(1, Math.ceil(limit / 100));
}
