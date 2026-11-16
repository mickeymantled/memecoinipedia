/**
 * The `candles` stage: fetch and store a coin's price bars from Codex.io, with
 * the staged plan in `src/candles` (screen, then light or full path).
 *
 * It wraps `fetchCandlesForCoin`. What it adds:
 *
 * - One `CodexClient` for the whole run, shared by every worker. Its unit
 *   budget is the run's ceiling (`--max-codex-units`) and its rate limiter is the
 *   only rate limit.
 * - A ceiling stop. When a coin's fetch is refused for budget (`budget_exhausted`)
 *   the stage closes: coins already in flight finish or fail with `retry: true`
 *   (and the attempt is given back), no new coin is claimed, and a later run with a
 *   higher ceiling continues. Bars and coverage already stored are kept, so no
 *   coin is fetched twice.
 * - A per-coin `detail` on the stage row (see `candlesDetail`).
 *
 * Data issues: the fetcher finds `graduation_pool_not_found`, `graduation_pool_late`,
 * `candle_hourly_cap_hit` and `peak_refinement_incomplete` and returns them; the stage writes them with `replaceCoinIssues`.
 * They belong to this stage (`CANDLES_ISSUE_KINDS`), and no other stage writes or removes them.
 * A run replaces only the kinds it examined to the end (`issueKindsChecked`), so one that finds
 * no hourly cap hit clears an old `candle_hourly_cap_hit`, while a run that did not list the
 * pools leaves `graduation_pool_not_found` as it was.
 */
import { replaceCoinIssues } from '@memecoinipedia/db';
import { fetchCandlesForCoin, METRICS_VERSION } from '../../candles/index.js';
import type { CandleFetchSummary } from '../../candles/index.js';
import { FLAT_UNITS, RATE_LIMIT_MESSAGE, type CodexClient } from '../../sources/codex/index.js';
import { failed, done, doneAndReopen, type Stage, type StageResult } from '../stage.js';

export const CANDLES_STAGE_VERSION = 1;
/** A large coin makes about 40 requests one after another. */
export const CANDLES_TIMEOUT_SECONDS = 600;
/** Issue kinds the candles stage owns. */
export const CANDLES_ISSUE_KINDS = [
  'graduation_pool_not_found',
  'graduation_pool_late',
  'candle_hourly_cap_hit',
  'peak_refinement_incomplete',
  /** A top-up read a list that would move the graduation role; a refresh settles it (issue #87). */
  'graduation_pool_differs',
] as const;

export interface CandlesDetail extends Record<string, unknown> {
  path: CandleFetchSummary['path'];
  w: number | null;
  escalated: boolean;
  /** Compute units this coin's calls cost in the run that finished the stage. */
  units: number;
  /** Launch-info and pool-list requests. */
  lookupRequests: number;
  /** Bars requests, peak refinement not included. */
  barRequests: number;
  refinementRequests: number;
  /**
   * True when launch info named the graduation pool, so the pool-list lookup was not needed at
   * stage 0. Null when stage 0 happened in an earlier run (a coin resumed after a stop).
   */
  launchInfoNamedPool: boolean | null;
  /**
   * Pools of the coin's pool list left out because their quote token is not SOL, USDC or USDT, or
   * because another coin owns the address. The bonding curve and the graduation pool are never
   * left out. Null when no pool list was looked up in the run that finished the stage. No addresses.
   */
  otherQuotePools: number | null;
  /** Pools moved to this coin from a coin that held them as ordinary other pools. No addresses. */
  poolsTakenOver: number;
  /** Pools a refresh added to the coin's list. Their bars are fetched, and metrics reopen. */
  poolsAdded: number;
  /** The refresh moved the graduation role to another pool; metrics reopen. */
  graduationMoved: boolean;
  hourlyCapHit: boolean;
  /**
   * The `METRICS_VERSION` the fetch's peak refinement ran under. The metrics stage reopens a coin
   * whose flag survives a recompute only when this is lower than its own version, so a coin is
   * refetched once per rules version and never in a loop.
   */
  metricsVersion: number;
}

