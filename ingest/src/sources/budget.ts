/**
 * Per-provider request and unit accounting with an optional ceiling.
 *
 * Usage: before a call, `reserve(provider, estimatedUnits)`; after the call,
 * `settle(reservation, entries)`. `reserve` checks recorded units plus units
 * already reserved by calls in flight plus this estimate, so a run stops before
 * the call that would pass the ceiling even when many calls run concurrently.
 * `settle` releases the reservation and records what was actually spent, one
 * entry per HTTP request made (retries included).
 */

export class BudgetExceededError extends Error {
  readonly provider: string;
  readonly spentUnits: number;
  readonly estimatedUnits: number;
  readonly ceilingUnits: number;

  constructor(provider: string, spentUnits: number, estimatedUnits: number, ceilingUnits: number) {
    super(
      `Budget for ${provider} would be exceeded: ${spentUnits} units spent, next call ` +
        `estimated at ${estimatedUnits}, ceiling ${ceilingUnits}. The call was not made.`,
    );
    this.name = 'BudgetExceededError';
    this.provider = provider;
    this.spentUnits = spentUnits;
    this.estimatedUnits = estimatedUnits;
    this.ceilingUnits = ceilingUnits;
  }
}

export interface ProviderSummary {
  requests: number;
  /** Total units, measured and estimated together. */
  units: number;
  /** The part of `units` that came from estimates because the response reported no cost. */
  estimatedUnits: number;
  /** Requests whose cost was estimated. */
  estimatedRequests: number;
  /** Units held by calls in flight, not yet settled. */
  reservedUnits: number;
  ceiling: number | null;
  /** Units left under the ceiling after recorded and reserved units, or null with no ceiling. */
  remaining: number | null;
}

export interface UnitBudgetOptions {
  /** Ceiling per provider, in units. Omit for no ceiling. */
  ceilingUnits?: number;
}

/** One HTTP request's cost: `estimated` is true when the figure is not a reported one. */
export interface SpendEntry {
  units: number;
  estimated: boolean;
}

export interface Reservation {
  readonly provider: string;
  readonly units: number;
  settled: boolean;
}

interface Counters {
  reserved: number;
  requests: number;
  units: number;
  estimatedUnits: number;
  estimatedRequests: number;
}

export class UnitBudget {
  private readonly ceiling: number | null;
  private readonly counters = new Map<string, Counters>();

  constructor(opts: UnitBudgetOptions = {}) {
    this.ceiling = opts.ceilingUnits ?? null;
  }

  private get(provider: string): Counters {
    let c = this.counters.get(provider);
    if (!c) {
      c = { reserved: 0, requests: 0, units: 0, estimatedUnits: 0, estimatedRequests: 0 };
      this.counters.set(provider, c);
    }
    return c;
  }

  /**
   * Throws `BudgetExceededError` when recorded plus reserved units plus the
   * estimate would pass the ceiling. Otherwise holds the estimate until
   * `settle`. Without a ceiling it still tracks the reservation.
   */
  reserve(provider: string, estimatedUnits: number): Reservation {
    const c = this.get(provider);
    if (this.ceiling !== null && c.units + c.reserved + estimatedUnits > this.ceiling + 1e-9) {
      throw new BudgetExceededError(provider, c.units + c.reserved, estimatedUnits, this.ceiling);
    }
    c.reserved += estimatedUnits;
    return { provider, units: estimatedUnits, settled: false };
  }

  /** Releases the reservation (once) and records one request per entry. */
  settle(reservation: Reservation, entries: readonly SpendEntry[]): void {
    if (reservation.settled) return;
    reservation.settled = true;
    const c = this.get(reservation.provider);
    c.reserved = Math.max(0, c.reserved - reservation.units);
    for (const e of entries) this.record(reservation.provider, e.units, e.estimated);
  }

  record(provider: string, units: number, estimated: boolean): void {
    const c = this.get(provider);
    c.requests += 1;
    c.units += units;
    if (estimated) {
      c.estimatedUnits += units;
      c.estimatedRequests += 1;
    }
  }

  /**
   * Corrects the recorded total by `deltaUnits` (negative lowers it), from a figure the provider
   * reports later, and takes `estimatedUnitsReplaced` out of the estimated part: those estimates
   * are now measured. Request counts are left alone.
   */
  adjust(provider: string, deltaUnits: number, estimatedUnitsReplaced = 0): void {
    const c = this.get(provider);
    c.units += deltaUnits;
    c.estimatedUnits = Math.max(0, c.estimatedUnits - estimatedUnitsReplaced);
  }

  summary(provider: string): ProviderSummary {
    const c = this.get(provider);
    return {
      requests: c.requests,
      units: c.units,
      estimatedUnits: c.estimatedUnits,
      estimatedRequests: c.estimatedRequests,
      reservedUnits: c.reserved,
      ceiling: this.ceiling,
      remaining: this.ceiling === null ? null : Math.max(0, this.ceiling - c.units - c.reserved),
    };
  }

  providers(): string[] {
    return [...this.counters.keys()];
  }
}
