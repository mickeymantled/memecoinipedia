import type { Usage } from './client.js';
import {
  BATCH_DISCOUNT,
  minCacheableTokens,
  pricingFor,
  ratesFor,
  type ModelPricing,
} from './pricing.js';

/**
 * Cost arithmetic for the dry run, the spend ceiling and the actual-usage tally. Pure functions.
 *
 * Token counts are estimates until the first live run. The estimator turns characters into
 * tokens with `charsPerToken` (default 3, deliberately on the high-token side: the current
 * Claude tokenizer produces roughly 30 percent more tokens than models before Opus 4.7, per the
 * token-counting docs, so 4 characters a token would undercount). `--count-tokens` replaces the
 * system-prompt estimate with the count_tokens endpoint's exact figure and recalibrates the
 * ratio from it.
 *
 * Caching inside a batch is best effort: the batch docs say hit rates "typically" range from 30
 * to 98 percent (https://platform.claude.com/docs/en/build-with-claude/batch-processing,
 * "Using prompt caching with Message Batches"). Each request either reads the cached system
 * prompt or writes it. With hit rate h, a fraction h of requests read and 1 - h write. The
 * expected figure uses h from config; the ceiling figure (used for --max-usd) assumes h = 0,
 * so every request pays the write premium.
 */

export interface EstimateOptions {
  model: string;
  ttl: '5m' | '1h';
  cacheHitRate: number;
  prices?: Record<string, ModelPricing>;
  minCacheable?: Record<string, number>;
}

export interface PassInput {
  requests: number;
  /** Tokens of the system prompt (the cacheable prefix). */
  systemTokens: number;
  /** Tokens of every record in the pass, summed. */
  recordTokensTotal: number;
  /** Output tokens per request. */
  outputTokensPerRequest: number;
}

export interface TokenBreakdown {
  uncachedInput: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

export interface PassEstimate {
  model: string;
  requests: number;
  /** False when the system prompt is shorter than the model's minimum cacheable length. */
  cacheable: boolean;
  minCacheableTokens: number;
  systemTokens: number;
  tokens: TokenBreakdown;
  usd: {
    /** At the configured cache hit rate, batch discount applied. */
    expected: number;
    /** No cache hit at all: every request writes the cache. Used for the spend ceiling. */
    noCacheHits: number;
    /** Caching switched off: every input token at the base input price. */
    noCaching: number;
  };
}

function cost(
  pricing: ModelPricing,
  ttl: '5m' | '1h',
  promptTokensPerRequest: number,
  t: TokenBreakdown,
): number {
  const r = ratesFor(pricing, promptTokensPerRequest);
  const write = ttl === '1h' ? r.cacheWrite1h : r.cacheWrite5m;
  const usd =
    (t.uncachedInput * r.input +
      t.cacheWrite * write +
      t.cacheRead * r.cacheRead +
      t.output * r.output) /
    1_000_000;
  return usd * BATCH_DISCOUNT;
}

export function estimatePass(input: PassInput, opts: EstimateOptions): PassEstimate {
  const pricing = pricingFor(opts.model, opts.prices);
  const min = minCacheableTokens(opts.model, opts.minCacheable);
  const n = input.requests;
  const cacheable = input.systemTokens >= min;
  const output = n * input.outputTokensPerRequest;
  const avgPrompt = n === 0 ? 0 : input.systemTokens + input.recordTokensTotal / n;

  const uncachedAll: TokenBreakdown = {
    uncachedInput: n * input.systemTokens + input.recordTokensTotal,
    cacheWrite: 0,
    cacheRead: 0,
    output,
  };
  const withHits = (h: number): TokenBreakdown =>
    cacheable
      ? {
          uncachedInput: input.recordTokensTotal,
          cacheWrite: n * (1 - h) * input.systemTokens,
          cacheRead: n * h * input.systemTokens,
          output,
        }
      : uncachedAll;

  const h = Math.min(1, Math.max(0, opts.cacheHitRate));
  const expectedTokens = withHits(h);
  return {
    model: opts.model,
    requests: n,
    cacheable,
    minCacheableTokens: min,
    systemTokens: input.systemTokens,
    tokens: expectedTokens,
    usd: {
      expected: cost(pricing, opts.ttl, avgPrompt, expectedTokens),
      noCacheHits: cost(pricing, opts.ttl, avgPrompt, withHits(0)),
      noCaching: cost(pricing, opts.ttl, avgPrompt, uncachedAll),
    },
  };
}

export function tokensFromChars(chars: number, charsPerToken: number): number {
  return Math.ceil(chars / charsPerToken);
}

export interface RunEstimate {
  first: PassEstimate;
  second: PassEstimate;
  totalUsd: { expected: number; noCacheHits: number };
}

export function addPasses(first: PassEstimate, second: PassEstimate): RunEstimate {
  return {
    first,
    second,
    totalUsd: {
      expected: first.usd.expected + second.usd.expected,
      noCacheHits: first.usd.noCacheHits + second.usd.noCacheHits,
    },
  };
}

/** Dollars for the usage one response reports, batch discount applied. */
export function usdForUsage(
  model: string,
  usage: Usage,
  ttl: '5m' | '1h',
  prices?: Record<string, ModelPricing>,
): number {
  const pricing = pricingFor(model, prices);
  const prompt =
    usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens;
  return cost(pricing, ttl, prompt, {
    uncachedInput: usage.input_tokens,
    cacheWrite: usage.cache_creation_input_tokens,
    cacheRead: usage.cache_read_input_tokens,
    output: usage.output_tokens,
  });
}

export interface UsageTotals {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
}

export function emptyUsage(): UsageTotals {
  return {
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
  };
}

export function addUsage(total: UsageTotals, u: Usage): void {
  total.input_tokens += u.input_tokens;
  total.cache_creation_input_tokens += u.cache_creation_input_tokens;
  total.cache_read_input_tokens += u.cache_read_input_tokens;
  total.output_tokens += u.output_tokens;
}
