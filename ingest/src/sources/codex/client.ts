/**
 * Codex.io client (GraphQL at https://graph.codex.io/graphql). This is the
 * blockchain data API, unrelated to the OpenAI Codex coding agent.
 *
 * Rules from docs/data-sources.md section 7, which this client enforces by
 * not offering the alternatives:
 *
 * - NEVER call token-level bars (`getTokenBars`). They blend in dust pools:
 *   one coin showed a $13.1M daily high against $1.24M in its real pool. Use
 *   pool-level bars (`getBars`) from the graduation pool.
 * - NEVER read Codex's own ATH fields. They were 3 to 15 times lower than the
 *   bars for most 2024 and 2025 coins. All-time-high figures come from bars.
 * - Bar highs are raw wicks, not ATHs. Filtering them is the metric library's job.
 *
 * Every request asks for `usageData{ total{computeUnits} }` and the cost the
 * response reports is what the budget records. Only when a response has no
 * cost is the documented flat cost used, marked as estimated.
 */
import type { Bar } from '../../metrics/types.js';
import { UnitBudget, type SpendEntry } from '../budget.js';
import {
  HttpError,
  parseRetryAfter,
  postJson,
  type FetchLike,
  type PostJsonOptions,
} from '../http.js';
import type { RateLimiter } from '../ratelimit.js';
import { barsFromColumns, planBarRequests, sortAndDedupeBars } from './bars.js';
import { pairIdFor, type PoolInfo, type PoolsResult } from './pools.js';
import {
  FILTER_TOKENS_MAX_DEPTH,
  FILTER_TOKENS_MAX_LIMIT,
  PAIRS_LIMIT,
  barsQuery,
  filterTokensQuery,
  pairsQuery,
  tokenQuery,
  type BarResolution,
} from './queries.js';
import {
  barsDataSchema,
  filterTokensDataSchema,
  graphqlEnvelopeSchema,
  pairsDataSchema,
  tokenDataSchema,
} from './schemas.js';
import type { z } from 'zod';

export const CODEX_PROVIDER = 'codex';
export const DEFAULT_ENDPOINT = 'https://graph.codex.io/graphql';

/** Cost of a bars or token request, in compute units (measured: 4.0000 and 4.0044). */
export const FLAT_UNITS = 4;
/** Both filterTokens and the pairs listing grow by about this much per result (measured). */
export const UNITS_PER_RESULT = 0.0048;
/** filterTokens: base cost plus UNITS_PER_RESULT per token returned. */
export const FILTER_BASE_UNITS = 5;
export const FILTER_UNITS_PER_TOKEN = UNITS_PER_RESULT;
/** Pairs listing: base cost plus UNITS_PER_RESULT per pair returned. */
export const PAIRS_BASE_UNITS = 4;

export class CodexGraphQLError extends Error {
  readonly messages: string[];
  readonly codes: string[];
  /** `extensions.retryAfterSeconds` when Codex says when the limit lifts. */
  readonly retryAfterSeconds: number | null;

  constructor(messages: string[], codes: string[], retryAfterSeconds: number | null = null) {
    super(`Codex GraphQL error: ${messages.join('; ')}`);
    this.name = 'CodexGraphQLError';
    this.messages = messages;
    this.codes = codes;
    this.retryAfterSeconds = retryAfterSeconds;
  }

  /**
   * Codex's rate-limit answer (code `TOO_MANY_REQUESTS`, "Your account has been rate limited"),
   * which it can send inside an HTTP 200.
   */
  get rateLimited(): boolean {
    return (
      this.codes.includes('TOO_MANY_REQUESTS') ||
      this.messages.some((m) => /rate.?limit|too many requests/i.test(m))
    );
  }
}

/** True for an error that means "slow down": HTTP 429 or a rate-limit GraphQL error. */
export function isRateLimitError(err: unknown): boolean {
  if (err instanceof HttpError) return err.status === 429;
  if (err instanceof CodexGraphQLError) return err.rateLimited;
  return false;
}

/** The same test on the text of an error message, for code that only has the message. */
export const RATE_LIMIT_MESSAGE = /HTTP 429|rate.?limit|too many requests|TOO_MANY_REQUESTS/i;

/** The response was not JSON, or did not match the expected shape. */
export class CodexResponseError extends Error {
  readonly operation: string;
  readonly issues: string[];

