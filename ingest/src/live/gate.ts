/**
 * The day's Codex.io unit ceiling.
 *
 * "Day" is the UTC day. The day's use is read from the usage records the clients already write
 * (`provider_usage_samples`, one history of each run's running totals), not counted a second time:
 * what other runs (a backfill that ran this morning, an earlier live process) used today comes
 * from the samples; what this process used comes from its own client's running total, less what
 * it had used when the day began, so it is exact between samples.
 *
 * When the day's units reach the ceiling the gate closes: discovery passes do nothing and the
 * candles stage takes no new coin, until the next UTC day. It says so in the log, once when it
 * closes and once when it opens again. Everything that costs Codex.io nothing carries on.
 *
 * `admit` is synchronous, because the stage's `admit` is: it uses the last read of the database
 * plus this process's own spend since. `refresh` is async and is called every scheduler tick.
 */
import { usageByRunSince, type Database } from '@memecoinipedia/db';
import type { Kysely } from 'kysely';
import { CODEX_PROVIDER } from '../sources/codex/index.js';
import type { Logger } from '../worker/log.js';
import { nextUtcMidnight, startOfUtcDay } from './util.js';

export interface SpendGate {
  /** True while Codex.io may be asked for more. Synchronous: no database read. */
  admit(): boolean;
  /** Re-reads the day's use from the database; handles the change of day. */
  refresh(): Promise<void>;
  /** True once after the gate opened again, so the caller can queue what the pause held back. */
  takeReopened(): boolean;
  /** Units used today and the ceiling, for the log and the status. */
  snapshot(): { usedToday: number; ceiling: number; open: boolean; opensAt: Date | null };
}

export interface CodexDayGateOptions {
  db: Kysely<Database>;
  ceilingUnits: number;
  now: () => Date;
  /** The run this process records its usage under. */
  runId: number;
  /** This process's own total, reserved calls included: `spend().units + spend().reservedUnits`. */
  localUnits: () => number;
  log: Logger;
}

const n = (x: number) => Math.round(x).toLocaleString('en-US');

export class CodexDayGate implements SpendGate {
  private day: string | null = null;
  private others = 0;
  private ownAtDayStart = 0;
  private open = true;
  private opensAt: Date | null = null;

  constructor(private readonly o: CodexDayGateOptions) {
    if (!(o.ceilingUnits > 0)) throw new RangeError('The daily unit ceiling must be positive');
  }

  private used(): number {
    return this.others + Math.max(0, this.o.localUnits() - this.ownAtDayStart);
  }

  admit(): boolean {
    if (this.open && this.used() >= this.o.ceilingUnits) this.close();
    return this.open;
  }

  private close(): void {
    const now = this.o.now();
    this.open = false;
    this.opensAt = nextUtcMidnight(now);
    this.o.log.warn(
      `Codex.io: ${n(this.used())} units used today (UTC), the daily ceiling is ${n(this.o.ceilingUnits)}. ` +
        `Discovery and candle fetches are paused until ${this.opensAt.toISOString()}; ` +
        'the watch loop and the stages that cost Codex.io nothing carry on.',
    );
  }

  async refresh(): Promise<void> {
    const now = this.o.now();
    const today = startOfUtcDay(now);
    const dayName = today.toISOString().slice(0, 10);
    const rows = await usageByRunSince(this.o.db, CODEX_PROVIDER, today, now);
    this.others = rows
      .filter((r) => r.runId !== this.o.runId)
      .reduce((s, r) => s + Math.max(0, r.latest - r.before), 0);
    if (this.day === null) {
      // First look. A run that started today had used nothing when the day began.
      this.ownAtDayStart = rows.find((r) => r.runId === this.o.runId)?.before ?? 0;
    } else if (this.day !== dayName) {
      // The day changed while this process ran: what it has used so far belongs to yesterday.
      this.ownAtDayStart = this.o.localUnits();
    }
    this.day = dayName;
    let opened = false;
    if (!this.open && now >= (this.opensAt ?? now)) {
      this.open = true;
      this.opensAt = null;
      opened = true;
    }
    if (this.open && this.used() >= this.o.ceilingUnits) {
      this.close();
    } else if (opened) {
      this.justOpened = true;
      this.o.log.info(
        `Codex.io: a new UTC day (${dayName}), ${n(this.used())} of ${n(this.o.ceilingUnits)} units used: discovery and candle fetches resume.`,
      );
    }
  }

  private justOpened = false;

  takeReopened(): boolean {
    const r = this.justOpened;
    this.justOpened = false;
    return r;
  }

  snapshot() {
    return {
      usedToday: this.used(),
      ceiling: this.o.ceilingUnits,
      open: this.open,
      opensAt: this.opensAt,
    };
  }
}
