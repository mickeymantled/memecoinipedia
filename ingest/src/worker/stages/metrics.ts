/**
 * The `metrics` stage: compute a coin's metrics from its stored bars and write
 * them to the `coins` row. It wraps `computeMetricsForCoin` and makes no
 * provider call.
 *
 * The stage version is `METRICS_VERSION` from the candle module, so a change to the
 * metric rules (which raises that number) runs coins that are done again, with no edit here.
 * A coin with no stored bar is `done` too, with a null ATH and the flag `no_candles`
 * (`noCandlesResult`). The stage requires `candles` (see `STAGE_REQUIRES`): a coin whose candles failed
 * is not given metrics.
 */
import { computeMetricsForCoin, METRICS_VERSION } from '../../candles/index.js';
import { done, failed, type Stage } from '../stage.js';

export const metricsStage: Stage = {
  name: 'metrics',
  version: METRICS_VERSION,
  async run(ctx, coin) {
    const result = await computeMetricsForCoin({ db: ctx.db, clock: ctx.now }, { id: coin.id });
    // A coin with no stored bar at all ends `done` with a null ATH and the `no_candles` flag:
    // retrying cannot make bars appear, so it is neither failed nor retried.
    if (result.ok) return result.noCandles ? done({ noCandles: true }) : done();
    return failed(`${result.reason}: ${result.message}`, result.retry);
  },
};