/** The small JSON kept on the stage row. Well under 1 KB: counters and flags only. */
export function candlesDetail(summary: CandleFetchSummary): CandlesDetail {
  return {
    path: summary.path,
    w: summary.w === null ? null : Math.round(summary.w * 100) / 100,
    escalated: summary.escalated,
    units: Math.round(summary.units * 1e4) / 1e4,
    lookupRequests: summary.lookupRequests,
    // `requests` counts the refinement requests too; they are reported on their own.
    barRequests: Math.max(0, summary.requests - summary.refinementRounds),
    refinementRequests: summary.refinementRounds,
    launchInfoNamedPool: summary.launchInfoNamedPool,
    otherQuotePools: summary.otherQuotePools,
    poolsTakenOver: summary.poolsTakenOver,
    poolsAdded: summary.poolsAdded,
    graduationMoved: summary.graduationMoved,
    hourlyCapHit: summary.hourlyCapHit,
    metricsVersion: METRICS_VERSION,
  };
}

export interface CandlesStageDeps {
  /** The run's one client, with the run's budget. */
  codex: CodexClient;
  /**
   * True for coins whose pool list is to be listed again (a refresh run). The candles stage of such
   * a coin is first put back to pending by the run. Absent: no coin is refreshed.
   */
  refreshPools?: (coinId: number) => boolean;
  /**
   * True for a coin whose old pool list the live top-up reads again (issue #87), asked once as the
   * stage takes the coin. The list request is made through the same path as a refresh, but bars go
   * on to the clock and the graduation role is left alone. Absent: no coin is.
   */
  topUpPools?: (coinId: number) => boolean;
  /** Test seam. */
  fetchCandles?: typeof fetchCandlesForCoin;
}

export interface CandlesStage extends Stage {
  /** True once the unit ceiling stopped the stage. */
  readonly stopped: boolean;
  /** Why it stopped, for the run summary; null when it has not. */
  readonly stopReason: string | null;
}

export function createCandlesStage(deps: CandlesStageDeps): CandlesStage {
  const fetchCandles = deps.fetchCandles ?? fetchCandlesForCoin;
  let stopReason: string | null = null;

  const stop = (reason: string): void => {
    stopReason ??= reason;
  };

  return {
    name: 'candles',
    version: CANDLES_STAGE_VERSION,
    timeoutSeconds: CANDLES_TIMEOUT_SECONDS,
    get stopped() {
      return stopReason !== null;
    },
    get stopReason() {
      return stopReason;
    },
    admit() {
      if (stopReason !== null) return false;
      // Not even one request fits under the ceiling: stop before claiming a coin.
      const { remaining } = deps.codex.spend();
      if (remaining !== null && remaining < FLAT_UNITS) {
        stop(`${remaining.toFixed(2)} units left under the ceiling`);
        return false;
      }
      return true;
    },
    async run(ctx, coin): Promise<StageResult> {
      const result = await fetchCandles(
        { db: ctx.db, codex: deps.codex, clock: ctx.now },
        {
          id: coin.id,
          address: coin.address,
          chain: coin.chain,
          ...(deps.refreshPools?.(coin.id)
            ? { refreshPools: true }
            : deps.topUpPools?.(coin.id)
              ? { refreshPools: 'top-up' as const }
              : {}),
        },
      );
      // The issues this run found replace the stage's own open ones (only the kinds it examined).
      const { issueRecords, issueKindsChecked } = result.summary;
      const owned = new Set<string>([...issueKindsChecked, ...issueRecords.map((i) => i.kind)]);
      await replaceCoinIssues(
        ctx.db,
        coin.id,
        CANDLES_ISSUE_KINDS.filter((k) => owned.has(k)),
        issueRecords,
      );
      if (result.ok) {
        const detail = candlesDetail(result.summary);
        // Pools were added or moved in: the coin's metrics were computed without them.
        return result.summary.poolsAdded > 0 || result.summary.graduationMoved
          ? doneAndReopen(detail, ['metrics'])
          : done(detail);
      }
      if (result.reason === 'budget_exhausted') {
        stop(result.message);
        // The run's ceiling, not this coin's fault: retry in a later run, and do not count the attempt.
        return failed(`budget_exhausted: ${result.message}`, true, true);
      }
      if (result.retry && RATE_LIMIT_MESSAGE.test(result.message)) {
        // The provider said "slow down" (the client has already slowed the whole run). That is the
        // run's doing, not this coin's: retry it, and do not count the attempt.
        return failed(`rate_limited: ${result.message}`, true, true);
      }
      return failed(`${result.reason}: ${result.message}`, result.retry);
    },
  };
}
