/**
 * `fetchTokenMetadata`: fetch and parse the JSON at a coin's metadata URI.
 *
 * It returns an outcome and does not throw for a bad coin:
 *
 * - `ok`: a JSON object came back.
 * - `not_found`: every attempt got an answer (404 or 410) and none had it.
 * - `unreachable`: timeouts, 429, 5xx, network errors, or any mix with them.
 * - `invalid`: a gateway answered 200 but the body is not a JSON object.
 * - `too_large`: the body passed the byte cap (256 KB by default). Stops at once.
 * - `unsupported_uri`: not a URI we fetch, or every address was refused.
 *
 * IPFS content is fetched from an ordered list of gateways, each with its own
 * timeout and its own rate limiter. A timeout, 429, 5xx, 404 or any other
 * failure moves on to the next gateway. The gateway in the URI itself is only
 * tried (first) when `tryOriginalHost` is set, and a dead one does not stop the
 * fall-through. Gateways are path gateways: `<base>/ipfs/<cid>[/path]`.
 *
 * Every request goes through the private-address block (see safe-fetch.ts).
 */
import {
  BodyTooLargeError,
  HttpError,
  TooManyRedirectsError,
  getFollowingRedirects,
  type GetFetchLike,
} from '../http.js';
import { RateLimiter } from '../ratelimit.js';
import { parseTokenMetadata, stripNulDeep, type TokenMetadata } from './parse.js';
import {
  BlockedAddressError,
  UnsafeUrlError,
  assertSafeUrl,
  createSafeFetch,
  type Resolver,
} from './safe-fetch.js';
import { parseMetadataUri } from './uri.js';

export type MetadataOutcome =
  'ok' | 'not_found' | 'unreachable' | 'invalid' | 'too_large' | 'unsupported_uri';

export type AttemptResult =
  | 'ok'
  | 'not_found'
  | 'rate_limited'
  | 'server_error'
  | 'timeout'
  | 'network_error'
  | 'bad_status'
  | 'blocked'
  | 'redirect_limit'
  | 'invalid'
  | 'too_large';

export interface MetadataAttempt {
  /** Host of the gateway (or of the URI itself) that was asked. */
  gateway: string;
  result: AttemptResult;
  /** Last HTTP status seen, or null when there was none. */
  status: number | null;
  /** Fetch calls made for this attempt: retries and redirect hops included. */
  requests: number;
}

export interface MetadataResult {
  outcome: MetadataOutcome;
  /** The gateway that answered with the JSON, for `ok`; otherwise the one that caused the outcome, or null. */
  gateway: string | null;
  attempts: MetadataAttempt[];
  /** Parsed fields, for `ok`. */
  metadata: TokenMetadata | null;
  /** The JSON as received, for `ok`. For `coins.metadata_raw`. With NUL removed from every string and key. */
  raw: Record<string, unknown> | null;
  /** Why the URI is unsupported, for `unsupported_uri`. */
  detail: string | null;
}

export interface GatewayConfig {
  /** Base URL without a trailing path, for example `https://ipfs.filebase.io`. */
  url: string;
  /** Per request. Default is the fetcher's `timeoutMs`. */
  timeoutMs?: number;
  /** Rate limit for this gateway. Default is the fetcher's `gatewayMaxPerSecond`. */
  maxPerSecond?: number;
  burst?: number;
}

/**
 * Chosen from what answered on 2026-11-15 (see the pull request for the
 * per-gateway results). `ipfs.io` and `dweb.link` now answer 429 "switching to
 * a service worker gateway only", and `cloudflare-ipfs.com` and `cf-ipfs.com`
 * no longer resolve, so none of those four is listed.
 */
export const DEFAULT_IPFS_GATEWAYS: GatewayConfig[] = [
  { url: 'https://ipfs.filebase.io' },
  { url: 'https://gateway.pinata.cloud' },
];

export const DEFAULT_ARWEAVE_GATEWAYS: GatewayConfig[] = [{ url: 'https://arweave.net' }];

export const DEFAULT_MAX_BYTES = 256 * 1024;

