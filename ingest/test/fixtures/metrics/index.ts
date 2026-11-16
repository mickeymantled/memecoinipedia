import type { MetricFixture } from '../../../src/metrics/types.js';
import { metricFixturesV6 } from './near-ath.js';
import { athBeforeLaunch } from './ath-before-launch.js';
import { badBarsDroppedFlagOrder } from './bad-bars-dropped-flag-order.js';
import { badPrint50xUnderLimitWickOnly } from './bad-print-50x-under-limit-wick-only.js';
import { barAtAsOfCountsLastHoldZero } from './bar-at-asof-counts-last-hold-zero.js';
import { busierPoolBeatsHigherPrice } from './busier-pool-beats-higher-price.js';
import { busierSingleBarWindowHidesStrictWindow } from './busier-single-bar-window-hides-strict-window.js';
import { dailySuppressedByHourly } from './daily-suppressed-by-hourly.js';
import { deadTailMinuteThenDaily } from './dead-tail-minute-then-daily.js';
import { decimalsErrorAbove20BillionDropped } from './decimals-error-above-20-billion-dropped.js';
import { duplicateBarKeepsLast } from './duplicate-bar-keeps-last.js';
import { duplicateWithBadLastBar } from './duplicate-with-bad-last-bar.js';
import { equalVolumePrimaryPoolWins } from './equal-volume-primary-pool-wins.js';
import { equalVolumeSmallestAddressWins } from './equal-volume-smallest-address-wins.js';
import { exactMarketCapThresholds } from './exact-market-cap-thresholds.js';
import { exactSecondaryLiquidity5000 } from './exact-secondary-liquidity-5000.js';
import { exactWindowTraders5 } from './exact-window-traders-5.js';
import { exactWindowVolume1000 } from './exact-window-volume-1000.js';
import { exactly20BillionKept } from './exactly-20-billion-kept.js';
import { gapLongerThan24hCarryForward } from './gap-longer-than-24h-carry-forward.js';
import { healthySinglePool } from './healthy-single-pool.js';
import { hourlyNotSuppressedByDroppedMinuteBar } from './hourly-not-suppressed-by-dropped-minute-bar.js';
import { hourlyOnlyNoAthCoverageFlag } from './hourly-only-no-ath-coverage-flag.js';
import { hourlySuppressedAndStrictHourlyRaisesLevel } from './hourly-suppressed-and-strict-hourly-raises-level.js';
import { hourlySuppressedByOtherPoolMinuteBar } from './hourly-suppressed-by-other-pool-minute-bar.js';
import { isolatedBarAfterGap } from './isolated-bar-after-gap.js';
import { justBelowVolumeAndTraders } from './just-below-volume-and-traders.js';
import { lastHoldEndsAtAsOf } from './last-hold-ends-at-asof.js';
import { lowVolumeWindowNotStrict } from './low-volume-window-not-strict.js';
import { migrationToSecondPool } from './migration-to-second-pool.js';
import { noQualifyingWindow } from './no-qualifying-window.js';
import { paramsMaxMarketCap } from './params-max-market-cap.js';
import { paramsRug } from './params-rug.js';
import { paramsWindow5AndThresholds } from './params-window-5-and-thresholds.js';
import { rugCancelledByStrictRecovery } from './rug-cancelled-by-strict-recovery.js';
import { rugFallExactlyAt30Minutes } from './rug-fall-exactly-at-30-minutes.js';
import { rugFalseFallTooSlow } from './rug-false-fall-too-slow.js';
import { rugFromOneThinLowPrint } from './rug-from-one-thin-low-print.js';
import { rugPatternTrue } from './rug-pattern-true.js';
import { rugThinRecoveryDoesNotCancel } from './rug-thin-recovery-does-not-cancel.js';
import { sidePoolsLowOrNullLiquidityIgnored } from './side-pools-low-or-null-liquidity-ignored.js';
import { singleCandleSpike } from './single-candle-spike.js';
import { sparseWindowTwoBars120sApart } from './sparse-window-two-bars-120s-apart.js';
import { spikeHeldTwoClosesOfThree } from './spike-held-two-closes-of-three.js';
import { strictHourlyBelowAthNoCoverageFlag } from './strict-hourly-below-ath-no-coverage-flag.js';
import { thinHigherPrintKeepsLevel } from './thin-higher-print-keeps-level.js';
import { thinLowerPrintLowersLevel } from './thin-lower-print-lowers-level.js';
import { tradersIsMaxNotSum } from './traders-is-max-not-sum.js';
import { twoWalletWashLowTraders } from './two-wallet-wash-low-traders.js';
import { unsortedInputAndBarsAfterAsOf } from './unsorted-input-and-bars-after-asof.js';
import { wickTieSmallestAddress } from './wick-tie-smallest-address.js';
import { athHourVolumeSumsAllPoolsAndWindowEdges } from './ath-hour-volume-sums-all-pools-and-window-edges.js';
import { drainedHourRaisesCoverageFlag } from './drained-hour-raises-coverage-flag.js';
import { exactWindowLiquidity5000 } from './exact-window-liquidity-5000.js';
import { hourAfterDrainDoesNotRaiseCoverageFlag } from './hour-after-drain-does-not-raise-coverage-flag.js';
import { neverFundedPoolCannotSetAthAndLowersLevel } from './never-funded-pool-cannot-set-ath-and-lowers-level.js';
import { poolDumpedInAthMinuteKeepsAthAndRugPattern } from './pool-dumped-in-ath-minute-keeps-ath-and-rug-pattern.js';
import { unknownLiquidityCountsAsFunded } from './unknown-liquidity-counts-as-funded.js';
import { wickIgnoresWildHighAndThinMinutes } from './wick-ignores-wild-high-and-thin-minutes.js';

