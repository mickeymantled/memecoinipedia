/**
 * The quote tokens a side pool (not the bonding curve, not the graduation pool) may have to be
 * stored, fetched and counted in the metrics: wrapped SOL, USDC and USDT, by mint address.
 * It lives here because /db cannot import from /ingest; the Codex.io client re-exports it.
 */
export const OTHER_POOL_QUOTE = {
  SOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
} as const;
export const OTHER_POOL_QUOTE_MINTS: readonly string[] = Object.values(OTHER_POOL_QUOTE);

const OTHER_POOL_QUOTE_SYMBOLS: readonly string[] = Object.keys(OTHER_POOL_QUOTE);

/**
 * The metric rule for which stored pools count (docs/metrics.md section 1): the bonding curve and
 * the graduation pool (`isPrimary`) always do; a side pool only when its stored `quote_token` is
 * one of the three mint addresses or the symbol `SOL`, `USDC` or `USDT` (exact, case-sensitive,
 * after trimming). A side pool with no quote token does not count. The one place this is decided.
 */
export function poolCountsForMetrics(pool: {
  isPrimary: boolean;
  quoteToken: string | null;
}): boolean {
  if (pool.isPrimary) return true;
  if (pool.quoteToken === null) return false;
  const q = pool.quoteToken.trim();
  return OTHER_POOL_QUOTE_MINTS.includes(q) || OTHER_POOL_QUOTE_SYMBOLS.includes(q);
}