export interface MetadataFetchOptions {
  ipfsGateways?: Array<string | GatewayConfig>;
  arweaveGateways?: Array<string | GatewayConfig>;
  /** Try the host in the URI first when it is a gateway. Default false. */
  tryOriginalHost?: boolean;
  /** Default 262,144. */
  maxBytes?: number;
  /** Default 3. */
  maxRedirects?: number;
  /** Per request, unless a gateway sets its own. Default 10,000 ms. */
  timeoutMs?: number;
  /** Retries per gateway after the first try. Default 0: the next gateway is the retry. */
  maxRetriesPerGateway?: number;
  /** Default 2 requests a second per host. */
  gatewayMaxPerSecond?: number;
  /** Default 'metadata-fetcher/1.0 (+token metadata)'. Generic on purpose. */
  userAgent?: string;
  /** Default: a fetch whose connections go through the private-address block. */
  fetch?: GetFetchLike;
  /** DNS resolver for the default fetch. Tests only. */
  resolver?: Resolver;
  /** For the rate limiters and retry waits. Tests inject a fake clock. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

interface Target {
  /** Key for the rate limiter, and the `gateway` reported. */
  host: string;
  url: string;
  timeoutMs: number;
  maxPerSecond: number;
  burst: number;
}

const toConfig = (g: string | GatewayConfig): GatewayConfig =>
  typeof g === 'string' ? { url: g } : g;

const trimSlash = (s: string): string => s.replace(/\/+$/, '');

export class MetadataFetcher {
  private readonly opts: MetadataFetchOptions;
  private readonly fetchImpl: GetFetchLike;
  private readonly limiters = new Map<string, RateLimiter>();
  private readonly ipfsGateways: GatewayConfig[];
  private readonly arweaveGateways: GatewayConfig[];

  constructor(opts: MetadataFetchOptions = {}) {
    this.opts = opts;
    this.fetchImpl = opts.fetch ?? createSafeFetch(opts.resolver);
    this.ipfsGateways = (opts.ipfsGateways ?? DEFAULT_IPFS_GATEWAYS).map(toConfig);
    this.arweaveGateways = (opts.arweaveGateways ?? DEFAULT_ARWEAVE_GATEWAYS).map(toConfig);
  }

  private limiterFor(t: Target): RateLimiter {
    let l = this.limiters.get(t.host);
    if (!l) {
      l = new RateLimiter({
        maxPerSecond: t.maxPerSecond,
        burst: t.burst,
        ...(this.opts.now ? { now: this.opts.now } : {}),
        ...(this.opts.sleep ? { sleep: this.opts.sleep } : {}),
      });
      this.limiters.set(t.host, l);
    }
    return l;
  }

  private target(base: string, path: string, cfg?: GatewayConfig, exact = false): Target | null {
    let url: URL;
    try {
      url = new URL(exact ? base : trimSlash(base) + path);
    } catch {
      return null;
    }
    const perSecond = cfg?.maxPerSecond ?? this.opts.gatewayMaxPerSecond ?? 2;
    return {
      host: url.host,
      url: url.toString(),
      timeoutMs: cfg?.timeoutMs ?? this.opts.timeoutMs ?? 10_000,
      maxPerSecond: perSecond,
      burst: cfg?.burst ?? Math.max(1, Math.ceil(perSecond)),
    };
  }

  private targetsFor(uri: string): { targets: Target[] } | { unsupported: string } {
    const parsed = parseMetadataUri(uri);
    if (parsed.kind === 'unsupported') return { unsupported: parsed.reason };

    if (parsed.kind === 'http') {
      const t = this.target(parsed.url, '');
      return t ? { targets: [t] } : { unsupported: 'not a valid URL' };
    }

    const list = parsed.kind === 'ipfs' ? this.ipfsGateways : this.arweaveGateways;
    const tail =
      parsed.kind === 'ipfs' ? `/ipfs/${parsed.cid}${parsed.path}` : `/${parsed.id}${parsed.path}`;
    const targets: Target[] = [];
    const seen = new Set<string>();
    const add = (t: Target | null) => {
      if (t && !seen.has(t.host)) {
        seen.add(t.host);
        targets.push(t);
      }
    };
    if (this.opts.tryOriginalHost && parsed.originalUrl !== null) {
      // The URI exactly as written: a subdomain gateway URI is not a path gateway URL.
      add(this.target(parsed.originalUrl, '', undefined, true));
    }
    for (const g of list) add(this.target(g.url, tail, g));
    return { targets };
  }

