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
import {
  getBytes,
  parseRetryAfter,
  type GetBytesOptions,
  type GetFetchLike,
  type GetFetchResponse,
} from '../http.js';
import { RateLimiter } from '../ratelimit.js';

export const JUPITER_PROVIDER = 'jupiter';
export const JUPITER_BASE_URL = 'https://api.jup.ag';
export const JUPITER_MAX_MINTS_PER_REQUEST = 100;
/** Provider name of the pause tally in `provider_usage`: `requests` is pauses, `units` seconds paused. */
export const JUPITER_PAUSE_PROVIDER = 'jupiter_pause';

/**
 * The share of Jupiter's documented rate (0.5 requests a second without a key, 1 with one) the
 * limiter is set to. A run sent about 1,250 requests at exactly the documented rate and met 429
 * after half an hour, so the documented rate is a ceiling, not a safe pace; 0.8 leaves a fifth
 * of room for the requests the provider counts differently from us.
 */
export const JUPITER_RATE_SHARE = 0.8;
/** How long every Jupiter request waits after a 429 that carries no `Retry-After`. */
export const JUPITER_PAUSE_DEFAULT_MS = 60_000;
/** A `Retry-After` is taken at its word up to this long; the pause is capped here. */
export const JUPITER_PAUSE_MAX_MS = 300_000;
/** After this many pauses in a row with no answered request between them, the client gives up. */
export const JUPITER_MAX_PAUSES_IN_A_ROW = 5;

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
  // Links as given (anything else than a string is read as none); cleaned downstream like a file's.
  website: z.unknown().optional(),
  twitter: z.unknown().optional(),
  telegram: z.unknown().optional(),
});

/** Only the array is checked here; each row is checked on its own with `tokenSchema`. */
const responseSchema = z.array(z.unknown());

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
  /**
   * Links from the token's page, as Jupiter gives them: not cleaned, and possibly edited since
   * launch. Null when absent or not a string.
   */
  website: string | null;
  twitter: string | null;
  telegram: string | null;
  /**
   * Null for a good row. When Jupiter returned a row for this mint that did not match the
   * expected shape, `found` is true, every other field is null, and this lists the issues.
   */
  invalid: string[] | null;
}

