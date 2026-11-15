/**
 * Small HTTP helpers: injectable fetch, timeout, and retry with exponential
 * backoff plus jitter on network errors, HTTP 429 and HTTP 5xx. `Retry-After`
 * is honoured. Other 4xx responses are not retried.
 *
 * `postJson` sends JSON. `getBytes` and `getFollowingRedirects` are the GET
 * side: the same retry rules, plus a byte cap on the body (streamed, and the
 * request is cut off the moment the cap is passed) and, for the second,
 * redirects followed by hand so every hop can be checked.
 *
 * Error messages never contain request headers or query strings (only the
 * host), so an Authorization value cannot leak through a thrown error.
 */

export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface PostJsonOptions {
  fetch?: FetchLike;
  headers?: Record<string, string>;
  /** Per attempt. Default 30,000 ms. */
  timeoutMs?: number;
  /** Retries after the first attempt. Default 4. */
  maxRetries?: number;
  /** First backoff, doubled each retry. Default 500 ms. */
  baseDelayMs?: number;
  /** Cap on any single wait, including `Retry-After`. Default 60,000 ms. */
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Returns a number in [0, 1). Default `Math.random`. */
  random?: () => number;
}

export interface HttpResponse {
  status: number;
  /** Raw body text. */
  body: string;
  /** Number of attempts made, 1 when the first one worked. */
  attempts: number;
}

export class HttpError extends Error {
  readonly status: number | null;
  readonly attempts: number;
  /** A short slice of the response body, for diagnosis. Never headers. */
  readonly bodySnippet: string;

  constructor(message: string, status: number | null, attempts: number, bodySnippet = '') {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.attempts = attempts;
    this.bodySnippet = bodySnippet;
  }
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Seconds as a number, or an HTTP date. Returns milliseconds, or null when unparseable. */
export function parseRetryAfter(value: string | null, nowMs = Date.now()): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return null;
  return Math.max(0, when - nowMs);
}

const isRetryableStatus = (s: number): boolean => s === 429 || (s >= 500 && s <= 599);

type RetryOptions = Pick<
  PostJsonOptions,
  'timeoutMs' | 'maxRetries' | 'baseDelayMs' | 'maxDelayMs' | 'sleep' | 'random'
>;

interface RetryConfig {
  timeoutMs: number;
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
}

function retryConfig(opts: RetryOptions): RetryConfig {
  return {
    timeoutMs: opts.timeoutMs ?? 30_000,
    maxRetries: opts.maxRetries ?? 4,
    baseDelayMs: opts.baseDelayMs ?? 500,
    maxDelayMs: opts.maxDelayMs ?? 60_000,
    sleep: opts.sleep ?? realSleep,
    random: opts.random ?? Math.random,
  };
}

/** What one attempt produced. A thrown error means a network error or a timeout. */
interface AttemptResult<T> {
  status: number;
  retryAfterMs: number | null;
  /** A short slice of the body, for HttpError. */
  snippet: string;
  value: T;
}

/** Thrown inside an attempt to stop the retry loop at once (for example a body over its cap). */
/**
 * The default fetch of `postJson` refuses redirects (a custom header such as an API key
 * would otherwise travel to another origin). It throws this, and the retry loop turns it
 * into an `HttpError` at once, without retrying.
 */
class RedirectRefused extends Error {
  readonly retryable = false;

  constructor() {
    super('redirect refused');
    this.name = 'RedirectRefused';
  }
}

class StopRetrying extends Error {
  readonly original: Error;

  constructor(original: Error) {
    super(original.message);
    this.original = original;
  }
}

/**
 * The shared retry rules: network errors, timeouts, HTTP 429 and HTTP 5xx are
 * retried with exponential backoff plus jitter and `Retry-After`; other 4xx
 * responses are thrown as `HttpError` at once; everything below 400 is returned.
 */