/**
 * Every hand-worked metric fixture. Each case lives in its own file in this
 * folder and is added to this list. The metric library's fixture test runs
 * all of them.
 *
 * Expected values were worked by hand from docs/metrics.md, never from code.
 * Compare market caps and drawdowns with a small relative tolerance.
 */
export const metricFixtures: MetricFixture[] = [
  healthySinglePool,
  singleCandleSpike,
  spikeHeldTwoClosesOfThree,
  lowVolumeWindowNotStrict,
  twoWalletWashLowTraders,
  tradersIsMaxNotSum,
  exactWindowVolume1000,
  exactWindowTraders5,
  justBelowVolumeAndTraders,
  exactSecondaryLiquidity5000,
  exactMarketCapThresholds,
  sparseWindowTwoBars120sApart,
  isolatedBarAfterGap,
  gapLongerThan24hCarryForward,
  lastHoldEndsAtAsOf,
  barAtAsOfCountsLastHoldZero,
  thinLowerPrintLowersLevel,
  thinHigherPrintKeepsLevel,
  migrationToSecondPool,
  sidePoolsLowOrNullLiquidityIgnored,
  busierPoolBeatsHigherPrice,
  equalVolumePrimaryPoolWins,
  equalVolumeSmallestAddressWins,
  wickTieSmallestAddress,
  busierSingleBarWindowHidesStrictWindow,
  decimalsErrorAbove20BillionDropped,
  exactly20BillionKept,
  badPrint50xUnderLimitWickOnly,
  badBarsDroppedFlagOrder,
  duplicateBarKeepsLast,
  duplicateWithBadLastBar,
  unsortedInputAndBarsAfterAsOf,
  deadTailMinuteThenDaily,
  hourlySuppressedAndStrictHourlyRaisesLevel,
  strictHourlyBelowAthNoCoverageFlag,
  hourlyOnlyNoAthCoverageFlag,
  dailySuppressedByHourly,
  hourlySuppressedByOtherPoolMinuteBar,
  hourlyNotSuppressedByDroppedMinuteBar,
  rugPatternTrue,
  rugCancelledByStrictRecovery,
  rugThinRecoveryDoesNotCancel,
  rugFalseFallTooSlow,
  rugFallExactlyAt30Minutes,
  rugFromOneThinLowPrint,
  noQualifyingWindow,
  athBeforeLaunch,
  paramsWindow5AndThresholds,
  paramsRug,
  paramsMaxMarketCap,
  athHourVolumeSumsAllPoolsAndWindowEdges,
  drainedHourRaisesCoverageFlag,
  exactWindowLiquidity5000,
  hourAfterDrainDoesNotRaiseCoverageFlag,
  neverFundedPoolCannotSetAthAndLowersLevel,
  poolDumpedInAthMinuteKeepsAthAndRugPattern,
  unknownLiquidityCountsAsFunded,
  wickIgnoresWildHighAndThinMinutes,
];

/** Every hand-worked fixture: the version 5 set, then the version 6 set (`near-ath.ts`). */
export const allMetricFixtures: MetricFixture[] = [...metricFixtures, ...metricFixturesV6];

export { metricFixturesV6 };
