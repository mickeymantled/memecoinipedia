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
import { sweepDue, sweepOnce, type SweepPass } from './sweep.js';
import { newWatchState, watchOnce, type WatchPass, type WatchState } from './watch.js';
import { safeText } from './util.js';

export interface TickReport {
  discovery?: DiscoveryPass;
  watch?: WatchPass;
  sweep?: SweepPass;
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

  constructor(private readonly deps: LiveDeps) {}

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