async function withRetries<T>(
  url: string,
  cfg: RetryConfig,
  once: (signal: AbortSignal) => Promise<AttemptResult<T>>,
): Promise<{ value: T; status: number; attempts: number }> {
  const backoff = (retryIndex: number, retryAfterMs: number | null): number => {
    const exp = cfg.baseDelayMs * 2 ** retryIndex;
    // Full jitter on the upper half: between 50% and 100% of the exponential delay.
    const jittered = exp * (0.5 + cfg.random() * 0.5);
    const wanted = retryAfterMs === null ? jittered : Math.max(retryAfterMs, jittered);
    return Math.min(cfg.maxDelayMs, Math.round(wanted));
  };

  let attempt = 0;
  for (;;) {
    attempt++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    let result: AttemptResult<T> | null = null;
    let failure: string | null = null;
    try {
      result = await once(controller.signal);
    } catch (err) {
      if (err instanceof StopRetrying) {
        if (err.original instanceof RedirectRefused) {
          throw new HttpError(
            `Redirect refused from ${new URL(url).host} (redirects are not followed)`,
            null,
            attempt,
          );
        }
        throw err.original;
      }
      const name = err instanceof Error ? err.name : '';
      failure = name === 'AbortError' ? `timed out after ${cfg.timeoutMs} ms` : 'network error';
    } finally {
      clearTimeout(timer);
    }

    if (failure === null && result !== null && !isRetryableStatus(result.status)) {
      if (result.status >= 400) {
        throw new HttpError(
          `HTTP ${result.status} from ${new URL(url).host}`,
          result.status,
          attempt,
          result.snippet,
        );
      }
      return { value: result.value, status: result.status, attempts: attempt };
    }

    if (attempt > cfg.maxRetries) {
      const what = failure ?? `HTTP ${result?.status}`;
      throw new HttpError(
        `${what} from ${new URL(url).host} after ${attempt} attempts`,
        result?.status ?? null,
        attempt,
        result?.snippet ?? '',
      );
    }
    await cfg.sleep(backoff(attempt - 1, result?.retryAfterMs ?? null));
  }
}

/** The fetch used when none is injected. Redirects are refused, not followed. */
const defaultPostFetch: FetchLike = async (input, init) => {
  try {
    return await fetch(input, { ...init, redirect: 'error' });
  } catch (err) {
    const cause = err instanceof Error ? err.cause : undefined;
    if (cause instanceof Error && /redirect/i.test(cause.message)) throw new RedirectRefused();
    throw err;
  }
};

export async function postJson(
  url: string,
  payload: unknown,
  opts: PostJsonOptions = {},
): Promise<HttpResponse> {
  const doFetch: FetchLike = opts.fetch ?? defaultPostFetch;
  const body = JSON.stringify(payload);
  const headers = { 'content-type': 'application/json', ...opts.headers };

  const out = await withRetries(url, retryConfig(opts), async (signal) => {
    let res;
    try {
      res = await doFetch(url, { method: 'POST', headers, body, signal });
    } catch (err) {
      if (err instanceof Error && (err as { retryable?: boolean }).retryable === false) {
        throw new StopRetrying(err);
      }
      throw err;
    }
    const text = await res.text();
    return {
      status: res.status,
      retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
      snippet: text.slice(0, 300),
      value: text,
    };
  });
  return { status: out.status, body: out.value, attempts: out.attempts };
}

// GET with a byte cap --------------------------------------------------

/** The part of a fetch Response that the GET helpers use. `Response` satisfies it. */
export interface GetFetchResponse {
  status: number;
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
}

export type GetFetchLike = (
  input: string,
  init: {
    method: 'GET';
    headers: Record<string, string>;
    signal?: AbortSignal;
    /** Always 'manual': redirects are followed by `getFollowingRedirects`, never by fetch. */
    redirect: 'manual';
  },
) => Promise<GetFetchResponse>;

export interface GetBytesOptions extends RetryOptions {
  fetch?: GetFetchLike;
  headers?: Record<string, string>;
  /** The body is cut off after this many bytes and `BodyTooLargeError` is thrown. */
  maxBytes: number;
}

export interface BytesResponse {
  status: number;
  headers: { get(name: string): string | null };
  /** Empty for redirects, which carry no body of interest. */
  body: Uint8Array;
  attempts: number;
}