  constructor(operation: string, issues: string[]) {
    super(`Unexpected Codex response for ${operation}: ${issues.slice(0, 5).join('; ')}`);
    this.name = 'CodexResponseError';
    this.operation = operation;
    this.issues = issues;
  }
}

export interface LaunchInfo {
  mint: string;
  symbol: string | null;
  name: string | null;
  /** Token creation time, unix seconds. */
  createdAt: number | null;
  creator: string | null;
  launchpadName: string | null;
  migrated: boolean | null;
  /** Migration (graduation) time, unix seconds. */
  migratedAt: number | null;
  /** Null for most coins before March 2025. */
  migratedPoolAddress: string | null;
  completed: boolean | null;
  completedAt: number | null;
  /** `launchpad.poolAddress` as Codex reports it; it differed from the migrated pool in every recorded case. */
  launchpadPoolAddress: string | null;
}

export interface DiscoveredToken extends LaunchInfo {
  /** `pair.address` from the filterTokens row. */
  pairAddress: string | null;
  liquidityUsd: number | null;
}

export type CodexOperation = 'filterTokens' | 'token' | 'pairs' | 'bars';

export interface PlannedCall {
  operation: CodexOperation;
  estimatedUnits: number;
  detail: string;
}

export interface DryRunPlan {
  calls: PlannedCall[];
  byOperation: Record<string, { requests: number; units: number }>;
  totalRequests: number;
  totalUnits: number;
  /** Operations whose request count is a lower bound (discovery cannot know how many pages exist). */
  lowerBoundOperations: CodexOperation[];
}

export interface CodexClientOptions {
  apiKey: string;
  fetch?: FetchLike;
  limiter?: RateLimiter;
  budget?: UnitBudget;
  endpoint?: string;
  dryRun?: boolean;
  /** Overrides for timeout, retries, backoff, sleep and jitter. */
  http?: Omit<PostJsonOptions, 'fetch' | 'headers'>;
}

export interface DiscoverOptions {
  /** Width of one time window, seconds. Default 86,400. */
  windowSeconds?: number;
  /** Rows per request, at most 200. Default 200. */
  pageSize?: number;
  /** Largest `limit + offset` the API accepts. Default 10,000, the limit found live. Lowered in tests. */
  maxDepth?: number;
}

type Launchpad = NonNullable<z.infer<typeof tokenDataSchema>['token']>['launchpad'];
type TokenRow = NonNullable<z.infer<typeof tokenDataSchema>['token']>;

function launchInfoFrom(t: TokenRow): LaunchInfo {
  const lp: NonNullable<Launchpad> = t.launchpad ?? {};
  return {
    mint: t.address,
    symbol: t.symbol ?? null,
    name: t.name ?? null,
    createdAt: t.createdAt ?? null,
    creator: t.creatorAddress ?? null,
    launchpadName: lp.launchpadName ?? null,
    migrated: lp.migrated ?? null,
    migratedAt: lp.migratedAt ?? null,
    migratedPoolAddress: lp.migratedPoolAddress ?? null,
    completed: lp.completed ?? null,
    completedAt: lp.completedAt ?? null,
    launchpadPoolAddress: lp.poolAddress ?? null,
  };
}

/**
 * Collects what the calls made with it cost, so one coin's units can be counted
 * while other coins run on the same client (the client's own `spend()` is a
 * running total over everything). Pass the same meter to each call of a coin.
 */
export interface CallMeter {
  /** Requests made, retries not counted. */
  requests: number;
  /** Compute units, from each response's reported cost (an estimate where it reported none). */
  units: number;
}

interface CallSpec<S extends z.ZodType> {
  meter?: CallMeter | undefined;
  operation: CodexOperation;
  query: string;
  schema: S;
  /** Cost to assume before the call, for the budget check. */
  estimateBefore: number;
  /** Cost to assume after the call when the response reports none. */
  estimateAfter: (data: z.infer<S>) => number;
  detail: string;
}

export class CodexClient {
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly limiter: RateLimiter | undefined;
  readonly budget: UnitBudget;
  private readonly endpoint: string;
  readonly dryRun: boolean;
  private readonly httpOptions: Omit<PostJsonOptions, 'fetch' | 'headers'>;
  private readonly planned: PlannedCall[] = [];
  private readonly lowerBound = new Set<CodexOperation>();

