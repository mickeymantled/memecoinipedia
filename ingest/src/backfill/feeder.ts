/**
 * Feeds the queue a page of coins at a time.
 *
 * The queue never holds the whole selection, and neither does this process. The feeder walks the
 * selection in its order with a key (an index walk, so the cost of a page does not grow with how
 * far in it is), and keeps a bounded number of jobs waiting or running: when the queue drops
 * below the limit it reads the next page, asks the worker which of those coins still need which
 * stage (the same SQL the worker claims with, so a done coin is skipped and an unlisted coin is
 * not offered metadata), and queues them. Memory is one page.
 */
import {
  keyOf,
  selectionPage,
  type Database,
  type ResolvedSelection,
  type SelectionKey,
  type StageName,
} from '@memecoinipedia/db';
import type { Kysely } from 'kysely';
import type { Logger } from '../worker/log.js';
import type { PipelineWorker } from '../worker/worker.js';

export interface FeederOptions {
  db: Kysely<Database>;
  worker: PipelineWorker;
  selection: ResolvedSelection;
  /** Jobs waiting, retrying or running above which no new page is read. */
  maxOutstanding: number;
  /** Coins read at a time. */
  pageSize: number;
  log: Logger;
  /** Set to stop feeding: the page being read is queued, no further page is read. */
  signal?: AbortSignal | undefined;
  /** Milliseconds between looks at the queue while it is full. Default 100. */
  pollMs?: number;
}

export interface FeedPass {
  /** Coins read from the selection, done or not. */
  scanned: number;
  /** Jobs queued, per stage. */
  queued: Partial<Record<StageName, number>>;
  /** True when the whole selection was read; false when the signal stopped the pass. */
  exhausted: boolean;
}

export class Feeder {
  /** Coins read in all passes. */
  scannedTotal = 0;
  constructor(private readonly o: FeederOptions) {}

  private get stopped(): boolean {
    return this.o.signal?.aborted === true;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** One walk over the selection from the start. */
  async pass(): Promise<FeedPass> {
    const { worker, db, selection } = this.o;
    const out: FeedPass = { scanned: 0, queued: {}, exhausted: false };
    let cursor: SelectionKey | null = null;
    for (;;) {
      // Wait for room. A page is read only when at least a page's worth fits.
      for (;;) {
        if (this.stopped) return out;
        const room = this.o.maxOutstanding - (await worker.outstandingJobs());
        if (room >= Math.min(this.o.pageSize, this.o.maxOutstanding)) break;
        await this.sleep(this.o.pollMs ?? 100);
      }
      const page = await selectionPage(db, selection, cursor, this.o.pageSize);
      if (page.length === 0) {
        out.exhausted = true;
        return out;
      }
      cursor = keyOf(page[page.length - 1]!);
      out.scanned += page.length;
      this.scannedTotal += page.length;
      const ids = page.map((p) => p.id);
      for (const stage of worker.activeStages) {
        const todo = await worker.coinsToDoAmong(stage, ids);
        if (todo.length === 0) continue;
        await worker.enqueueCoins(
          stage,
          todo.map((c) => c.id),
        );
        out.queued[stage] = (out.queued[stage] ?? 0) + todo.length;
      }
      if (page.length < this.o.pageSize) {
        out.exhausted = true;
        return out;
      }
    }
  }
}
