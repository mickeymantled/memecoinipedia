import type { WatchIntervals } from '@memecoinipedia/db';
import {
  WATCH_FRESH_EVERY_SECONDS,
  WATCH_FRESH_UNDER_SECONDS,
  WATCH_MID_EVERY_SECONDS,
  WATCH_MID_UNDER_SECONDS,
  WATCH_OLDER_EVERY_SECONDS,
  WATCH_WINDOW_SECONDS,
} from './constants.js';

export const WATCH_INTERVALS: WatchIntervals = {
  freshUnderSeconds: WATCH_FRESH_UNDER_SECONDS,
  freshEverySeconds: WATCH_FRESH_EVERY_SECONDS,
  midUnderSeconds: WATCH_MID_UNDER_SECONDS,
  midEverySeconds: WATCH_MID_EVERY_SECONDS,
  olderEverySeconds: WATCH_OLDER_EVERY_SECONDS,
};

/** The watched set at `now`: the argument every watched-set query takes. */
export const watchSpec = (now: Date) => ({ now, windowSeconds: WATCH_WINDOW_SECONDS });

/** Seconds between price reads for a coin of this age. */
export function watchEvery(ageSeconds: number): number {
  if (ageSeconds < WATCH_FRESH_UNDER_SECONDS) return WATCH_FRESH_EVERY_SECONDS;
  if (ageSeconds < WATCH_MID_UNDER_SECONDS) return WATCH_MID_EVERY_SECONDS;
  return WATCH_OLDER_EVERY_SECONDS;
}

/** Midnight UTC at or before `d`. */
export const startOfUtcDay = (d: Date): Date =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/** The next midnight UTC after `d`. */
export const nextUtcMidnight = (d: Date): Date => new Date(startOfUtcDay(d).getTime() + 86_400_000);

/**
 * Text that came from a provider (an error message that quotes a token name, say), made safe to
 * put in a log line: control characters, newlines included, become spaces, and it is cut short.
 * Token names and symbols are stored as they come; they are never put in a log line otherwise.
 */
export function safeText(text: unknown, max = 200): string {
  const s = (text instanceof Error ? text.message : String(text))
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export const sleepUnlessAborted = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
