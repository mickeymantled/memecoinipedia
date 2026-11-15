/**
 * Dune API client, written from Dune's documentation (read 2026-11-15). Nothing here has been
 * run against the live API.
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
 * Exports are billed by size (credits per MB, a client option: 10 on Analyst, 2 on Plus). The
 * export cost is computed from the size and reserved before the download starts.
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
export const DUNE_MB = 1024 * 1024;
/** Credits per MB exported on the Analyst plan (Plus is 2). The more expensive one is the default. */
export const DEFAULT_EXPORT_CREDITS_PER_MB = 10;
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

/** A download was refused because its size is not known and no `maxBytes` was given. */
export class DuneSizeUnknownError extends Error {
  constructor() {
    super(
      'Result size is not known; pass resultBytes, or an explicit maxBytes to cap the download',
    );
    this.name = 'DuneSizeUnknownError';
  }
}

/** The download passed its byte cap and was cut off. */
export class DuneDownloadTooLargeError extends Error {
  readonly maxBytes: number;
  constructor(maxBytes: number) {
    super(`CSV is larger than ${maxBytes} bytes; the download was cut off`);
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
  /** `total_result_set_bytes` from `waitForExecution`. */
  resultBytes?: number | null;
  /**
   * Cap on the CSV in bytes: the stream is cut off at this size. Required when `resultBytes`
   * is not known. When both are given the cap is `maxBytes`. When only `resultBytes` is given
   * the cap is `resultBytes`, which can be too small if Dune's CSV text is bigger than its raw
   * size figure; then pass `maxBytes`.
   */
  maxBytes?: number;
}

export type DownloadResult =
  | {
      status: 'downloaded';
      path: string;
      bytes: number;
      /** Cost of the bytes received: whole MB, rounded up, times the rate. */
      credits: number;
      /** What was reserved before the download (the cost at the byte cap). */
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
  /** Credits per MB exported. Default 10 (Analyst); Plus is 2. */
  exportCreditsPerMb?: number;
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

/** Cost in credits of exporting `bytes`: whole MB, rounded up, times the rate. */
export function exportCredits(bytes: number, creditsPerMb: number): number {
  return Math.ceil(bytes / DUNE_MB) * creditsPerMb;
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
  private readonly exportRate: number;
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
    this.exportRate = opts.exportCreditsPerMb ?? DEFAULT_EXPORT_CREDITS_PER_MB;
    if (!(this.exportRate > 0)) throw new RangeError('exportCreditsPerMb must be positive');
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
      if (elapsed >= limit) return this.timeOut(executionId, status);
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
   * Streams the finished result as CSV to `path`, counting bytes. The export cost is computed
   * at the byte cap (whole MB, rounded up, times the rate) and reserved first; when it does not
   * fit the budget, `BudgetExceededError` is thrown and nothing is requested. A result of
   * unknown size is refused unless `maxBytes` is given. When the download ends, the cost of the
   * bytes actually received is recorded, marked estimated (Dune reports no per-export cost).
   * A file left by a failed download is removed.
   */
  async downloadCsv(
    executionId: string,
    path: string,
    options: DownloadOptions = {},
  ): Promise<DownloadResult> {
    const known = options.resultBytes ?? null;
    const cap = options.maxBytes ?? known;
    if (cap === null) throw new DuneSizeUnknownError();
    if (!(cap > 0) || !Number.isFinite(cap)) throw new RangeError('byte cap must be positive');
    const reserved = exportCredits(cap, this.exportRate);

    if (this.dryRun) {
      this.planned.push({
        kind: 'export',
        credits: reserved,
        detail: `export CSV of ${executionId} to ${path}, at most ${cap} bytes`,
      });
      return { status: 'dry_run' };
    }

    const reservation = this.budget.reserve(DUNE_PROVIDER, reserved);
    let received = 0;
    const spend = (): SpendEntry[] => {
      const units = exportCredits(received, this.exportRate);
      return units > 0 ? [{ units, estimated: true }] : [];
    };
    try {
      const url = `${this.baseUrl}/v1/execution/${encodeURIComponent(executionId)}/results/csv`;
      const res = await this.get(url);
      if (res.body === null) throw new DuneResponseError('csv', ['response has no body']);
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > cap) {
        await res.body.cancel().catch(() => undefined);
        throw new DuneDownloadTooLargeError(cap);
      }
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          received += chunk.length;
          if (received > cap) cb(new DuneDownloadTooLargeError(cap));
          else cb(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(res.body as WebReadableStream<Uint8Array>),
        counter,
        fs.createWriteStream(path),
      );
      this.budget.settle(reservation, spend());
      return {
        status: 'downloaded',
        path,
        bytes: received,
        credits: exportCredits(received, this.exportRate),
        reservedCredits: reserved,
      };
    } catch (err) {
      this.budget.settle(reservation, spend());
      await fs.promises.rm(path, { force: true });
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
      // Not started by this client: no reservation to release; record a reported cost only.
      if (reported !== null) this.budget.record(DUNE_PROVIDER, reported, false);
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

  private async timeOut(executionId: string, last: DuneStatusResponse): Promise<WaitResult> {
    let cancelSucceeded = false;
    try {
      cancelSucceeded = await this.cancel(executionId);
    } catch {
      // The execution may still be running. The reservation below is settled at the worst case.
    }
    // One more look, for the cost Dune reports for a cancelled execution (it may be charged).
    let final = last;
    try {
      final = await this.getStatus(executionId);
    } catch {
      // Keep the last status; the cost falls back to the reserved maximum.
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
