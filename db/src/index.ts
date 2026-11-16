export { createDb } from './client.js';
export { migrate, DEFAULT_MIGRATIONS_DIR } from './migrate.js';
export type { MigrateOptions, MigrateResult } from './migrate.js';
export { putBars, getBars, chunkSpan, chunkStartOf, CHUNK_BARS } from './candles.js';
export type { CandleBar, Resolution, BarRange } from './candles.js';
export { upsertCoin } from './coins.js';
export type { CoinIdentity } from './coins.js';
export { addCoverage, getCoverage, countCoverageRequests } from './candleCoverage.js';
export type { CoverageInterval } from './candleCoverage.js';
export { upsertPool, getCoinPools, refreshPoolBarStats } from './pools.js';
export type { PoolInput, StoredPool } from './pools.js';
export { recordDataIssue } from './dataIssues.js';
export {
  loadMetricInput,
  writeCoinMetrics,
  computeAndStoreCoinMetrics,
  decideStatus,
  STATUS_RULES,
} from './coinMetrics.js';
export type {
  MetricInputShape,
  MetricPoolInput,
  MetricResultShape,
  CoinStatus,
  LoadedMetricInput,
  StoreMetricsOutcome,
  WriteMetricsContext,
} from './coinMetrics.js';
export { seed } from './seed.js';
export { databaseShape } from './types.js';
export type * from './types.js';