export class BodyTooLargeError extends Error {
  readonly maxBytes: number;

  constructor(host: string, maxBytes: number) {
    super(`Response from ${host} is larger than ${maxBytes} bytes`);
    this.name = 'BodyTooLargeError';
    this.maxBytes = maxBytes;
  }
}

async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; exceeded: boolean }> {
  if (body === null) return { bytes: new Uint8Array(0), exceeded: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      // Stop the transfer now instead of draining the rest.
      await reader.cancel().catch(() => undefined);
      return { bytes: new Uint8Array(0), exceeded: true };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return { bytes, exceeded: false };
}

/** One GET with the shared retry rules. Redirects are returned, not followed. */
export async function getBytes(url: string, opts: GetBytesOptions): Promise<BytesResponse> {
  const doFetch: GetFetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  const headers = opts.headers ?? {};
  const host = new URL(url).host;
  const empty = new Uint8Array(0);

  const out = await withRetries(url, retryConfig(opts), async (signal) => {
    let res: GetFetchResponse;
    try {
      res = await doFetch(url, { method: 'GET', headers, signal, redirect: 'manual' });
    } catch (err) {
      // An error that says it is final (a refused address) is not a network error to retry.
      if (err instanceof Error && (err as { retryable?: boolean }).retryable === false) {
        throw new StopRetrying(err);
      }
      throw err;
    }
    const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
    const answer = (snippet: string, bytes: Uint8Array) => ({
      status: res.status,
      retryAfterMs,
      snippet,
      value: { headers: res.headers, bytes },
    });
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined);
      return answer('', empty);
    }
    if (res.status >= 400) {
      const { bytes } = await readCapped(res.body, 300);
      await res.body?.cancel().catch(() => undefined);
      return answer(new TextDecoder().decode(bytes), empty);
    }
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > opts.maxBytes) {
      await res.body?.cancel().catch(() => undefined);
      throw new StopRetrying(new BodyTooLargeError(host, opts.maxBytes));
    }
    const { bytes, exceeded } = await readCapped(res.body, opts.maxBytes);
    if (exceeded) throw new StopRetrying(new BodyTooLargeError(host, opts.maxBytes));
    return answer('', bytes);
  });
  return {
    status: out.status,
    headers: out.value.headers,
    body: out.value.bytes,
    attempts: out.attempts,
  };
}

export class TooManyRedirectsError extends Error {
  readonly maxRedirects: number;

  constructor(maxRedirects: number) {
    super(`More than ${maxRedirects} redirects`);
    this.name = 'TooManyRedirectsError';
    this.maxRedirects = maxRedirects;
  }
}

export interface GetFollowingRedirectsOptions extends GetBytesOptions {
  /** Redirects followed before `TooManyRedirectsError`. Default 3. */
  maxRedirects?: number;
  /**
   * Called with the URL before every request, the first one included. Throw to
   * refuse it. The error propagates to the caller unchanged.
   */
  checkUrl?: (url: URL) => void | Promise<void>;
}

export interface FollowedResponse extends BytesResponse {
  finalUrl: string;
  redirects: number;
  /** Fetch attempts made across all hops, retries included. */
  requests: number;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** `getBytes`, with redirects followed by hand: each hop is checked and counted. */
export async function getFollowingRedirects(
  url: string,
  opts: GetFollowingRedirectsOptions,
): Promise<FollowedResponse> {
  const maxRedirects = opts.maxRedirects ?? 3;
  let current = url;
  let requests = 0;
  for (let redirects = 0; ; redirects++) {
    await opts.checkUrl?.(new URL(current));
    // An error here carries only its own hop's attempts; callers that need an
    // exact count across hops count calls in the fetch they pass in.
    const res = await getBytes(current, opts);
    requests += res.attempts;
    const location = res.headers.get('location');
    if (!REDIRECT_STATUSES.has(res.status) || location === null) {
      return { ...res, finalUrl: current, redirects, requests };
    }
    if (redirects >= maxRedirects) throw new TooManyRedirectsError(maxRedirects);
    current = new URL(location, current).toString();
  }
}