  constructor(opts: CodexClientOptions) {
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch;
    this.limiter = opts.limiter;
    this.budget = opts.budget ?? new UnitBudget();
    this.endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
    this.dryRun = opts.dryRun ?? false;
    this.httpOptions = opts.http ?? {};
  }

  /** Requests, units and ceiling so far (measured and estimated). */
  spend() {
    return this.budget.summary(CODEX_PROVIDER);
  }

  /** What a dry run would have called. Empty when not in dry-run mode. */
  plan(): DryRunPlan {
    const byOperation: Record<string, { requests: number; units: number }> = {};
    let totalUnits = 0;
    for (const c of this.planned) {
      const entry = (byOperation[c.operation] ??= { requests: 0, units: 0 });
      entry.requests += 1;
      entry.units += c.estimatedUnits;
      totalUnits += c.estimatedUnits;
    }
    return {
      calls: [...this.planned],
      byOperation,
      totalRequests: this.planned.length,
      totalUnits,
      lowerBoundOperations: [...this.lowerBound],
    };
  }

  // Discovery -----------------------------------------------------------

  /**
   * Walks graduated pump.fun tokens whose migration time is in `[from, to]`
   * (unix seconds, both inclusive), oldest first.
   *
   * Limits found against the live API (2026-11-14): `limit` at most 200, and
   * `limit + offset` at most 10,000, so one filter reaches at most 10,000
   * rows. The range is cut into windows (default one day). Inside a window
   * rows are paged 200 at a time. If a window still has rows at the depth
   * limit, the walk restarts from the last migration time it saw, inside the
   * same window, and rows already yielded are skipped by mint. Results are
   * ranked by migration time, which makes that restart possible.
   *
   * In dry-run mode this records one request per window (a lower bound, since
   * a busy window needs several pages) and yields nothing.
   */
  async *discoverGraduated(
    range: { from: number; to: number },
    opts: DiscoverOptions = {},
  ): AsyncGenerator<DiscoveredToken> {
    const windowSeconds = opts.windowSeconds ?? 86_400;
    const pageSize = opts.pageSize ?? FILTER_TOKENS_MAX_LIMIT;
    const maxDepth = opts.maxDepth ?? FILTER_TOKENS_MAX_DEPTH;
    if (!Number.isInteger(windowSeconds) || windowSeconds < 1) {
      throw new RangeError('windowSeconds must be a positive integer');
    }
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > FILTER_TOKENS_MAX_LIMIT) {
      throw new RangeError(`pageSize must be between 1 and ${FILTER_TOKENS_MAX_LIMIT}`);
    }
    if (!Number.isInteger(maxDepth) || maxDepth < pageSize) {
      throw new RangeError('maxDepth must be an integer of at least pageSize');
    }

