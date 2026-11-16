import type { ClassifierClient } from './client.js';
import type { ClassifyConfig } from './config.js';
import {
  addPasses,
  estimatePass,
  tokensFromChars,
  type EstimateOptions,
  type PassEstimate,
  type RunEstimate,
} from './estimate.js';
import { buildUserContent } from './input.js';
import type { PromptBuilder } from './prompt.js';
import { PRICES, ratesFor, type ModelPricing } from './pricing.js';
import type { WorkItem } from './store.js';

/**
 * Dry-run planning: token estimates for a list of work items, both passes, and the text report.
 * Nothing here sends a request, except `exactCalibration`, which calls the free count_tokens
 * endpoint when the user asks for it.
 */

export interface Calibration {
  systemTokens: number;
  charsPerToken: number;
  source: 'estimated' | 'count_tokens';
}

export function estimatedCalibration(builder: PromptBuilder, config: ClassifyConfig): Calibration {
  return {
    systemTokens: tokensFromChars(builder.system.length, config.charsPerToken),
    charsPerToken: config.charsPerToken,
    source: 'estimated',
  };
}

/**
 * Counts the system prompt with the count_tokens endpoint (free, separate rate limit) and uses
 * the result for the system prompt and to calibrate chars per token for the records. The count
 * includes a one-word user message, so it is high by a few tokens.
 */
export async function exactCalibration(
  client: ClassifierClient,
  builder: PromptBuilder,
  model: string,
): Promise<Calibration> {
  const total = await client.countTokens({
    model,
    system: builder.systemBlocks(),
    messages: [{ role: 'user', content: 'x' }],
  });
  return {
    systemTokens: total,
    charsPerToken: builder.system.length / total,
    source: 'count_tokens',
  };
}

export function recordTokens(item: WorkItem, cal: Calibration): number {
  return tokensFromChars(buildUserContent(item.coin).length, cal.charsPerToken);
}

export function planPass(
  items: readonly WorkItem[],
  model: string,
  config: ClassifyConfig,
  cal: Calibration,
  prices?: Record<string, ModelPricing>,
): PassEstimate {
  let total = 0;
  for (const it of items) total += recordTokens(it, cal);
  return estimatePass(
    {
      requests: items.length,
      systemTokens: cal.systemTokens,
      recordTokensTotal: total,
      outputTokensPerRequest: config.outputTokensPerCoin,
    },
    estimateOptions(model, config, prices),
  );
}

export function estimateOptions(
  model: string,
  config: ClassifyConfig,
  prices?: Record<string, ModelPricing>,
): EstimateOptions {
  const o: EstimateOptions = { model, ttl: config.cacheTtl, cacheHitRate: config.cacheHitRate };
  if (prices) o.prices = prices;
  return o;
}

export interface DryRunInput {
  /** Coins the first pass would send. */
  firstItems: readonly WorkItem[];
  /** Coins already stored under the current prompt version with confidence under the threshold. */
  secondEligibleNow: number;
}

/**
 * Both passes. The second pass is the coins already eligible plus `secondPassRate` of the coins
 * the first pass will classify (PLAN.md assumes 15 percent). Its records are as long as the
 * first pass's average.
 */
export function planRun(
  input: DryRunInput,
  config: ClassifyConfig,
  cal: Calibration,
  includeFirst: boolean,
  includeSecond: boolean,
  prices?: Record<string, ModelPricing>,
): RunEstimate {
  const first = includeFirst
    ? planPass(input.firstItems, config.firstModel, config, cal, prices)
    : null;
  const firstN = first ? first.requests : 0;
  const avgRecord =
    input.firstItems.length > 0
      ? input.firstItems.reduce((s, it) => s + recordTokens(it, cal), 0) / input.firstItems.length
      : 0;
  const secondN = includeSecond
    ? input.secondEligibleNow + Math.ceil(firstN * config.secondPassRate)
    : 0;
  const second = estimatePass(
    {
      requests: secondN,
      systemTokens: cal.systemTokens,
      recordTokensTotal: avgRecord * secondN,
      outputTokensPerRequest: config.outputTokensPerCoin,
    },
    estimateOptions(config.secondModel, config, prices),
  );
  const firstEst =
    first ??
    estimatePass(
      {
        requests: 0,
        systemTokens: cal.systemTokens,
        recordTokensTotal: 0,
        outputTokensPerRequest: 0,
      },
      estimateOptions(config.firstModel, config, prices),
    );
  return addPasses(firstEst, second);
}

