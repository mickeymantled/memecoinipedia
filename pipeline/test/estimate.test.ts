import { describe, expect, it } from 'vitest';
import { estimatePass, usdForUsage } from '../src/classify/estimate.js';
import {
  formatDryRun,
  planRun,
  estimatedCalibration,
  exactCalibration,
} from '../src/classify/plan.js';
import { pricingFor, ratesFor } from '../src/classify/pricing.js';
import { syntheticItems } from '../src/classify/synthetic.js';
import { loadPromptBuilder } from '../src/classify/prompt.js';
import { DEFAULT_NARRATIVES } from '../src/classify/schema.js';
import { FakeClient, testBuilder, testConfig } from './helpers.js';

const HAIKU = 'claude-haiku-5-5';
const SONNET = 'claude-sonnet-5-5';
const near = (a: number, b: number) => expect(a).toBeCloseTo(b, 9);

describe('dry-run arithmetic', () => {
  // 1,000 requests, 4,000-token system prompt, 400-token records, 200 output tokens.
  const input = {
    requests: 1000,
    systemTokens: 4000,
    recordTokensTotal: 400_000,
    outputTokensPerRequest: 200,
  };

  it('Haiku with 1h cache, 90% hit rate, batch discount', () => {
    const e = estimatePass(input, { model: HAIKU, ttl: '1h', cacheHitRate: 0.9 });
    expect(e.cacheable).toBe(true);
    expect(e.tokens.uncachedInput).toBe(400_000);
    expect(e.tokens.cacheWrite).toBeCloseTo(400_000, 4); // 1000 * 0.1 * 4000
    expect(e.tokens.cacheRead).toBeCloseTo(3_600_000, 4); // 1000 * 0.9 * 4000
    expect(e.tokens.output).toBe(200_000);
    // (400k*0.10 + 400k*0.20 + 3.6M*0.01 + 200k*0.50) / 1e6 = 0.04 + 0.08 + 0.036 + 0.10 = 0.256; half of that.
    near(e.usd.expected, 0.128);
    // No hits: 4M written at 0.20 = 0.8, plus 0.04 and 0.10 = 0.94; half.
    near(e.usd.noCacheHits, 0.47);
    // Caching off: 4.4M at 0.10 = 0.44, plus 0.10 = 0.54; half.
    near(e.usd.noCaching, 0.27);
  });

  it('uses the 5-minute write price when the TTL is 5m', () => {
    const e = estimatePass(input, { model: HAIKU, ttl: '5m', cacheHitRate: 0 });
    // 4M written at 0.125 = 0.5, plus 0.04 + 0.10 = 0.64; half.
    near(e.usd.expected, 0.32);
  });

  it('Sonnet 5.5 prices', () => {
    const e = estimatePass(input, { model: SONNET, ttl: '1h', cacheHitRate: 0.9 });
    // 400k*2 + 400k*4 + 3.6M*0.10 + 200k*10 = 0.8 + 1.6 + 0.36 + 2.0 = 4.76; half.
    near(e.usd.expected, 2.38);
  });

  it('a system prompt under the cache minimum is not cached: all input is uncached, no write premium', () => {
    const short = { ...input, systemTokens: 511 };
    const e = estimatePass(short, { model: HAIKU, ttl: '1h', cacheHitRate: 0.9 });
    expect(e.cacheable).toBe(false);
    expect(e.minCacheableTokens).toBe(512);
    expect(e.tokens).toEqual({
      uncachedInput: 511_000 + 400_000,
      cacheWrite: 0,
      cacheRead: 0,
      output: 200_000,
    });
    // (911k*0.10 + 200k*0.50) / 1e6 = 0.0911 + 0.1 = 0.1911; half.
    near(e.usd.expected, 0.09555);
    near(e.usd.noCacheHits, e.usd.expected);
    near(e.usd.noCacheHits, e.usd.noCaching);
    // At exactly the minimum it caches.
    expect(
      estimatePass({ ...input, systemTokens: 512 }, { model: HAIKU, ttl: '1h', cacheHitRate: 0.9 })
        .cacheable,
    ).toBe(true);
  });

  it('Haiku moves to the long-prompt rate card above 100,000 tokens per request', () => {
    const p = pricingFor(HAIKU);
    expect(ratesFor(p, 100_000).input).toBe(0.1);
    expect(ratesFor(p, 100_001).input).toBe(0.5);
    const big = estimatePass(
      {
        requests: 10,
        systemTokens: 90_000,
        recordTokensTotal: 10 * 20_000,
        outputTokensPerRequest: 0,
      },
      { model: HAIKU, ttl: '5m', cacheHitRate: 1 },
    );
    // Prompt is 110k per request: reads at 0.05, records at 0.50. (900k*0.05 + 200k*0.50)/1e6 = 0.145; half.
    near(big.usd.expected, 0.0725);
  });

  it('zero requests cost nothing, and an unpriced model is refused', () => {
    const e = estimatePass(
      { ...input, requests: 0, recordTokensTotal: 0 },
      { model: HAIKU, ttl: '1h', cacheHitRate: 0.9 },
    );
    expect(e.usd).toEqual({ expected: 0, noCacheHits: 0, noCaching: 0 });
    expect(() =>
      estimatePass(input, { model: 'claude-nope', ttl: '1h', cacheHitRate: 0.9 }),
    ).toThrow(/No price/);
  });

  it('prices actual usage with the same rates', () => {
    const usd = usdForUsage(
      HAIKU,
      {
        input_tokens: 1000,
        cache_creation_input_tokens: 2000,
        cache_read_input_tokens: 3000,
        output_tokens: 500,
      },
      '1h',
    );
    // (1000*0.10 + 2000*0.20 + 3000*0.01 + 500*0.50)/1e6 = 0.00078; half.
    near(usd, 0.00078 / 2);
  });
});