    for (let start = range.from; start <= range.to; start += windowSeconds) {
      const end = Math.min(start + windowSeconds - 1, range.to);

      if (this.dryRun) {
        this.lowerBound.add('filterTokens');
        this.planned.push({
          operation: 'filterTokens',
          estimatedUnits: FILTER_BASE_UNITS + FILTER_UNITS_PER_TOKEN * pageSize,
          detail: `graduated ${start}..${end}`,
        });
        continue;
      }

      const seen = new Set<string>();
      let cursor = start;
      let offset = 0;
      for (;;) {
        const data = await this.call({
          operation: 'filterTokens',
          query: filterTokensQuery({ gte: cursor, lte: end, limit: pageSize, offset }),
          schema: filterTokensDataSchema,
          estimateBefore: FILTER_BASE_UNITS + FILTER_UNITS_PER_TOKEN * pageSize,
          estimateAfter: (d) =>
            FILTER_BASE_UNITS + FILTER_UNITS_PER_TOKEN * (d.filterTokens?.results?.length ?? 0),
          detail: `graduated ${cursor}..${end} offset ${offset}`,
        });
        const rows = data?.filterTokens?.results ?? [];
        let lastMigratedAt = cursor;
        for (const row of rows) {
          const info = launchInfoFrom(row.token);
          if (info.migratedAt !== null) lastMigratedAt = Math.max(lastMigratedAt, info.migratedAt);
          if (seen.has(info.mint)) continue;
          seen.add(info.mint);
          yield {
            ...info,
            pairAddress: row.pair?.address ?? null,
            liquidityUsd: row.liquidity ?? null,
          };
        }
        if (rows.length < pageSize) break;
        offset += pageSize;
        if (offset + pageSize > maxDepth) {
          // Depth limit reached with a full page: continue from the last time seen.
          if (lastMigratedAt <= cursor) {
            throw new Error(
              `Cannot page past ${maxDepth} graduated tokens sharing ` + `migration time ${cursor}`,
            );
          }
          cursor = lastMigratedAt;
          offset = 0;
        }
      }
    }
  }

  // Token launch info ---------------------------------------------------

  /** Launchpad fields for one mint, or null when Codex does not know it (always null in dry-run mode). */
  async getLaunchInfo(mint: string, meter?: CallMeter): Promise<LaunchInfo | null> {
    const data = await this.call({
      meter,
      operation: 'token',
      query: tokenQuery(mint),
      schema: tokenDataSchema,
      estimateBefore: FLAT_UNITS,
      estimateAfter: () => FLAT_UNITS,
      detail: mint,
    });
    return data?.token ? launchInfoFrom(data.token) : null;
  }

  // Pools ---------------------------------------------------------------

  /**
   * Every pool Codex lists for a token, oldest first. Codex caps the answer at
   * 250 pairs; when that many come back `truncated` is true and pools may be
   * missing, so a graduation pool chosen from this list by creation time is
   * unverified (see `pickGraduationPool`'s `truncated` field).
   */
  async getPools(mint: string, meter?: CallMeter): Promise<PoolsResult> {
    const data = await this.call({
      meter,
      operation: 'pairs',
      query: pairsQuery(mint),
      schema: pairsDataSchema,
      // Before the call assume a full 250-pair answer; after it, the count returned.
      estimateBefore: PAIRS_BASE_UNITS + UNITS_PER_RESULT * PAIRS_LIMIT,
      estimateAfter: (d) =>
        PAIRS_BASE_UNITS +
        UNITS_PER_RESULT * (d.listPairsWithMetadataForToken?.results?.length ?? 0),
      detail: mint,
    });
    const results = data?.listPairsWithMetadataForToken?.results ?? [];
    const pools: PoolInfo[] = results.map((r) => ({
      address: r.pair.address,
      pairId: pairIdFor(r.pair.address),
      exchange: r.exchange?.name ?? null,
      protocol: r.pair.protocol ?? null,
      createdAt: r.pair.createdAt ?? null,
      liquidityUsd: r.liquidity ?? null,
      quoteToken: r.backingToken?.symbol ?? r.backingToken?.address ?? r.quoteToken ?? null,
    }));
    pools.sort((a, b) => (a.createdAt ?? Infinity) - (b.createdAt ?? Infinity));
    return { pools, truncated: results.length >= PAIRS_LIMIT };
  }

  // Bars ----------------------------------------------------------------

  /**
   * Pool-level bars for `[from, to)` in unix seconds. The range is split into
   * windows of at most 1,500 buckets (see `planBarRequests`), requested in
   * order. Empty buckets are dropped, bars are de-duplicated on `t`, and the
   * result is sorted by `t`. Returns `[]` in dry-run mode.
   */
  async getPoolBars(args: {
    pairAddress: string;
    resolution: BarResolution;
    from: number;
    to: number;
    /** Counts this call's cost when given. */
    meter?: CallMeter;
  }): Promise<Bar[]> {
    const windows = planBarRequests(args);
    const all: Bar[] = [];
    for (const w of windows) {
      const data = await this.call({
        meter: args.meter,
        operation: 'bars',
        query: barsQuery(args.pairAddress, w.from, w.to, args.resolution),
        schema: barsDataSchema,
        estimateBefore: FLAT_UNITS,
        estimateAfter: () => FLAT_UNITS,
        detail: `${args.pairAddress} res ${args.resolution} ${w.from}..${w.to}`,
      });
      all.push(...barsFromColumns(data?.getBars));
    }
    if (windows.length === 0) return [];
    const lo = windows[0]!.from;
    const hi = windows[windows.length - 1]!.to;
    return sortAndDedupeBars(all).filter((b) => b.t >= lo && b.t <= hi);
  }

  // Plumbing ------------------------------------------------------------

  private meterCall(meter: CallMeter | undefined, entries: readonly SpendEntry[]): void {
    if (!meter) return;
    meter.requests += 1;
    for (const e of entries) meter.units += e.units;
  }

  /** Runs one GraphQL request. Returns null in dry-run mode (after recording the plan). */
  private async call<S extends z.ZodType>(spec: CallSpec<S>): Promise<z.infer<S> | null> {
    if (this.dryRun) {
      this.planned.push({
        operation: spec.operation,
        estimatedUnits: spec.estimateBefore,
        detail: spec.detail,
      });
      return null;
    }

    // Held until the request settles, so concurrent calls cannot overshoot the ceiling.
    const reservation = this.budget.reserve(CODEX_PROVIDER, spec.estimateBefore);
    let attempts = 1;
    // Cost recorded if the call fails: every attempt is assumed to have been charged.
    const failed = (): SpendEntry[] =>
      Array.from({ length: attempts }, () => ({ units: spec.estimateBefore, estimated: true }));

    try {
      const base: FetchLike = this.fetchImpl ?? ((url, init) => fetch(url, init));
      const limiter = this.limiter;
      // An HTTP 429 tells the shared limiter to slow every caller down, not just this one's retry.
      const limited: FetchLike = limiter
        ? async (url, init) => {
            const res = await limiter.run(() => base(url, init));
            if (res.status === 429) {
              limiter.penalize({ retryAfterMs: parseRetryAfter(res.headers.get('retry-after')) });
            }
            return res;
          }
        : base;

      let response;
      try {
        response = await postJson(
          this.endpoint,
          { query: spec.query },
          { ...this.httpOptions, fetch: limited, headers: { Authorization: this.apiKey } },
        );
      } catch (err) {
        if (err instanceof HttpError) attempts = err.attempts;
        throw err;
      }
      attempts = response.attempts;

      let json: unknown;
      try {
        json = JSON.parse(response.body);
      } catch {
        throw new CodexResponseError(spec.operation, ['response was not JSON']);
      }
      const envelope = graphqlEnvelopeSchema.safeParse(json);
      if (!envelope.success)
        throw new CodexResponseError(spec.operation, issueList(envelope.error));
      if (envelope.data.errors && envelope.data.errors.length > 0) {
        const retryAfter = envelope.data.errors
          .map((e) => e.extensions?.['retryAfterSeconds'])
          .find((v): v is number => typeof v === 'number' && v >= 0);
        const error = new CodexGraphQLError(
          envelope.data.errors.map((e) => e.message),
          envelope.data.errors.map((e) => String(e.extensions?.['code'] ?? '')).filter(Boolean),
          retryAfter ?? null,
        );
        // A rate-limit answer inside a 200 slows the run down the same way a 429 does.
        if (error.rateLimited) {
          limiter?.penalize({
            retryAfterMs: retryAfter === undefined ? null : Math.round(retryAfter * 1000),
          });
        }
        throw error;
      }
      const parsed = spec.schema.safeParse(envelope.data.data);
      if (!parsed.success) throw new CodexResponseError(spec.operation, issueList(parsed.error));

      const data = parsed.data as z.infer<S>;
      const reported = reportedUnits(data);
      // Earlier attempts (429 or 5xx) are assumed charged at the estimate; the last one at its reported cost.
      const earlier = failed().slice(0, attempts - 1);
      const entries: SpendEntry[] = [
        ...earlier,
        reported !== null
          ? { units: reported, estimated: false }
          : { units: spec.estimateAfter(data), estimated: true },
      ];
      this.budget.settle(reservation, entries);
      this.meterCall(spec.meter, entries);
      return data;
    } catch (err) {
      const entries = failed();
      this.budget.settle(reservation, entries);
      this.meterCall(spec.meter, entries);
      throw err;
    }
  }
}

function issueList(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
}

/**
 * `usageData.total.computeUnits` is micro-units (5014400 means 5.0144 units).
 * Returns null when the response carries no cost.
 */
function reportedUnits(data: unknown): number | null {
  const micro = (data as { usageData?: { total?: { computeUnits?: number | null } | null } | null })
    ?.usageData?.total?.computeUnits;
  return typeof micro === 'number' ? micro / 1e6 : null;
}