const fmtInt = (n: number): string => Math.round(n).toLocaleString('en-US');
const fmtUsd = (n: number): string => `$${n.toFixed(n < 1 ? 4 : 2)}`;

function passLines(label: string, p: PassEstimate): string[] {
  const lines = [`${label}: ${p.model}, ${fmtInt(p.requests)} coins`];
  if (p.requests === 0) return lines;
  lines.push(
    `  input tokens, uncached:    ${fmtInt(p.tokens.uncachedInput)}`,
    `  input tokens, cache write: ${fmtInt(p.tokens.cacheWrite)}`,
    `  input tokens, cache read:  ${fmtInt(p.tokens.cacheRead)}`,
    `  output tokens:             ${fmtInt(p.tokens.output)}`,
    `  dollars, expected:         ${fmtUsd(p.usd.expected)}`,
    `  dollars, no cache hits:    ${fmtUsd(p.usd.noCacheHits)}  (basis of the --max-usd check)`,
    `  dollars, caching off:      ${fmtUsd(p.usd.noCaching)}`,
  );
  if (!p.cacheable) {
    lines.push(
      `  WARNING: the system prompt is ${fmtInt(p.systemTokens)} tokens, under the ${p.minCacheableTokens}-token ` +
        `minimum for caching on ${p.model}. It will not be cached; all input is counted as uncached.`,
    );
  }
  return lines;
}

export interface ReportContext {
  config: ClassifyConfig;
  cal: Calibration;
  promptVersion: string;
  prices?: Record<string, ModelPricing>;
  openRuns?: number;
  openBatches?: number;
  note?: string;
}

export function formatDryRun(est: RunEstimate, ctx: ReportContext): string {
  const { config, cal } = ctx;
  const out: string[] = ['DRY RUN: nothing was sent and nothing was written.', ''];
  if (ctx.note) out.push(ctx.note, '');
  out.push(
    `prompt version: ${ctx.promptVersion}`,
    `system prompt: ${fmtInt(cal.systemTokens)} tokens (${cal.source === 'count_tokens' ? 'exact, count_tokens' : `estimated at ${config.charsPerToken} chars per token`})`,
    `cache TTL: ${config.cacheTtl}; assumed hit rate ${(config.cacheHitRate * 100).toFixed(0)}%; ` +
      `batch discount 50%`,
    `output tokens assumed per coin: ${config.outputTokensPerCoin}; second pass rate for new coins: ${(config.secondPassRate * 100).toFixed(0)}%`,
    '',
    ...passLines('first pass', est.first),
    '',
    ...passLines('second pass', est.second),
    '',
  );
  for (const e of [est.first, est.second]) {
    if (e.requests === 0) continue;
    const pricing = ctx.prices?.[e.model] ?? PRICES[e.model];
    if (pricing) {
      const r = ratesFor(pricing, e.systemTokens);
      out.push(
        `prices used, ${e.model} (USD per million tokens, before the 50% batch discount): ` +
          `input ${r.input}, cache write ${config.cacheTtl === '1h' ? r.cacheWrite1h : r.cacheWrite5m}, ` +
          `cache read ${r.cacheRead}, output ${r.output}`,
      );
    }
  }
  out.push(
    '',
    `total dollars, expected: ${fmtUsd(est.totalUsd.expected)}`,
    `total dollars, no cache hits: ${fmtUsd(est.totalUsd.noCacheHits)}`,
  );
  if (ctx.openRuns) {
    out.push(
      '',
      `${ctx.openRuns} earlier run(s) with ${ctx.openBatches ?? 0} submitted batch(es) are still open. ` +
        `A real run would resume them first. They are already paid for and not in the totals above.`,
    );
  }
  out.push(
    '',
    'To send for real: add --confirm and --max-usd <dollars>. The run stops submitting when the next batch would pass the ceiling.',
  );
  return out.join('\n');
}