describe('run plan and report', () => {
  const config = testConfig();
  const builder = testBuilder(config);
  const cal = estimatedCalibration(builder, config);

  it('estimates both passes: the second pass is the eligible coins plus 15% of the first pass', () => {
    const items = syntheticItems(200);
    const est = planRun({ firstItems: items, secondEligibleNow: 10 }, config, cal, true, true);
    expect(est.first.requests).toBe(200);
    expect(est.second.requests).toBe(10 + 30);
    expect(est.first.model).toBe(HAIKU);
    expect(est.second.model).toBe(SONNET);
    near(est.totalUsd.expected, est.first.usd.expected + est.second.usd.expected);
    const only1 = planRun({ firstItems: items, secondEligibleNow: 10 }, config, cal, true, false);
    expect(only1.second.requests).toBe(0);
    const only2 = planRun({ firstItems: items, secondEligibleNow: 10 }, config, cal, false, true);
    expect(only2.first.requests).toBe(0);
    expect(only2.second.requests).toBe(10);
  });

  it('prints tokens, dollars, prices, and the cache warning for a short system prompt', async () => {
    const items = syntheticItems(50);
    const shortCfg = testConfig({ charsPerToken: 1000 }); // makes the prompt look tiny
    const shortCal = estimatedCalibration(builder, shortCfg);
    const est = planRun(
      { firstItems: items, secondEligibleNow: 0 },
      shortCfg,
      shortCal,
      true,
      true,
    );
    const text = formatDryRun(est, {
      config: shortCfg,
      cal: shortCal,
      promptVersion: builder.version,
    });
    expect(text).toContain('DRY RUN');
    expect(text).toContain('WARNING');
    expect(text).toContain('will not be cached');
    expect(text).toContain('--confirm');
    const real = await loadPromptBuilder(config, DEFAULT_NARRATIVES);
    const realCal = estimatedCalibration(real, config);
    const normal = formatDryRun(
      planRun({ firstItems: items, secondEligibleNow: 0 }, config, realCal, true, true),
      { config, cal: realCal, promptVersion: real.version },
    );
    expect(normal).not.toContain('WARNING');
    expect(normal).toContain('cache read');
    expect(normal).toContain('prices used, claude-haiku-5-5');
  });

  it('can take the system prompt size from count_tokens and calibrate the ratio', async () => {
    const client = new FakeClient();
    const exact = await exactCalibration(client, builder, HAIKU);
    expect(client.countTokensCalls).toBe(1);
    expect(exact.systemTokens).toBe(4321);
    expect(exact.charsPerToken).toBeCloseTo(builder.system.length / 4321, 9);
    expect(exact.source).toBe('count_tokens');
  });

  it('synthetic coins are deterministic', () => {
    expect(syntheticItems(5)).toEqual(syntheticItems(5));
    expect(syntheticItems(0)).toEqual([]);
  });
});
