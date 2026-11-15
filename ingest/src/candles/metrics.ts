import { computeAndStoreCoinMetrics, type CoinStatus } from '@memecoinipedia/db';
import { computeCoinMetrics } from '../metrics/index.js';
import type { MetricResult } from '../metrics/types.js';
import type { CandleDeps } from './types.js';

/** Stored in `coins.metrics_version`. Raise it when docs/metrics.md or the status rule changes. */
export const METRICS_VERSION = 1;

export type ComputeMetricsResult =
  | {
      ok: true;
      /** Observation time used, unix seconds. */
      asOf: number;
      result: MetricResult;
      status: CoinStatus;
      metricsVersion: number;
      /** Bars read, all pools and resolutions. */
      barCount: number;
    }
  | {
      ok: false;
      /** `coin_not_found`, `missing_launch_time` or `no_candles`. */
      reason: string;
      /** False: none of these is fixed by trying again; run the candle stage first. */
      retry: boolean;
      message: string;
    };

/** See the header of ./index.ts. */
export async function computeMetricsForCoin(
  deps: Pick<CandleDeps, 'db' | 'clock'>,
  coin: { id: number },
): Promise<ComputeMetricsResult> {
  const now = deps.clock();
  const asOf = Math.floor(now.getTime() / 1000);
  const out = await computeAndStoreCoinMetrics(deps.db, coin.id, {
    compute: computeCoinMetrics,
    asOf,
    computedAt: now,
    metricsVersion: METRICS_VERSION,
  });
  if (!out.ok) {
    const message =
      out.reason === 'no_candles'
        ? 'No bars are stored for this coin; fetch its candles first'
        : out.reason === 'missing_launch_time'
          ? 'The coin has no launch time'
          : `No coin with id ${coin.id}`;
    return { ok: false, reason: out.reason, retry: false, message };
  }
  return {
    ok: true,
    asOf,
    // The shape is the library's own; the db layer only knows it structurally.
    result: out.result as MetricResult,
    status: out.status,
    metricsVersion: METRICS_VERSION,
    barCount: out.barCount,
  };
}
