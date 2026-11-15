/**
 * Prices, in US dollars per million tokens, for the models this pipeline uses by default.
 *
 * Source: https://platform.claude.com/docs/en/about-claude/pricing, "Model pricing" table, read
 * 2026-11-15. Cross-checked with the claude-api skill's model table (same input and output
 * prices) and its prompt-caching notes (cache reads 0.1x for Haiku 5.5 and 0.05x for Sonnet 5.5;
 * cache writes 1.25x for the 5-minute TTL and 2x for the 1-hour TTL).
 *
 *   Haiku 5.5, prompt up to 100,000 tokens: input 0.10, 5m write 0.125, 1h write 0.20, read 0.01, output 0.50
 *   Haiku 5.5, prompt over 100,000 tokens:  input 0.50, 5m write 0.625, 1h write 1.00, read 0.05, output 2.50
 *   Sonnet 5.5:                              input 2.00, 5m write 2.50,  1h write 4.00, read 0.10, output 10.00
 *
 * Haiku 5.5 is priced per request by its prompt length, counting cache reads and writes
 * (same page, "Long context pricing").
 *
 * Batch discount: 50 percent on input and output ("Batch processing" on the same page). The
 * page says the batch discount stacks with the other multipliers ("These multipliers stack with
 * other pricing modifiers, including the Batch API discount"), but it prints no batch price for
 * cache writes and reads. This file therefore applies 0.5 to the cache prices as well. That is
 * an inference from the stacking sentence, not a quoted price; the first live run's usage
 * (stored in ingest_runs.actual) is the check.
 *
 * Prices change. A model that is not listed here has no price and the dry run refuses it until
 * a price is given in config (`ClassifyConfig` consumers pass `prices`).
 */

export interface Rates {
  input: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
}

export interface ModelPricing {
  standard: Rates;
  /** Prompts longer than this many tokens use `long`. */
  longPromptThreshold?: number;
  long?: Rates;
}

export const BATCH_DISCOUNT = 0.5;

export const PRICES: Record<string, ModelPricing> = {
  'claude-haiku-5-5': {
    standard: { input: 0.1, cacheWrite5m: 0.125, cacheWrite1h: 0.2, cacheRead: 0.01, output: 0.5 },
    longPromptThreshold: 100_000,
    long: { input: 0.5, cacheWrite5m: 0.625, cacheWrite1h: 1, cacheRead: 0.05, output: 2.5 },
  },
  'claude-sonnet-5-5': {
    standard: { input: 2, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.1, output: 10 },
  },
};

/**
 * Minimum cacheable prompt length in tokens. Source: prompt-caching docs,
 * https://platform.claude.com/docs/en/build-with-claude/prompt-caching ("Cache limitations"):
 * 512 tokens for Claude Haiku 5.5 and Claude Sonnet 5.5. A shorter prefix is processed without
 * caching and without an error. The claude-api skill (shared/prompt-caching.md) lists the same
 * value but tells readers to confirm it in the docs before relying on it; the docs page was
 * fetched for this table.
 */
export const MIN_CACHEABLE_TOKENS: Record<string, number> = {
  'claude-haiku-5-5': 512,
  'claude-sonnet-5-5': 512,
};

export function pricingFor(
  model: string,
  overrides: Record<string, ModelPricing> = {},
): ModelPricing {
  const p = overrides[model] ?? PRICES[model];
  if (!p) {
    throw new Error(
      `No price is known for model "${model}". Add it to the pricing config before a dry run or a real run.`,
    );
  }
  return p;
}

/** Rates for one request, by prompt length. */
export function ratesFor(pricing: ModelPricing, promptTokens: number): Rates {
  if (
    pricing.long !== undefined &&
    pricing.longPromptThreshold !== undefined &&
    promptTokens > pricing.longPromptThreshold
  ) {
    return pricing.long;
  }
  return pricing.standard;
}

export function minCacheableTokens(model: string, overrides: Record<string, number> = {}): number {
  const n = overrides[model] ?? MIN_CACHEABLE_TOKENS[model];
  if (n === undefined) {
    throw new Error(`No minimum cacheable length is known for model "${model}".`);
  }
  return n;
}