  private async attempt(
    t: Target,
  ): Promise<{ attempt: MetadataAttempt; json?: Record<string, unknown> }> {
    const o = this.opts;
    let requests = 0;
    const limiter = this.limiterFor(t);
    const counted: GetFetchLike = (url, init) => {
      requests++;
      return limiter.run(() => this.fetchImpl(url, init));
    };
    const done = (result: AttemptResult, status: number | null) => ({
      attempt: { gateway: t.host, result, status, requests } satisfies MetadataAttempt,
    });

    let res;
    try {
      res = await getFollowingRedirects(t.url, {
        fetch: counted,
        headers: {
          accept: 'application/json, */*;q=0.1',
          'user-agent': o.userAgent ?? 'metadata-fetcher/1.0 (+token metadata)',
        },
        maxBytes: o.maxBytes ?? DEFAULT_MAX_BYTES,
        maxRedirects: o.maxRedirects ?? 3,
        checkUrl: assertSafeUrl,
        timeoutMs: t.timeoutMs,
        maxRetries: o.maxRetriesPerGateway ?? 0,
        // Waits on a retry never run long: another gateway is the better retry.
        maxDelayMs: 5_000,
        ...(o.sleep ? { sleep: o.sleep } : {}),
        ...(o.random ? { random: o.random } : {}),
      });
    } catch (err) {
      if (err instanceof BlockedAddressError || err instanceof UnsafeUrlError) {
        return done('blocked', null);
      }
      if (err instanceof BodyTooLargeError) return done('too_large', null);
      if (err instanceof TooManyRedirectsError) return done('redirect_limit', null);
      if (err instanceof HttpError) {
        const s = err.status;
        if (s === 404 || s === 410) return done('not_found', s);
        if (s === 429) return done('rate_limited', s);
        if (s !== null && s >= 500) return done('server_error', s);
        if (s === null) {
          return done(err.message.includes('timed out') ? 'timeout' : 'network_error', null);
        }
        return done('bad_status', s);
      }
      return done('network_error', null);
    }

    if (res.status < 200 || res.status >= 300) return done('bad_status', res.status);

    let parsed: unknown;
    try {
      // TextDecoder drops a leading UTF-8 byte order mark by itself.
      const text = new TextDecoder('utf-8', { fatal: false }).decode(res.body);
      parsed = JSON.parse(text);
    } catch {
      return done('invalid', res.status);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return done('invalid', res.status);
    }
    return { ...done('ok', res.status), json: parsed as Record<string, unknown> };
  }

  async fetch(uri: string): Promise<MetadataResult> {
    const base = {
      attempts: [] as MetadataAttempt[],
      metadata: null,
      raw: null,
      detail: null,
    };
    const planned = this.targetsFor(uri);
    if ('unsupported' in planned) {
      return { ...base, outcome: 'unsupported_uri', gateway: null, detail: planned.unsupported };
    }

    const attempts = base.attempts;
    for (const t of planned.targets) {
      const { attempt, json } = await this.attempt(t);
      attempts.push(attempt);
      if (attempt.result === 'ok' && json) {
        // Postgres rejects NUL in text and jsonb, so keys and values are cleaned first.
        const cleaned = stripNulDeep(json) as Record<string, unknown>;
        return {
          ...base,
          outcome: 'ok',
          gateway: attempt.gateway,
          metadata: parseTokenMetadata(cleaned),
          raw: cleaned,
        };
      }
      // Content is addressed by its hash, so a bigger file is bigger everywhere.
      if (attempt.result === 'too_large') {
        return { ...base, outcome: 'too_large', gateway: attempt.gateway };
      }
    }

    // Nobody had it. Say why, using only the attempts that were not refused.
    const asked = attempts.filter((a) => a.result !== 'blocked');
    if (asked.length === 0) {
      return {
        ...base,
        outcome: 'unsupported_uri',
        gateway: null,
        detail: 'every address was refused by the private-address block',
      };
    }
    const invalid = asked.find((a) => a.result === 'invalid');
    if (invalid) return { ...base, outcome: 'invalid', gateway: invalid.gateway };
    if (asked.every((a) => a.result === 'not_found')) {
      return { ...base, outcome: 'not_found', gateway: null };
    }
    return { ...base, outcome: 'unreachable', gateway: null };
  }
}

let shared: MetadataFetcher | undefined;

/**
 * Fetches with the default gateways. Without `options` it reuses one fetcher,
 * so the per-gateway rate limits hold across calls. With `options` it builds a
 * fresh fetcher; build a `MetadataFetcher` yourself to keep limits across calls.
 */
export function fetchTokenMetadata(
  uri: string,
  options?: MetadataFetchOptions,
): Promise<MetadataResult> {
  if (options) return new MetadataFetcher(options).fetch(uri);
  shared ??= new MetadataFetcher();
  return shared.fetch(uri);
}
