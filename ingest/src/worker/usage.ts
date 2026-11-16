/**
 * Provider usage for one run: running totals kept in memory and written to
 * `provider_usage` as totals (every few seconds and at the end), so a killed
 * process loses at most one flush interval.
 */
import { recordUsage, type Database } from '@memecoinipedia/db';
import type { Kysely } from 'kysely';

export interface UsageTotals {
  requests: number;
  units: number;
}

export class UsageMeter {
  private readonly totals = new Map<string, UsageTotals>();
  private timer: NodeJS.Timeout | undefined;

  /** Adds to a provider's totals. */
  add(provider: string, requests: number, units = 0): void {
    const t = this.totals.get(provider) ?? { requests: 0, units: 0 };
    t.requests += requests;
    t.units += units;
    this.totals.set(provider, t);
  }

  /** Sets a provider's totals, for sources that keep their own count. */
  set(provider: string, requests: number, units = 0): void {
    this.totals.set(provider, { requests, units });
  }

  snapshot(): Record<string, UsageTotals> {
    return Object.fromEntries([...this.totals].map(([k, v]) => [k, { ...v }]));
  }

  async flush(db: Kysely<Database>, runId: number, now: Date): Promise<void> {
    for (const [provider, t] of this.totals) {
      await recordUsage(db, runId, { provider, requests: t.requests, units: t.units }, now);
    }
  }

  /** Flushes every `everyMs` until `stop()`. Errors are passed to `onError`, not thrown. */
  startFlushing(
    db: Kysely<Database>,
    runId: number,
    now: () => Date,
    everyMs: number,
    onError: (err: unknown) => void,
    beforeFlush?: () => void,
  ): () => void {
    this.timer = setInterval(() => {
      beforeFlush?.();
      this.flush(db, runId, now()).catch(onError);
    }, everyMs);
    this.timer.unref();
    return () => {
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
    };
  }
}
