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
import { UnitBudget } from '../budget.js';
import { postJson, type FetchLike, type PostJsonOptions } from '../http.js';
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

/** Documented flat cost of a bars, token or pairs request, in compute units. */
export const FLAT_UNITS = 4;
/** filterTokens: base cost plus about this much per token returned. */
export const FILTER_BASE_UNITS = 5;
export const FILTER_UNITS_PER_TOKEN = 0.004;

export class CodexGraphQLError extends Error {
  readonly messages: string[];
  readonly codes: string[];

  constructor(messages: string[], codes: string[]) {
    super(`Codex GraphQL error: ${messages.join('; ')}`);
    this.name = 'CodexGraphQLError';
    this.messages = messages;
    this.codes = codes;
  }
}

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

interface CallSpec<S extends z.ZodType> {
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
  async getLaunchInfo(mint: string): Promise<LaunchInfo | null> {
    const data = await this.call({
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
   * 250 pairs; when that many come back `truncated` is true and older or
   * smaller pools may be missing.
   */
  async getPools(mint: string): Promise<PoolsResult> {
    const data = await this.call({
      operation: 'pairs',
      query: pairsQuery(mint),
      schema: pairsDataSchema,
      estimateBefore: FLAT_UNITS,
      estimateAfter: () => FLAT_UNITS,
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
  }): Promise<Bar[]> {
    const windows = planBarRequests(args);
    const all: Bar[] = [];
    for (const w of windows) {
      const data = await this.call({
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

    this.budget.assertCanSpend(CODEX_PROVIDER, spec.estimateBefore);

    const base: FetchLike = this.fetchImpl ?? ((url, init) => fetch(url, init));
    const limiter = this.limiter;
    const limited: FetchLike = limiter ? (url, init) => limiter.run(() => base(url, init)) : base;

    let response;
    try {
      response = await postJson(
        this.endpoint,
        { query: spec.query },
        { ...this.httpOptions, fetch: limited, headers: { Authorization: this.apiKey } },
      );
    } catch (err) {
      // The request may have been made even though it failed; count it with no known cost.
      this.budget.record(CODEX_PROVIDER, 0, false);
      throw err;
    }

    let json: unknown;
    try {
      json = JSON.parse(response.body);
    } catch {
      this.budget.record(CODEX_PROVIDER, 0, false);
      throw new CodexResponseError(spec.operation, ['response was not JSON']);
    }
    const envelope = graphqlEnvelopeSchema.safeParse(json);
    if (!envelope.success) {
      this.budget.record(CODEX_PROVIDER, 0, false);
      throw new CodexResponseError(spec.operation, issueList(envelope.error));
    }
    if (envelope.data.errors && envelope.data.errors.length > 0) {
      this.budget.record(CODEX_PROVIDER, 0, false);
      throw new CodexGraphQLError(
        envelope.data.errors.map((e) => e.message),
        envelope.data.errors.map((e) => String(e.extensions?.['code'] ?? '')).filter(Boolean),
      );
    }

    const parsed = spec.schema.safeParse(envelope.data.data);
    if (!parsed.success) {
      this.budget.record(CODEX_PROVIDER, spec.estimateBefore, true);
      throw new CodexResponseError(spec.operation, issueList(parsed.error));
    }
    const data = parsed.data as z.infer<S>;
    const reported = reportedUnits(data);
    if (reported !== null) this.budget.record(CODEX_PROVIDER, reported, false);
    else this.budget.record(CODEX_PROVIDER, spec.estimateAfter(data), true);
    return data;
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
