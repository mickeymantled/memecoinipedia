/**
 * The `candles` stage: fetch and store a coin's price bars from Codex.io, with
 * the staged plan in `src/candles` (screen, then light or full path).
 *
 * It wraps `fetchCandlesForCoin` and changes nothing in it. What it adds:
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
 * Data issues: the fetcher records `graduation_pool_not_found`,
 * `candle_hourly_cap_hit` and `peak_refinement_incomplete`. They belong to this
 * stage (`CANDLES_ISSUE_KINDS`), and no other stage writes or removes them.
 */
import { getCoinPools } from '@memecoinipedia/db';
import { fetchCandlesForCoin } from '../../candles/index.js';
import type { CandleFetchSummary } from '../../candles/index.js';
import { FLAT_UNITS, RATE_LIMIT_MESSAGE, type CodexClient } from '../../sources/codex/index.js';
import { failed, done, type Stage, type StageResult } from '../stage.js';

export const CANDLES_STAGE_VERSION = 1;
/** A large coin makes about 40 requests one after another. */
export const CANDLES_TIMEOUT_SECONDS = 600;
/** Issue kinds the candles stage owns. */
export const CANDLES_ISSUE_KINDS = [
  'graduation_pool_not_found',
  'candle_hourly_cap_hit',
  'peak_refinement_incomplete',
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
  hourlyCapHit: boolean;
}

/** The small JSON kept on the stage row. Well under 1 KB: counters and flags only. */
export function candlesDetail(
  summary: CandleFetchSummary,
  launchInfoNamedPool: boolean | null,
): CandlesDetail {
  return {
    path: summary.path,
    w: summary.w === null ? null : Math.round(summary.w * 100) / 100,
    escalated: summary.escalated,
    units: Math.round(summary.units * 1e4) / 1e4,
    lookupRequests: summary.lookupRequests,
    // `requests` counts the refinement requests too; they are reported on their own.
    barRequests: Math.max(0, summary.requests - summary.refinementRounds),
    refinementRequests: summary.refinementRounds,
    launchInfoNamedPool,
    hourlyCapHit: summary.hourlyCapHit,
  };
}

/**
 * The client with each launch-info and pool-list call noted, per coin, so the stage can tell
 * whether launch info named the graduation pool without asking the fetcher to say so.
 */
function tracked(codex: CodexClient, calls: string[]): CodexClient {
  return new Proxy(codex, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      const fn = value as (...args: unknown[]) => unknown;
      if (prop === 'getLaunchInfo' || prop === 'getPools') {
        return (...args: unknown[]) => {
          calls.push(prop);
          return fn.apply(target, args);
        };
      }
      return fn.bind(target);
    },
  });
}

export interface CandlesStageDeps {
  /** The run's one client, with the run's budget. */
  codex: CodexClient;
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
      const calls: string[] = [];
      // Stage 0 (launch info, maybe the pool list) happens only for a coin with no stored pool.
      const stage0 = (await getCoinPools(ctx.db, coin.id)).length === 0;
      const result = await fetchCandles(
        { db: ctx.db, codex: tracked(deps.codex, calls), clock: ctx.now },
        { id: coin.id, address: coin.address, chain: coin.chain },
      );
      if (result.ok) {
        const named = stage0 ? calls[0] === 'getLaunchInfo' && calls[1] !== 'getPools' : null;
        return done(candlesDetail(result.summary, named));
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
