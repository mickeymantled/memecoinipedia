/**
 * Dune API client. Written from Dune's documentation (read 2026-11-15) and corrected with what
 * the first live runs showed that day. This code has not been run against the live API by the
 * agent that wrote it; its tests use fakes.
 *
 * Base URL `https://api.dune.com/api`. The key goes in the `X-Dune-Api-Key` header. Dune also
 * accepts `?api_key=`; this client never uses it, and every error that leaves it has the key and
 * any `api_key=...` text scrubbed.
 *
 * Money. An execution is billed by the compute it uses and there is no request parameter that
 * caps it (the account owner sets a per-query cap in Dune's team settings). So `executeSql`
 * takes `maxCredits`, reserves it in the `UnitBudget` before the call, and keeps the reservation
 * until `waitForExecution` sees the execution end; it then records the cost Dune reports in
 * `execution_cost_credits`. If Dune reports none, it records `maxCredits`, marked estimated.
 *
 * Downloads are billed per request, when the request is made, whether or not the body is read
 * (seen live: 10 credits for 7,000 rows, 49 for 32,000). A CSV download without `limit` on a
 * large result is refused by Dune with HTTP 402; with `limit` and `offset` it works, a page is
 * capped at 32,000 rows, and `x-dune-next-offset` names the next page (absent on the last).
 * `downloadCsv` therefore fetches one page per call, appends it to the file, and reserves an
 * estimate (rows per 1,000 times a rate option) before the request. After the page is saved it
 * records the cost the caller measures (for example the difference in `usage()`), or the estimate.
 *
 * Redirects are never followed on any request (the key would travel with them): a 3xx is a
 * `DuneRedirectError`.
 */
import fs from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { z } from 'zod';
import { UnitBudget, type Reservation, type SpendEntry } from '../budget.js';
import {
  getBytes,
  getStream,
  HttpError,
  postJson,
  type FetchLike,
  type GetBytesOptions,
  type GetFetchLike,
  type PostJsonOptions,
} from '../http.js';
import { RateLimiter } from '../ratelimit.js';
import {
  cancelResponseSchema,
  executeResponseSchema,
  statusResponseSchema,
  usageResponseSchema,
  type DuneStatusResponse,
} from './schemas.js';

export const DUNE_PROVIDER = 'dune';
export const DUNE_BASE_URL = 'https://api.dune.com/api';
/** Dune caps a CSV page at this many rows, whatever `limit` says. */
export const DUNE_MAX_PAGE_ROWS = 32_000;
/**
 * Credits Dune bills per row of a CSV page: the known rate. Measured live on 2026-11-15 on the
 * candidate list: a 32,000-row page cost 49.1 credits and a 7,000-row page cost 10.0 (1.53 and
 * 1.43 per 1,000 rows). The rate of the larger page is used, which is the higher of the two, so an
 * estimate errs high rather than low.
 */
export const DUNE_CREDITS_PER_ROW = 49.1 / 32_000;
/** Credits per 1,000 rows downloaded: `DUNE_CREDITS_PER_ROW` times 1,000. */
export const DEFAULT_DOWNLOAD_CREDITS_PER_1000_ROWS = DUNE_CREDITS_PER_ROW * 1000;
/** What a page of `rows` rows is recorded at, to two decimals. */
export function estimatePageCredits(rows: number, rate: number = DUNE_CREDITS_PER_ROW): number {
  return Math.round(rows * rate * 100) / 100;
}
/** Default cap on one page's bytes. */
export const DEFAULT_MAX_PAGE_BYTES = 64 * 1024 * 1024;
export type DunePerformance = 'small' | 'medium' | 'large';

const MAX_JSON_BYTES = 1024 * 1024;

