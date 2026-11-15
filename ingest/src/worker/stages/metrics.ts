/**
 * The `metrics` stage: compute a coin's metrics from its stored bars and write
 * them to the `coins` row. It wraps `computeMetricsForCoin` and makes no
 * provider call.
 *
 * The stage version is `METRICS_VERSION` from the candle module, so a change to the
 * metric rules (which raises that number) runs coins that are done again, with no edit here.
 * A coin with no bar in any pool that counts is `done` too, with a null ATH and the flag `no_candles`
 * (`noCandlesResult`). The stage requires `candles` (see `STAGE_REQUIRES`): a coin whose
 * candles failed is not given metrics.
 *
 * Reopening. Metric rules versions 4 and 5 can only lower an ATH, so a coin fetched under an older
 * version can come out with `peak_outside_minute_coverage` for a period it holds no 1-minute bars
 * for. When the result carries the flag, a target of it is at or above `refineFromUsd`, and the
 * coin's candles are `done` without the hourly cap hit and were fetched under a candle rules
 * version older than `CANDLE_RULES_VERSION` (or none recorded), the stage ends `done` and asks for
 * `candles` and `metrics` to go back to pending: candles fetches the missing minutes, metrics
 * recomputes. The refetch records the current `METRICS_VERSION` in the candles detail, so a flag
 * that survives it reopens nothing. A rules version that only adds an output (version 6) does not
 * raise `CANDLE_RULES_VERSION`, so it reopens nothing.
 */
import { loadMetricInput } from '@memecoinipedia/db';
import {
  CANDLE_RULES_VERSION,
  computeMetricsForCoin,
  DEFAULT_PLAN_LIMITS,
  findCoveragePeaks,
  METRICS_VERSION,
} from '../../candles/index.js';
import { done, doneAndReopen, failed, type Stage, type StageContext } from '../stage.js';

const COVERAGE_FLAG = 'peak_outside_minute_coverage';

/** Candles `done`, no hourly cap hit, and fetched under an older metrics version (or none recorded). */
async function candlesCanBeRefetched(ctx: StageContext, coinId: number): Promise<boolean> {
  const row = await ctx.db
    .selectFrom('coin_stages')
    .select(['status', 'detail'])
    .where('coin_id', '=', coinId)
    .where('stage', '=', 'candles')
    .executeTakeFirst();
  if (!row || row.status !== 'done') return false;
  const detail = (row.detail ?? {}) as { hourlyCapHit?: unknown; metricsVersion?: unknown };
  if (detail.hourlyCapHit === true) return false;
  return typeof detail.metricsVersion !== 'number' || detail.metricsVersion < CANDLE_RULES_VERSION;
}

export const metricsStage: Stage = {
  name: 'metrics',
  version: METRICS_VERSION,
  async run(ctx, coin) {
    const result = await computeMetricsForCoin({ db: ctx.db, clock: ctx.now }, { id: coin.id });
    if (!result.ok) return failed(`${result.reason}: ${result.message}`, result.retry);
    // A coin with no bar in any pool that counts ends `done` with a null ATH and the `no_candles` flag:
    // retrying cannot make bars appear, so it is neither failed nor retried.
    const leftOut =
      result.sidePoolsLeftOut > 0 ? { sidePoolsLeftOut: result.sidePoolsLeftOut } : {};
    if (result.noCandles) return done({ noCandles: true, ...leftOut });
    if (
      (result.result.flags as string[]).includes(COVERAGE_FLAG) &&
      (await candlesCanBeRefetched(ctx, coin.id))
    ) {
      const loaded = await loadMetricInput(ctx.db, coin.id, result.asOf);
      if (loaded.ok) {
        const worthFetching = findCoveragePeaks(loaded.input).some(
          (x) => x.highUsd === undefined || x.highUsd >= DEFAULT_PLAN_LIMITS.refineFromUsd,
        );
        if (worthFetching) {
          return doneAndReopen({ reopenedCandles: true, ...leftOut }, ['candles', 'metrics']);
        }
      }
    }
    return result.sidePoolsLeftOut > 0 ? done(leftOut) : done();
  },
};
