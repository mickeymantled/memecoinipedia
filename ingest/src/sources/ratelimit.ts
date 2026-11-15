/**
 * Token-bucket rate limiter with optional max concurrency.
 *
 * The clock and the sleep function are injectable so tests run instantly: with
 * a fake clock, `sleep(ms)` advances the clock and nothing waits in real time.
 */

export interface RateLimiterOptions {
  /** Sustained rate: tokens added to the bucket per second. */
  maxPerSecond: number;
  /** Bucket size: how many calls may start at once after an idle period. Default 1. */
  burst?: number;
  /** Maximum calls running at the same time. Default: unlimited. */
  maxConcurrency?: number;
  /** Milliseconds, monotonic. Default `performance.now()`. */
  now?: () => number;
  /** Default: a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Told when the provider asks for a long pause (see `WARN_PAUSE_MS`). Default: nobody. */
  onWarning?: (message: string) => void;
}

/** A `Retry-After` is taken at its word up to this long; the pause is capped here. */
export const MAX_PENALTY_PAUSE_MS = 60_000;
/** A provider asking for more than this long a pause is worth a warning. */
export const WARN_PAUSE_MS = 10_000;

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** What `penalize` does, and how the rate recovers. */
export interface PenaltyOptions {
  /** The provider said when to come back (milliseconds). Default: a pause of 1,000. */
  retryAfterMs?: number | null;
}

const PENALTY_FACTOR = 0.5;
/** The rate never falls below this share of the configured one. */
const MIN_RATE_SHARE = 0.05;
/** After this long without a penalty the rate starts climbing back. */
const QUIET_BEFORE_RECOVERY_MS = 2_000;
/** Climbing back: this share of the configured rate is added each second. */
const RECOVERY_SHARE_PER_SECOND = 0.1;

export class RateLimiter {
  /** The configured sustained rate. */
  private readonly baseRate: number;
  /** The rate now: lower than `baseRate` after a penalty, recovering with time. */
  private rate: number;
  private heldUntil = 0;
  private lastPenalty = Number.NEGATIVE_INFINITY;
  /** How many times the provider has told this limiter to slow down. */
  penalties = 0;
  private readonly capacity: number;
  private readonly maxConcurrency: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onWarning: ((message: string) => void) | undefined;
  private tokens: number;
  private last: number;
  private running = 0;
  /** Calls wait here in arrival order so nobody is starved. */
  private queue: Promise<void> = Promise.resolve();
  private readonly concurrencyWaiters: Array<() => void> = [];

  constructor(opts: RateLimiterOptions) {
    if (!(opts.maxPerSecond > 0)) throw new RangeError('maxPerSecond must be positive');
    const burst = opts.burst ?? 1;
    if (!(burst >= 1)) throw new RangeError('burst must be at least 1');
    this.baseRate = opts.maxPerSecond;
    this.rate = opts.maxPerSecond;
    this.capacity = burst;
    this.maxConcurrency = opts.maxConcurrency ?? Number.POSITIVE_INFINITY;
    this.now = opts.now ?? (() => performance.now());
    this.sleep = opts.sleep ?? realSleep;
    this.onWarning = opts.onWarning;
    this.tokens = burst;
    this.last = this.now();
  }

  /** The sustained rate in force now (below the configured one while recovering from a penalty). */
  get currentRate(): number {
    return this.rate;
  }

  /**
   * The provider answered "too many requests". Every caller sharing this limiter slows down: the
   * bucket is emptied, no call starts until `retryAfterMs` has passed (a second when not given),
   * and the rate is halved. It climbs back by a tenth of the configured rate a second once two
   * seconds go by without another penalty. Penalties arriving while one is in force count and
   * extend the pause but halve the rate at most once per pause, so a burst of 429s from calls
   * that were already in flight does not drive the rate to the floor.
   */
  penalize(opts: PenaltyOptions = {}): void {
    const t = this.now();
    this.penalties++;
    const asked = opts.retryAfterMs ?? 1_000;
    if (asked > WARN_PAUSE_MS) {
      this.onWarning?.(
        `the provider asked for a pause of ${Math.round(asked / 1000)} s` +
          (asked > MAX_PENALTY_PAUSE_MS
            ? `; pausing ${MAX_PENALTY_PAUSE_MS / 1000} s at most`
            : ''),
      );
    }
    const pause = Math.min(MAX_PENALTY_PAUSE_MS, Math.max(250, asked));
    const alreadyHeld = t < this.heldUntil;
    this.heldUntil = Math.max(this.heldUntil, t + pause);
    this.tokens = 0;
    this.last = t;
    if (!alreadyHeld) {
      this.rate = Math.max(this.baseRate * MIN_RATE_SHARE, this.rate * PENALTY_FACTOR);
    }
    this.lastPenalty = t;
  }

  private refill(): void {
    const t = this.now();
    const elapsedSec = Math.max(0, t - this.last) / 1000;
    if (this.rate < this.baseRate && t - this.lastPenalty > QUIET_BEFORE_RECOVERY_MS) {
      this.rate = Math.min(
        this.baseRate,
        this.rate + this.baseRate * RECOVERY_SHARE_PER_SECOND * elapsedSec,
      );
    }
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.rate);
    this.last = t;
  }

  /** Waits until a token is available, then takes it. Calls are served in order. */
  acquire(): Promise<void> {
    const turn = this.queue.then(async () => {
      for (;;) {
        const held = this.heldUntil - this.now();
        if (held > 0) {
          await this.sleep(Math.ceil(held));
          continue;
        }
        this.refill();
        if (this.tokens >= 1 - 1e-9) {
          this.tokens -= 1;
          return;
        }
        const waitMs = Math.ceil(((1 - this.tokens) / this.rate) * 1000);
        await this.sleep(Math.max(1, waitMs));
      }
    });
    // A failed sleep must not poison the queue for later callers.
    this.queue = turn.catch(() => undefined);
    return turn;
  }

  private async acquireSlot(): Promise<void> {
    if (this.running < this.maxConcurrency) {
      this.running++;
      return;
    }
    await new Promise<void>((resolve) => this.concurrencyWaiters.push(resolve));
    // The releasing call handed its slot over, so `running` is unchanged.
  }

  private releaseSlot(): void {
    const next = this.concurrencyWaiters.shift();
    if (next) next();
    else this.running--;
  }

  /** Runs `fn` once a token and a concurrency slot are both available. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquireSlot();
    try {
      await this.acquire();
      return await fn();
    } finally {
      this.releaseSlot();
    }
  }
}
