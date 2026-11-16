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
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class RateLimiter {
  private readonly rate: number;
  private readonly capacity: number;
  private readonly maxConcurrency: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
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
    this.rate = opts.maxPerSecond;
    this.capacity = burst;
    this.maxConcurrency = opts.maxConcurrency ?? Number.POSITIVE_INFINITY;
    this.now = opts.now ?? (() => performance.now());
    this.sleep = opts.sleep ?? realSleep;
    this.tokens = burst;
    this.last = this.now();
  }

  private refill(): void {
    const t = this.now();
    const elapsedSec = Math.max(0, t - this.last) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.rate);
    this.last = t;
  }

  /** Waits until a token is available, then takes it. Calls are served in order. */
  acquire(): Promise<void> {
    const turn = this.queue.then(async () => {
      for (;;) {
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
