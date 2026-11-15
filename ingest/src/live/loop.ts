/**
 * The scheduler: one `tick()` looks at the clock and runs whichever passes are due. The process
 * calls it every `TICK_SECONDS`; a test calls it with a fake clock and moves the clock between
 * calls. Nothing here waits.
 *
 * Passes run one after another inside a tick (discovery, then watch, then sweep), so a coin
 * discovered this tick is polled in the same tick. A pass that throws is logged and does not stop
 * the others, nor the next tick.
 */
import { listWaitingCandles } from '@memecoinipedia/db';
import {
  DISCOVERY_INTERVAL_SECONDS,
  REQUEUE_WAITING_SECONDS,
  SWEEP_RETRY_SECONDS,
  WATCH_PASS_SECONDS,
} from './constants.js';
import type { LiveDeps } from './deps.js';
import { discoverOnce, type DiscoveryPass } from './discover.js';
import { refreshOnce, type RefreshPass } from './refresh.js';
import { sweepDue, sweepOnce, type SweepPass } from './sweep.js';
import { topUpOnce, type TopUpPass } from './topup.js';
import { newWatchState, watchDue, watchOnce, type WatchPass, type WatchState } from './watch.js';
import { safeText } from './util.js';

export interface TickReport {
  discovery?: DiscoveryPass;
  watch?: WatchPass;
  sweep?: SweepPass;
  refresh?: RefreshPass;
  topUp?: TopUpPass;
  /** Coins waiting for candles that were put in the queue again. */
  requeued?: number;
}

const REQUEUE_PAGE = 1_000;

/**
 * Queues every coin that has a candles row nobody has claimed. The queue holds jobs, the stage
 * rows are the truth: a job can be lost (the queue was cleared, a pause let it go unclaimed), a
 * row cannot. A coin already waiting in the queue is not queued twice.
 */
export async function requeueWaiting(deps: LiveDeps): Promise<number> {
  let total = 0;
  for (let afterId = 0; ;) {
    const ids = await listWaitingCandles(deps.db, { afterId, limit: REQUEUE_PAGE });
    if (ids.length === 0) break;
    await deps.enqueue('candles', ids);
    total += ids.length;
    afterId = ids[ids.length - 1]!;
    if (ids.length < REQUEUE_PAGE) break;
  }
  return total;
}

export class LiveLoop {
  private lastDiscoveryMs = Number.NEGATIVE_INFINITY;
  private lastWatchMs = Number.NEGATIVE_INFINITY;
  private lastRequeueMs = Number.NEGATIVE_INFINITY;
  private sweepNotBeforeMs = Number.NEGATIVE_INFINITY;
  private readonly watchState: WatchState = newWatchState();

  /** `refresh` and `topUp` can be switched off (a test seam: the watch tests do not want them). */
  constructor(
    private readonly deps: LiveDeps,
    private readonly opts: { refresh?: boolean; topUp?: boolean } = {},
  ) {}

  private async guarded<T>(what: string, fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (err) {
      this.deps.log.error(`${what} failed: ${safeText(err)}`);
      return undefined;
    }
  }

  async tick(): Promise<TickReport> {
    const { deps } = this;
    const report: TickReport = {};
    const nowMs = deps.now().getTime();

    await this.guarded('unit gate refresh', () => deps.gate.refresh());
    // The first tick, and the one after a pause lifts, queue what was waiting.
    const reopened = deps.gate.takeReopened();
    if (reopened || nowMs - this.lastRequeueMs >= REQUEUE_WAITING_SECONDS * 1000) {
      this.lastRequeueMs = nowMs;
      report.requeued = await this.guarded('requeue', () => requeueWaiting(deps));
    }

    if (nowMs - this.lastDiscoveryMs >= DISCOVERY_INTERVAL_SECONDS * 1000) {
      this.lastDiscoveryMs = nowMs;
      report.discovery = await this.guarded('discovery', () => discoverOnce(deps));
    }

    if (nowMs - this.lastWatchMs >= WATCH_PASS_SECONDS * 1000) {
      this.lastWatchMs = nowMs;
      report.watch = await this.guarded('watch', () => watchOnce(deps, this.watchState));
    }

    // After the watch, which goes first on the shared Jupiter limiter: the refresh sends a request
    // only when no watch request is due. The top-up follows the refresh, last in the spending order.
    if (this.opts.refresh !== false) {
      report.refresh = await this.guarded('refresh', () =>
        refreshOnce(deps, { shouldYield: () => watchDue(deps, this.watchState) }),
      );
    }
    if (this.opts.topUp !== false)
      report.topUp = await this.guarded('top-up', () => topUpOnce(deps));

    if (
      nowMs >= this.sweepNotBeforeMs &&
      (await this.guarded('sweep check', () => sweepDue(deps)))
    ) {
      const sweep = await this.guarded('sweep', () => sweepOnce(deps));
      if (sweep) report.sweep = sweep;
      if (!sweep?.complete) this.sweepNotBeforeMs = nowMs + SWEEP_RETRY_SECONDS * 1000;
    }
    return report;
  }
}
