/**
 * Jupiter Tokens API v2: current price and market data for a set of mints.
 *
 * Endpoint (https://developers.jup.ag/docs/tokens, read 2026-11-15):
 * `GET https://api.jup.ag/tokens/v2/search?query=<mint>,<mint>,...`, up to 100
 * mints per request. It answers with an array holding only the tokens it
 * knows. No key is needed to try it, at 0.5 requests a second; a key
 * (`JUPITER_API_KEY`, sent as `x-api-key`) raises the limit to 1 request a
 * second on the free plan and more on paid plans.
 *
 * LAUNCH TIMES ARE NOT EXPOSED. Jupiter's `createdAt` repeats across unrelated
 * 2024 tokens and is wrong for them (see the review of #15). Its `firstPool`
 * and `graduatedAt` are launch-time fields as well, and `dev` names a creator.
 * None of them is read, so none can appear in the typed result. The response
 * schema below lists only the fields we use, and zod drops the rest.
 *
 * Market cap is not computed here. `marketCapUsd` and the supply figures are
 * Jupiter's own, as given; the project's own rule (price times the fixed 1
 * billion supply) is applied downstream.
 *
 * Supply figures are in whole tokens (decimals already applied), unlike
 * Helius's raw-unit supply.
 */
import { z } from 'zod';
import { getBytes, type GetBytesOptions, type GetFetchLike } from '../http.js';
import { RateLimiter } from '../ratelimit.js';

export const JUPITER_PROVIDER = 'jupiter';
export const JUPITER_BASE_URL = 'https://api.jup.ag';
export const JUPITER_MAX_MINTS_PER_REQUEST = 100;
/** One request carries up to 100 tokens at about 1.4 KB each. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

const num = z.number().nullish();

/** Only the fields we read. Anything else in the response is dropped by the parser. */
const tokenSchema = z.object({
  id: z.string(),
  usdPrice: num,
  liquidity: num,
  holderCount: num,
  mcap: num,
  fdv: num,
  circSupply: num,
  totalSupply: num,
  isVerified: z.boolean().nullish(),
  stats24h: z
    .object({
      buyVolume: num,
      sellVolume: num,
    })
    .nullish(),
  updatedAt: z.string().nullish(),
});

const responseSchema = z.array(tokenSchema);

export interface JupiterToken {
  mint: string;
  /** False when Jupiter does not know the mint. Not an error. */
  found: boolean;
  priceUsd: number | null;
  liquidityUsd: number | null;
  /** Buy volume plus sell volume over 24 hours, in USD. Null unless both are given. */
  volume24hUsd: number | null;
  holderCount: number | null;
  /** Jupiter's own market cap figure, as given. */
  marketCapUsd: number | null;
  /** Jupiter's own fully diluted valuation, as given. */
  fdvUsd: number | null;
  /** Whole tokens. */
  circulatingSupply: number | null;
  /** Whole tokens. */
  totalSupply: number | null;
  isVerified: boolean | null;
  /** When Jupiter last updated the entry (ISO 8601). Not a launch time. */
  updatedAt: string | null;
}

export class JupiterResponseError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Unexpected Jupiter response: ${issues.slice(0, 5).join('; ')}`);
    this.name = 'JupiterResponseError';
    this.issues = issues;
  }
}

export interface JupiterClientOptions {
  /** `JUPITER_API_KEY`. Optional: the API answers without one at a lower rate limit. */
  apiKey?: string;
  baseUrl?: string;
  fetch?: GetFetchLike;
  /** Default: 0.5 requests a second without a key, 1 with one. */
  limiter?: RateLimiter;
  /** Overrides for timeout, retries, backoff, sleep and jitter. */
  http?: Omit<GetBytesOptions, 'fetch' | 'headers' | 'maxBytes'>;
}

const notFound = (mint: string): JupiterToken => ({
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
});

export class JupiterClient {
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: GetFetchLike | undefined;
  private readonly limiter: RateLimiter;
  private readonly httpOptions: Omit<GetBytesOptions, 'fetch' | 'headers' | 'maxBytes'>;
  private requests = 0;

  constructor(opts: JupiterClientOptions = {}) {
    this.apiKey = opts.apiKey === '' ? undefined : opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? JUPITER_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = opts.fetch;
    this.limiter =
      opts.limiter ?? new RateLimiter({ maxPerSecond: this.apiKey ? 1 : 0.5, burst: 1 });
    this.httpOptions = opts.http ?? {};
  }

  /** HTTP requests made so far, retries included. */
  requestCount(): number {
    return this.requests;
  }

  /**
   * Price and market data for each mint, in input order (duplicates removed).
   * Requests are split at 100 mints. A mint Jupiter does not return is
   * `found: false`. A mint with no price (a dead pool) is `found: true` with
   * `priceUsd: null`.
   */
  async getTokens(mints: readonly string[]): Promise<JupiterToken[]> {
    const unique = [...new Set(mints)];
    const out: JupiterToken[] = [];
    for (let i = 0; i < unique.length; i += JUPITER_MAX_MINTS_PER_REQUEST) {
      const batch = unique.slice(i, i + JUPITER_MAX_MINTS_PER_REQUEST);
      const rows = await this.fetchBatch(batch);
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const mint of batch) {
        const r = byId.get(mint);
        if (!r) {
          out.push(notFound(mint));
          continue;
        }
        const buy = r.stats24h?.buyVolume;
        const sell = r.stats24h?.sellVolume;
        out.push({
          mint,
          found: true,
          priceUsd: r.usdPrice ?? null,
          liquidityUsd: r.liquidity ?? null,
          volume24hUsd: typeof buy === 'number' && typeof sell === 'number' ? buy + sell : null,
          holderCount: r.holderCount ?? null,
          marketCapUsd: r.mcap ?? null,
          fdvUsd: r.fdv ?? null,
          circulatingSupply: r.circSupply ?? null,
          totalSupply: r.totalSupply ?? null,
          isVerified: r.isVerified ?? null,
          updatedAt: r.updatedAt ?? null,
        });
      }
    }
    return out;
  }

  private async fetchBatch(batch: readonly string[]): Promise<z.infer<typeof responseSchema>> {
    const base: GetFetchLike = this.fetchImpl ?? ((url, init) => fetch(url, init));
    const limited: GetFetchLike = (url, init) =>
      this.limiter.run(() => {
        this.requests++;
        return base(url, init);
      });
    const headers: Record<string, string> = {
      accept: 'application/json',
      'user-agent': 'ingest-client/0.1',
    };
    if (this.apiKey) headers['x-api-key'] = this.apiKey;

    const url = `${this.baseUrl}/tokens/v2/search?query=${batch.map(encodeURIComponent).join(',')}`;
    const res = await getBytes(url, {
      ...this.httpOptions,
      fetch: limited,
      headers,
      maxBytes: MAX_RESPONSE_BYTES,
    });

    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(res.body));
    } catch {
      throw new JupiterResponseError(['response was not JSON']);
    }
    const parsed = responseSchema.safeParse(json);
    if (!parsed.success) {
      throw new JupiterResponseError(
        parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
      );
    }
    return parsed.data;
  }
}