export class DuneRedirectError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Dune answered with a redirect (HTTP ${status}); redirects are not followed`);
    this.name = 'DuneRedirectError';
    this.status = status;
  }
}

export class DuneResponseError extends Error {
  readonly issues: string[];
  constructor(what: string, issues: string[]) {
    super(`Unexpected Dune response for ${what}: ${issues.slice(0, 5).join('; ')}`);
    this.name = 'DuneResponseError';
    this.issues = issues;
  }
}

/** Dune answered a download with HTTP 402: the request would pass the account's credit limit. */
export class DuneCreditLimitError extends Error {
  readonly status = 402;
  /** Dune's own message, scrubbed. */
  readonly duneMessage: string;
  constructor(duneMessage: string) {
    super(`Dune refused the download (HTTP 402): ${duneMessage}`);
    this.name = 'DuneCreditLimitError';
    this.duneMessage = duneMessage;
  }
}

/** The download passed its byte cap and was cut off. */
export class DuneDownloadTooLargeError extends Error {
  readonly maxBytes: number;
  constructor(maxBytes: number) {
    super(`CSV page is larger than ${maxBytes} bytes; the download was cut off`);
    this.name = 'DuneDownloadTooLargeError';
    this.maxBytes = maxBytes;
  }
}

export interface DuneUsage {
  privateQueries: number | null;
  privateDashboards: number | null;
  bytesUsed: number | null;
  bytesAllowed: number | null;
  billingPeriods: Array<{
    startDate: string | null;
    endDate: string | null;
    creditsUsed: number | null;
    creditsIncluded: number | null;
  }>;
  /** The period with the latest end date, or null when there is none. */
  current: {
    startDate: string | null;
    endDate: string | null;
    creditsUsed: number | null;
    creditsIncluded: number | null;
  } | null;
  /** Credits included minus credits used for `current`, or null when either is unknown. */
  creditsRemaining: number | null;
}

export interface ExecuteOptions {
  /** The most this execution may cost. Positive. Reserved before the call. */
  maxCredits: number;
  performance?: DunePerformance;
}

export type ExecuteResult =
  { status: 'started'; executionId: string; state: string | null } | { status: 'dry_run' };

export interface WaitOptions {
  /** First wait between polls. Default 2,000 ms. */
  pollStartMs?: number;
  /** Longest wait between polls. Default 15,000 ms. */
  pollMaxMs?: number;
  /** Each wait is the last one times this. Default 1.5. */
  backoffFactor?: number;
  /** Default 30 minutes. On reaching it the execution is cancelled. */
  timeLimitMs?: number;
  /** After a cancel, how long to wait for the execution to stop so its cost is known. Default 2 minutes. */
  afterCancelWaitMs?: number;
}

export interface ExecutionSummary {
  executionId: string;
  state: string;
  /** Cost Dune reported, or null when it reported none. */
  reportedCredits: number | null;
  /** What was recorded in the budget (`reportedCredits`, or `maxCredits` when none was reported). */
  chargedCredits: number | null;
  /** True when `chargedCredits` is not a reported figure. */
  estimated: boolean;
  rowCount: number | null;
  /** `total_result_set_bytes`: the raw size of the whole result. */
  resultBytes: number | null;
  columns: string[];
}

export type WaitResult =
  | ({ outcome: 'completed' } & ExecutionSummary)
  /** Succeeded but Dune truncated the result; it is not downloaded. */
  | ({ outcome: 'partial' } & ExecutionSummary)
  | ({ outcome: 'failed'; errorType: string | null; error: string } & ExecutionSummary)
  | ({ outcome: 'cancelled' } & ExecutionSummary)
  | ({ outcome: 'expired' } & ExecutionSummary)
  | ({
      outcome: 'timed_out';
      cancelRequested: boolean;
      cancelSucceeded: boolean;
    } & ExecutionSummary)
  | { outcome: 'dry_run' };

export interface DownloadOptions {
  /** Rows in this page, 1 to 32,000 (Dune's cap). Default 32,000. */
  limit?: number;
  /** First row of this page, zero-based. Default 0. A page at offset 0 starts the file. */
  offset?: number;
  /** Column names to return (Dune's `columns=`). */
  columns?: readonly string[];
  /** A WHERE-style expression (Dune's `filters=`). */
  filters?: string;
  /** Cap on this page in bytes; the stream is cut off at it. Default 64 MiB. */
  maxBytes?: number;
  /**
   * Called after the page is saved. Returns the credits the page cost (for example the
   * difference in `usage()` before and after), or null when unknown. The result is recorded as a
   * reported cost; with null, or when this is not given, the estimate from the row count is
   * recorded, marked estimated.
   */
  measureCredits?: () => Promise<number | null>;
}

export type DownloadResult =
  | {
      status: 'downloaded';
      path: string;
      /** Data rows in this page, the header row not counted. */
      rows: number;
      /** Bytes received for this page, header included. */
      bytes: number;
      /** The offset of the next page from `x-dune-next-offset`, or null on the last page. */
      nextOffset: number | null;
      /** What was recorded in the budget for this page. */
      credits: number;
      /** True when `credits` is the estimate, not a measured figure. */
      estimated: boolean;
      /** What was reserved before the request. */
      reservedCredits: number;
    }
  | { status: 'dry_run' };

export type DunePlannedCall =
  | { kind: 'usage'; credits: 0; detail: string }
  | { kind: 'execute'; credits: number; detail: string }
  | { kind: 'export'; credits: number | null; detail: string };

export interface DuneDryRunPlan {
  calls: DunePlannedCall[];
  /** Sum of the credits that are known; `execute` entries count at their `maxCredits`. */
  totalCredits: number;
  /** True when some export has no known cost. */
  hasUnknownCosts: boolean;
}

export interface DuneClientOptions {
  /** `DUNE_API_KEY`. */
  apiKey: string;
  baseUrl?: string;
  /** Used for POST requests (execute, cancel, usage). */
  fetch?: FetchLike;
  /** Used for GET requests (status, CSV). */
  getFetch?: GetFetchLike;
  /** Shared by every request, polling included. Default: 1 request a second. */
  limiter?: RateLimiter;
  budget?: UnitBudget;
  dryRun?: boolean;
  /** Credits per 1,000 rows downloaded, for the estimate. Default: the known rate, 1.534. */
  downloadCreditsPer1000Rows?: number;
  /** Milliseconds, monotonic. Default `performance.now()`. */
  now?: () => number;
  /** Default: a real timer. Used for the poll waits. */
  sleep?: (ms: number) => Promise<void>;
  /** Overrides for timeout, retries, backoff, sleep and jitter of each request. */
  http?: Omit<PostJsonOptions, 'fetch' | 'headers'>;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const issueList = (error: z.ZodError): string[] =>
  error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);

/**
 * What Dune said, for a failed request: its `error` text when the body has one (scrubbed),
 * else the error's own message. Never contains the key.
 */
export function duneErrorMessage(err: unknown): string {
  if (err instanceof DuneCreditLimitError) return err.duneMessage;
  if (err instanceof HttpError) {
    try {
      const body = JSON.parse(err.bodySnippet) as { error?: unknown };
      if (typeof body.error === 'string' && body.error !== '') {
        return `HTTP ${err.status}: ${body.error}`;
      }
    } catch {
      // Not JSON: fall through to the message.
    }
  }
  return err instanceof Error ? err.message : 'unknown error';
}

/** Reads the key from `env.DUNE_API_KEY`. Never echoes it. */
export function duneApiKeyFromEnv(env: Readonly<Record<string, string | undefined>>): string {
  const key = env['DUNE_API_KEY'];
  if (key === undefined || key.trim() === '') {
    throw new Error('DUNE_API_KEY is not set');
  }
  return key.trim();
}

const CANCELLED_STATES = new Set(['QUERY_STATE_CANCELED', 'QUERY_STATE_CANCELLED']);

export class DuneClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly getFetchImpl: GetFetchLike | undefined;
  private readonly limiter: RateLimiter;
  readonly budget: UnitBudget;
  private readonly dryRun: boolean;
  private readonly creditsPer1000Rows: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly httpOptions: Omit<PostJsonOptions, 'fetch' | 'headers'>;
  private readonly planned: DunePlannedCall[] = [];
  /** Reservations of executions that were started and have not ended. */
  private readonly open = new Map<string, Reservation>();
  private requests = 0;

  constructor(opts: DuneClientOptions) {
    if (opts.apiKey.trim() === '') throw new Error('Dune API key is empty');
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DUNE_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = opts.fetch;
    this.getFetchImpl = opts.getFetch;
    this.limiter = opts.limiter ?? new RateLimiter({ maxPerSecond: 1, burst: 1 });
    this.budget = opts.budget ?? new UnitBudget();
    this.dryRun = opts.dryRun ?? false;
    this.creditsPer1000Rows =
      opts.downloadCreditsPer1000Rows ?? DEFAULT_DOWNLOAD_CREDITS_PER_1000_ROWS;
    if (!(this.creditsPer1000Rows > 0)) {
      throw new RangeError('downloadCreditsPer1000Rows must be positive');
    }
    this.now = opts.now ?? (() => performance.now());
    this.sleep = opts.sleep ?? opts.http?.sleep ?? realSleep;
    this.httpOptions = opts.http ?? {};
  }

  /** HTTP requests made so far, retries included. */
  requestCount(): number {
    return this.requests;
  }

  /** Executions started and not yet ended (their `maxCredits` is still reserved). */
  openExecutions(): string[] {
    return [...this.open.keys()];
  }

  /** The executions and exports that dry-run mode recorded instead of calling. */
  plan(): DuneDryRunPlan {
    const total = this.planned.reduce((s, c) => s + (c.credits ?? 0), 0);
    return {
      calls: [...this.planned],
      totalCredits: total,
      hasUnknownCosts: this.planned.some((c) => c.credits === null),
    };
  }

  // Public calls --------------------------------------------------------

  /** Credits used and included for the current billing period. Dune says this costs nothing. */
  async usage(): Promise<DuneUsage | null> {
    if (this.dryRun) {
      this.planned.push({ kind: 'usage', credits: 0, detail: 'usage' });
      return null;
    }
    const res = await this.post('/v1/usage', {});
    const json = this.parseJson(res.body, 'usage');
    const parsed = usageResponseSchema.safeParse(json);
    if (!parsed.success) throw new DuneResponseError('usage', issueList(parsed.error));
    const periods = parsed.data.billingPeriods;
    const current =
      [...periods].sort((a, b) => (b.endDate ?? '').localeCompare(a.endDate ?? ''))[0] ?? null;
    const used = current?.creditsUsed ?? null;
    const included = current?.creditsIncluded ?? null;
    return {
      ...parsed.data,
      current,
      creditsRemaining: used !== null && included !== null ? included - used : null,
    };
  }

  /**
   * Starts an execution of `sql` without a saved query. Reserves `maxCredits` first (throws
   * `BudgetExceededError` when it does not fit; nothing is sent). The reservation is held
   * until `waitForExecution` or `abandon` settles it. If the request itself fails, the
   * reservation is released at once: no execution was started.
   */
  async executeSql(sql: string, options: ExecuteOptions): Promise<ExecuteResult> {
    if (!(options.maxCredits > 0) || !Number.isFinite(options.maxCredits)) {
      throw new RangeError('maxCredits must be a positive number');
    }
    if (this.dryRun) {
      this.planned.push({
        kind: 'execute',
        credits: options.maxCredits,
        detail: `execute SQL (${sql.length} chars), performance ${options.performance ?? 'default'}, at most ${options.maxCredits} credits`,
      });
      return { status: 'dry_run' };
    }
    const reservation = this.budget.reserve(DUNE_PROVIDER, options.maxCredits);
    const body: Record<string, unknown> = { sql };
    if (options.performance) body['performance'] = options.performance;
    let res;
    try {
      res = await this.post('/v1/sql/execute', body);
    } catch (err) {
      // The request failed (after the shared retries), so no execution is assumed to run.
      this.budget.settle(reservation, []);
      throw err;
    }
    let parsed;
    try {
      parsed = executeResponseSchema.safeParse(this.parseJson(res.body, 'execute'));
      if (!parsed.success) throw new DuneResponseError('execute', issueList(parsed.error));
    } catch (err) {
      // Dune accepted the request but its answer is unreadable: an execution we cannot name
      // may be running. Assume the worst case was spent.
      this.budget.settle(reservation, [{ units: options.maxCredits, estimated: true }]);
      throw err;
    }
    this.open.set(parsed.data.execution_id, reservation);
    return {
      status: 'started',
      executionId: parsed.data.execution_id,
      state: parsed.data.state ?? null,
    };
  }

  /**
   * Polls the status until the execution ends or `timeLimitMs` passes, with a growing wait
   * between polls (2 s to 15 s by default). On the time limit it asks Dune to cancel the
   * execution and returns `timed_out`. A failed execution is returned as `failed` with its
   * error text, not thrown. An HTTP failure while polling is thrown, and the reservation stays
   * held so the caller can wait again or call `abandon`.
   */
  async waitForExecution(executionId: string, options: WaitOptions = {}): Promise<WaitResult> {
    if (this.dryRun) return { outcome: 'dry_run' };
    const start = this.now();
    const limit = options.timeLimitMs ?? 30 * 60_000;
    const maxInterval = options.pollMaxMs ?? 15_000;
    const factor = options.backoffFactor ?? 1.5;
    let interval = options.pollStartMs ?? 2_000;

    for (;;) {
      const status = await this.getStatus(executionId);
      const outcome = this.classify(status);
      if (outcome !== null) return this.finish(executionId, status, outcome);

      const elapsed = this.now() - start;
      if (elapsed >= limit)
        return this.timeOut(executionId, status, options.afterCancelWaitMs ?? 120_000);
      await this.sleep(Math.max(1, Math.min(interval, limit - elapsed)));
      interval = Math.min(maxInterval, Math.round(interval * factor));
    }
  }

  /**
   * Gives up on an execution this client started: settles its reservation at `maxCredits`,
   * marked estimated (it may still be running, and a cancelled one may be charged).
   */
  abandon(executionId: string): void {
    const r = this.open.get(executionId);
    if (!r) return;
    this.open.delete(executionId);
    this.budget.settle(r, [{ units: r.units, estimated: true }]);
  }

  /** Asks Dune to cancel. Returns Dune's `success`. */
  async cancel(executionId: string): Promise<boolean> {
    const res = await this.post(`/v1/execution/${encodeURIComponent(executionId)}/cancel`, {});
    const parsed = cancelResponseSchema.safeParse(this.parseJson(res.body, 'cancel'));
    if (!parsed.success) throw new DuneResponseError('cancel', issueList(parsed.error));
    return parsed.data.success;
  }

  /**
   * Downloads one page of the finished result as CSV into `path`. Works for any execution id,
   * including one this client did not start.
   *
   * A page at offset 0 creates (truncates) the file and keeps its header row; a page at a later
   * offset is appended with its header row dropped. If the page fails after the request was
   * accepted, the file is cut back to its size before the page, so a later retry of the same
   * offset leaves no duplicate rows. Dune bills a page when the request is made, so a page whose
   * body then fails is still recorded, at the reserved estimate.
   *
   * A zero or negative measured cost for a page with rows is not believed; the estimate is used.
   * A later page is appended after a newline if the file did not end with one.
   *
   * An estimate (rows times the rate) is reserved before the request; when it does not fit the
   * budget, `BudgetExceededError` is thrown and nothing is requested. HTTP 402 is a
   * `DuneCreditLimitError`, not retried. The next offset comes from `x-dune-next-offset`.
   */
  async downloadCsv(
    executionId: string,
    path: string,
    options: DownloadOptions = {},
  ): Promise<DownloadResult> {
    const limit = options.limit ?? DUNE_MAX_PAGE_ROWS;
    const offset = options.offset ?? 0;
    const cap = options.maxBytes ?? DEFAULT_MAX_PAGE_BYTES;
    if (!Number.isInteger(limit) || limit < 1 || limit > DUNE_MAX_PAGE_ROWS) {
      throw new RangeError(`limit must be a whole number from 1 to ${DUNE_MAX_PAGE_ROWS}`);
    }
    if (!Number.isInteger(offset) || offset < 0) throw new RangeError('offset must be >= 0');
    if (!(cap > 0) || !Number.isFinite(cap)) throw new RangeError('byte cap must be positive');
    for (const c of options.columns ?? []) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(c)) throw new RangeError(`Bad column name ${c}`);
    }
    if (
      options.filters !== undefined &&
      !/^[A-Za-z0-9_ .,<>=!'()+*/%-]{1,500}$/.test(options.filters)
    ) {
      throw new RangeError('filters contains characters that are not accepted');
    }
    const estimate = (rows: number) => estimatePageCredits(rows, this.creditsPer1000Rows / 1000);
    const reserved = estimate(limit);

    if (this.dryRun) {
      this.planned.push({
        kind: 'export',
        credits: reserved,
        detail: `download CSV page of ${executionId} to ${path}, offset ${offset}, up to ${limit} rows`,
      });
      return { status: 'dry_run' };
    }

    const reservation = this.budget.reserve(DUNE_PROVIDER, reserved);
    const first = offset === 0;
    const startSize = first || !fs.existsSync(path) ? 0 : fs.statSync(path).size;
    let accepted = false;
    let received = 0;
    let newlines = 0;
    let lastByte = 0x0a;
    try {
      const params = [`limit=${limit}`, `offset=${offset}`];
      if (options.columns && options.columns.length > 0) {
        params.push(`columns=${encodeURIComponent(options.columns.join(','))}`);
      }
      if (options.filters !== undefined)
        params.push(`filters=${encodeURIComponent(options.filters)}`);
      const url = `${this.baseUrl}/v1/execution/${encodeURIComponent(executionId)}/results/csv?${params.join('&')}`;
      let res;
      try {
        res = await this.get(url);
      } catch (err) {
        if (err instanceof HttpError && err.status === 402) {
          throw new DuneCreditLimitError(duneErrorMessage(err).replace(/^HTTP 402: /, ''));
        }
        throw err;
      }
      accepted = true;
      if (res.body === null) throw new DuneResponseError('csv', ['response has no body']);
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > cap) {
        await res.body.cancel().catch(() => undefined);
        throw new DuneDownloadTooLargeError(cap);
      }
      if (!first && startSize > 0) {
        // A file that does not end with a newline would glue this page's first row onto its last.
        const fd = fs.openSync(path, 'r');
        const last = Buffer.alloc(1);
        fs.readSync(fd, last, 0, 1, startSize - 1);
        fs.closeSync(fd);
        if (last[0] !== 0x0a) fs.appendFileSync(path, '\n');
      }
      let dropping = !first; // drop bytes up to and including the first newline (the header)
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          received += chunk.length;
          if (received > cap) {
            cb(new DuneDownloadTooLargeError(cap));
            return;
          }
          for (const b of chunk) if (b === 0x0a) newlines++;
          if (chunk.length > 0) lastByte = chunk[chunk.length - 1] as number;
          if (dropping) {
            const at = chunk.indexOf(0x0a);
            if (at < 0) {
              cb(null, Buffer.alloc(0));
              return;
            }
            dropping = false;
            cb(null, chunk.subarray(at + 1));
            return;
          }
          cb(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(res.body as WebReadableStream<Uint8Array>),
        counter,
        fs.createWriteStream(path, { flags: first ? 'w' : 'a' }),
      );
      const lines = newlines + (received > 0 && lastByte !== 0x0a ? 1 : 0);
      const rows = Math.max(0, lines - 1);
      const nextHeader = res.headers.get('x-dune-next-offset');
      let nextOffset: number | null = null;
      if (nextHeader !== null && nextHeader.trim() !== '') {
        const n = Number(nextHeader);
        if (!Number.isInteger(n) || n <= offset) {
          throw new DuneResponseError('csv', [
            `x-dune-next-offset is not a later offset: ${nextHeader}`,
          ]);
        }
        nextOffset = n;
      }

      let measured: number | null = null;
      try {
        measured = (await options.measureCredits?.()) ?? null;
      } catch {
        measured = null;
      }
      // A zero (or less) for a page that returned rows is not believed: usage may lag. Use the estimate.
      const useMeasured =
        measured !== null &&
        Number.isFinite(measured) &&
        (measured > 0 || (measured === 0 && rows === 0));
      const credits = useMeasured ? (measured as number) : estimate(rows);
      this.budget.settle(reservation, [{ units: credits, estimated: !useMeasured }]);
      return {
        status: 'downloaded',
        path,
        rows,
        bytes: received,
        nextOffset,
        credits,
        estimated: !useMeasured,
        reservedCredits: reserved,
      };
    } catch (err) {
      // Billed when requested: once Dune accepted the request, the page is charged at the estimate.
      this.budget.settle(reservation, accepted ? [{ units: reserved, estimated: true }] : []);
      if (accepted) {
        if (startSize === 0 && first) await fs.promises.rm(path, { force: true });
        else if (fs.existsSync(path)) await fs.promises.truncate(path, startSize);
      }
      throw err;
    }
  }

  // Plumbing ------------------------------------------------------------

  private redact(text: string): string {
    return text
      .replaceAll(this.apiKey, '[redacted]')
      .replace(/api_key=[^&\s"'<>]+/gi, 'api_key=[redacted]');
  }

  private parseJson(body: string, what: string): unknown {
    try {
      return JSON.parse(body);
    } catch {
      throw new DuneResponseError(what, ['response was not JSON']);
    }
  }

  private rewrap(err: unknown): never {
    if (err instanceof HttpError) {
      throw new HttpError(
        this.redact(err.message),
        err.status,
        err.attempts,
        this.redact(err.bodySnippet),
      );
    }
    throw err;
  }

  private async post(path: string, payload: unknown): Promise<{ status: number; body: string }> {
    const base: FetchLike = this.fetchImpl ?? ((url, init) => fetch(url, init));
    const limited: FetchLike = (url, init) =>
      this.limiter.run(() => {
        this.requests++;
        return base(url, init);
      });
    try {
      const res = await postJson(`${this.baseUrl}${path}`, payload, {
        ...this.httpOptions,
        fetch: limited,
        headers: { 'x-dune-api-key': this.apiKey, 'user-agent': 'ingest-client/0.1' },
      });
      if (res.status >= 300) throw new DuneRedirectError(res.status);
      return res;
    } catch (err) {
      return this.rewrap(err);
    }
  }

  private getHeaders(): Record<string, string> {
    return { 'x-dune-api-key': this.apiKey, 'user-agent': 'ingest-client/0.1' };
  }

  private limitedGet(): GetFetchLike {
    const base: GetFetchLike = this.getFetchImpl ?? ((url, init) => fetch(url, init));
    return (url, init) =>
      this.limiter.run(() => {
        this.requests++;
        return base(url, init);
      });
  }

  private async get(url: string) {
    try {
      const res = await getStream(url, {
        ...this.httpOptions,
        fetch: this.limitedGet(),
        headers: { ...this.getHeaders(), accept: 'text/csv' },
      });
      if (res.status >= 300) throw new DuneRedirectError(res.status);
      return res;
    } catch (err) {
      return this.rewrap(err);
    }
  }

  private async getStatus(executionId: string): Promise<DuneStatusResponse> {
    const url = `${this.baseUrl}/v1/execution/${encodeURIComponent(executionId)}/status`;
    const opts: GetBytesOptions = {
      ...this.httpOptions,
      fetch: this.limitedGet(),
      headers: { ...this.getHeaders(), accept: 'application/json' },
      maxBytes: MAX_JSON_BYTES,
    };
    try {
      const res = await getBytes(url, opts);
      if (res.status >= 300) throw new DuneRedirectError(res.status);
      const json = this.parseJson(new TextDecoder().decode(res.body), 'status');
      const parsed = statusResponseSchema.safeParse(json);
      if (!parsed.success) throw new DuneResponseError('status', issueList(parsed.error));
      return parsed.data;
    } catch (err) {
      return this.rewrap(err);
    }
  }

  /** The outcome name for a terminal status, or null while the execution is still going. */
  private classify(
    s: DuneStatusResponse,
  ): 'completed' | 'partial' | 'failed' | 'cancelled' | 'expired' | null {
    switch (s.state) {
      case 'QUERY_STATE_COMPLETED':
        return 'completed';
      case 'QUERY_STATE_COMPLETED_PARTIAL':
        return 'partial';
      case 'QUERY_STATE_FAILED':
        return 'failed';
      case 'QUERY_STATE_EXPIRED':
        return 'expired';
      default:
        if (CANCELLED_STATES.has(s.state)) return 'cancelled';
        // An unknown state with the finished flag set must still stop the loop.
        if (s.is_execution_finished === true) return 'failed';
        return null;
    }
  }

  private summarize(
    executionId: string,
    s: DuneStatusResponse,
    charged: number | null,
    estimated: boolean,
  ): ExecutionSummary {
    const m = s.result_metadata;
    return {
      executionId,
      state: s.state,
      reportedCredits: s.execution_cost_credits ?? null,
      chargedCredits: charged,
      estimated,
      rowCount: m?.total_row_count ?? m?.row_count ?? null,
      resultBytes: m?.total_result_set_bytes ?? m?.result_set_bytes ?? null,
      columns: m?.column_names ?? [],
    };
  }

  /** Records the cost and releases the reservation (if this client started the execution). */
  private settleExecution(
    executionId: string,
    s: DuneStatusResponse,
  ): { charged: number | null; estimated: boolean } {
    const reported = s.execution_cost_credits ?? null;
    const r = this.open.get(executionId);
    this.open.delete(executionId);
    if (!r) {
      // Not started by this client (for example a reused execution): its cost was not spent by
      // this run, so nothing is recorded; the reported figure is only passed on.
      return { charged: reported, estimated: false };
    }
    const entry: SpendEntry =
      reported !== null
        ? { units: reported, estimated: false }
        : { units: r.units, estimated: true };
    this.budget.settle(r, [entry]);
    return { charged: entry.units, estimated: entry.estimated };
  }

  private finish(
    executionId: string,
    s: DuneStatusResponse,
    outcome: 'completed' | 'partial' | 'failed' | 'cancelled' | 'expired',
  ): WaitResult {
    const { charged, estimated } = this.settleExecution(executionId, s);
    const summary = this.summarize(executionId, s, charged, estimated);
    if (outcome === 'failed') {
      const message = s.error?.message ?? `execution ended in state ${s.state}`;
      return {
        outcome,
        errorType: s.error?.type ?? null,
        error: this.redact(message).slice(0, 2000),
        ...summary,
      };
    }
    return { outcome, ...summary };
  }

  private async timeOut(
    executionId: string,
    last: DuneStatusResponse,
    afterCancelWaitMs: number,
  ): Promise<WaitResult> {
    let cancelSucceeded = false;
    try {
      cancelSucceeded = await this.cancel(executionId);
    } catch {
      // The execution may still be running. The reservation below is settled at the worst case.
    }
    // A cancelled run does report its cost, but only once it has stopped: wait for that.
    let final = last;
    const waitStart = this.now();
    const waitLimit = afterCancelWaitMs;
    for (;;) {
      try {
        final = await this.getStatus(executionId);
      } catch {
        break; // keep the last status; the cost falls back to the reserved maximum
      }
      if (this.classify(final) !== null) break;
      if (this.now() - waitStart >= waitLimit) break;
      await this.sleep(2_000);
    }
    const { charged, estimated } = this.settleExecution(executionId, final);
    return {
      outcome: 'timed_out',
      cancelRequested: true,
      cancelSucceeded,
      ...this.summarize(executionId, final, charged, estimated),
    };
  }
}
