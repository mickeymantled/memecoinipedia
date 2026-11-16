/**
 * A small POST-JSON helper: injectable fetch, timeout, and retry with
 * exponential backoff plus jitter on network errors, HTTP 429 and HTTP 5xx.
 * `Retry-After` is honoured. Other 4xx responses are not retried.
 *
 * Error messages never contain request headers, so an Authorization value
 * cannot leak through a thrown error.
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

export async function postJson(
  url: string,
  payload: unknown,
  opts: PostJsonOptions = {},
): Promise<HttpResponse> {
  const doFetch: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  const sleep = opts.sleep ?? realSleep;
  const random = opts.random ?? Math.random;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxRetries = opts.maxRetries ?? 4;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const maxDelayMs = opts.maxDelayMs ?? 60_000;
  const body = JSON.stringify(payload);
  const headers = { 'content-type': 'application/json', ...opts.headers };

  const backoff = (retryIndex: number, retryAfterMs: number | null): number => {
    const exp = baseDelayMs * 2 ** retryIndex;
    // Full jitter on the upper half: between 50% and 100% of the exponential delay.
    const jittered = exp * (0.5 + random() * 0.5);
    const wanted = retryAfterMs === null ? jittered : Math.max(retryAfterMs, jittered);
    return Math.min(maxDelayMs, Math.round(wanted));
  };

  let attempt = 0;
  for (;;) {
    attempt++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let status: number | null = null;
    let text = '';
    let retryAfterMs: number | null = null;
    let failure: string | null = null;
    try {
      const res = await doFetch(url, { method: 'POST', headers, body, signal: controller.signal });
      status = res.status;
      text = await res.text();
      retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      failure = name === 'AbortError' ? `timed out after ${timeoutMs} ms` : 'network error';
    } finally {
      clearTimeout(timer);
    }

    if (failure === null && status !== null && !isRetryableStatus(status)) {
      if (status >= 400) {
        throw new HttpError(
          `HTTP ${status} from ${new URL(url).host}`,
          status,
          attempt,
          text.slice(0, 300),
        );
      }
      return { status, body: text, attempts: attempt };
    }

    if (attempt > maxRetries) {
      const what = failure ?? `HTTP ${status}`;
      throw new HttpError(
        `${what} from ${new URL(url).host} after ${attempt} attempts`,
        status,
        attempt,
        text.slice(0, 300),
      );
    }
    await sleep(backoff(attempt - 1, retryAfterMs));
  }
}