export class JupiterRedirectError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Jupiter answered with a redirect (HTTP ${status}); redirects are not followed`);
    this.name = 'JupiterRedirectError';
    this.status = status;
  }
}

/**
 * Jupiter answered 429 `JUPITER_MAX_PAUSES_IN_A_ROW` times in a row, each time after a full
 * pause. Not a fault of any coin: the caller stops its pass or run, leaves its coins pending and
 * spends none of their attempts. Never retried by the HTTP helper (`retryable` is false).
 */
export class JupiterRateLimitedError extends Error {
  readonly retryable = false;
  readonly pauses: number;
  readonly secondsPaused: number;

  constructor(pauses: number, secondsPaused: number) {
    super(
      `Jupiter kept answering HTTP 429: ${pauses} pauses in a row, ${Math.round(secondsPaused)} seconds paused; ` +
        'stopping. Try again later, or set JUPITER_API_KEY for a higher rate.',
    );
    this.name = 'JupiterRateLimitedError';
    this.pauses = pauses;
    this.secondsPaused = secondsPaused;
  }
}

/** Thrown by an attempt that started (or found) a pause: not retried by the helper, the client waits and tries again. */
class PauseStarted extends Error {
  readonly retryable = false;

  constructor() {
    super('Jupiter asked for a pause');
    this.name = 'PauseStarted';
  }
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
  /** Milliseconds, monotonic. Default `performance.now()`. For the pause; give the limiter the same clock. */
  now?: () => number;
  /** Default: a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Overrides for timeout, retries, backoff, sleep and jitter. */
  http?: Omit<GetBytesOptions, 'fetch' | 'headers' | 'maxBytes'>;
}

const issueList = (error: z.ZodError): string[] =>
  error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);

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
  website: null,
  twitter: null,
  telegram: null,
  invalid: null,
});

export class JupiterClient {
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: GetFetchLike | undefined;
  private readonly limiter: RateLimiter;
  private readonly httpOptions: Omit<GetBytesOptions, 'fetch' | 'headers' | 'maxBytes'>;
  private requests = 0;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** No request starts before this time (client clock): set by a 429, shared by every caller. */
  private pausedUntil = 0;
  private pausesInARow = 0;
  private pauses = 0;
  private msPaused = 0;

  constructor(opts: JupiterClientOptions = {}) {
    this.apiKey = opts.apiKey === '' ? undefined : opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? JUPITER_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = opts.fetch;
    this.limiter =
      opts.limiter ??
      new RateLimiter({
        maxPerSecond: (this.apiKey ? 1 : 0.5) * JUPITER_RATE_SHARE,
        burst: 1,
        ...(opts.now ? { now: opts.now } : {}),
        ...(opts.sleep ? { sleep: opts.sleep } : {}),
      });
    this.now = opts.now ?? (() => performance.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.httpOptions = opts.http ?? {};
  }

  /** HTTP requests made so far, retries included. */
  requestCount(): number {
    return this.requests;
  }

  /** Pauses so far (each 429 that started or extended a pause) and the seconds spent paused. */
  pauseStats(): { pauses: number; secondsPaused: number } {
    return { pauses: this.pauses, secondsPaused: this.msPaused / 1000 };
  }

  /** Milliseconds until requests may go out again; 0 when not paused. For a caller that would rather end its pass than wait. */
  pausedForMs(): number {
    return Math.max(0, Math.ceil(this.pausedUntil - this.now()));
  }

  /**
   * Price and market data for each mint, in input order (duplicates removed).
   * Requests are split at 100 mints. A mint Jupiter does not return is
   * `found: false`. A row that comes back but does not match the expected shape is
   * `found: true` with every other field null and `invalid` listing the issues; a row
   * without a string `id` cannot be matched, so its mint is `found: false`. Only a
   * response that is not an array at all throws. A mint with no price (a dead pool) is `found: true` with
   * `priceUsd: null`.
   */
  async getTokens(mints: readonly string[]): Promise<JupiterToken[]> {
    const unique = [...new Set(mints)];
    const out: JupiterToken[] = [];
    for (let i = 0; i < unique.length; i += JUPITER_MAX_MINTS_PER_REQUEST) {
      const batch = unique.slice(i, i + JUPITER_MAX_MINTS_PER_REQUEST);
      const rows = await this.fetchBatch(batch);
      const byId = new Map<string, z.infer<typeof tokenSchema>>();
      const badById = new Map<string, string[]>();
      for (const row of rows) {
        const id = (row as { id?: unknown } | null)?.id;
        if (typeof id !== 'string') continue;
        const parsed = tokenSchema.safeParse(row);
        if (parsed.success) byId.set(id, parsed.data);
        else badById.set(id, issueList(parsed.error));
      }
      for (const mint of batch) {
        const r = byId.get(mint);
        if (!r) {
          const bad = badById.get(mint);
          out.push(bad ? { ...notFound(mint), found: true, invalid: bad } : notFound(mint));
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
          website: typeof r.website === 'string' ? r.website : null,
          twitter: typeof r.twitter === 'string' ? r.twitter : null,
          telegram: typeof r.telegram === 'string' ? r.telegram : null,
          invalid: null,
        });
      }
    }
    return out;
  }

  private startPause(retryAfterMs: number | null): void {
    const t = this.now();
    const ms = Math.min(
      JUPITER_PAUSE_MAX_MS,
      Math.max(1_000, retryAfterMs ?? JUPITER_PAUSE_DEFAULT_MS),
    );
    const wasPaused = this.pausedUntil > t;
    const until = Math.max(this.pausedUntil, t + ms);
    // Several requests already in flight can all meet the same 429: that is one pause.
    this.msPaused += until - Math.max(t, this.pausedUntil);
    this.pausedUntil = until;
    if (!wasPaused) {
      this.pauses++;
      this.pausesInARow++;
      if (this.pausesInARow >= JUPITER_MAX_PAUSES_IN_A_ROW) {
        throw new JupiterRateLimitedError(this.pausesInARow, this.msPaused / 1000);
      }
    }
  }

  private async fetchBatch(batch: readonly string[]): Promise<z.infer<typeof responseSchema>> {
    const base: GetFetchLike = this.fetchImpl ?? ((url, init) => fetch(url, init));
    // The pause lives here, not in the HTTP helper, and it is never slept inside one of the helper's
    // attempts (the helper puts a real timer and an abort signal on each). An attempt that meets a
    // 429, or finds the client paused after the limiter, starts the pause and leaves through
    // `PauseStarted`, which the helper does not retry; the loop below waits and calls the helper
    // again, so the resend gets a fresh attempt. The helper's own five tries stay for 5xx and
    // network errors.
    const attempt: GetFetchLike = async (url, init) => {
      // A request that waited for the limiter while another met a 429 is not sent into the pause.
      const res: GetFetchResponse | null = await this.limiter.run(async () => {
        if (this.pausedForMs() > 0) return null;
        this.requests++;
        return base(url, init);
      });
      if (res === null) throw new PauseStarted();
      if (res.status < 400) this.pausesInARow = 0;
      if (res.status === 429) {
        await res.body?.cancel().catch(() => undefined);
        this.startPause(parseRetryAfter(res.headers.get('retry-after')));
        throw new PauseStarted();
      }
      return res;
    };
    const headers: Record<string, string> = {
      accept: 'application/json',
      'user-agent': 'ingest-client/0.1',
    };
    if (this.apiKey) headers['x-api-key'] = this.apiKey;

    const url = `${this.baseUrl}/tokens/v2/search?query=${batch.map(encodeURIComponent).join(',')}`;
    let res: Awaited<ReturnType<typeof getBytes>>;
    for (;;) {
      for (let wait = this.pausedForMs(); wait > 0; wait = this.pausedForMs()) {
        await this.sleep(wait);
      }
      try {
        res = await getBytes(url, {
          ...this.httpOptions,
          fetch: attempt,
          headers,
          maxBytes: MAX_RESPONSE_BYTES,
        });
        break;
      } catch (err) {
        if (!(err instanceof PauseStarted)) throw err;
      }
    }

    if (res.status >= 300) throw new JupiterRedirectError(res.status);

    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(res.body));
    } catch {
      throw new JupiterResponseError(['response was not JSON']);
    }
    const parsed = responseSchema.safeParse(json);
    if (!parsed.success) throw new JupiterResponseError(issueList(parsed.error));
    return parsed.data;
  }
}

/** The pause tally as a usage entry (`requests` pauses, `units` whole seconds), or nothing before any pause. */
export function jupiterPauseUsage(
  client: Pick<JupiterClient, 'pauseStats'>,
): Record<string, { requests: number; units: number }> {
  const { pauses, secondsPaused } = client.pauseStats();
  return pauses > 0
    ? { [JUPITER_PAUSE_PROVIDER]: { requests: pauses, units: Math.round(secondsPaused) } }
    : {};
}
