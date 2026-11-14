/**
 * Per-provider request and unit accounting with an optional ceiling.
 *
 * Usage: before a call, `assertCanSpend(provider, estimatedUnits)`; after the
 * call, `record(provider, units, estimated)`. The check uses units already
 * recorded plus the estimate for the next call, so a run stops before the call
 * that would pass the ceiling.
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
  ceiling: number | null;
  /** Units left under the ceiling, or null when there is no ceiling. */
  remaining: number | null;
}

export interface UnitBudgetOptions {
  /** Ceiling per provider, in units. Omit for no ceiling. */
  ceilingUnits?: number;
}

interface Counters {
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
      c = { requests: 0, units: 0, estimatedUnits: 0, estimatedRequests: 0 };
      this.counters.set(provider, c);
    }
    return c;
  }

  /** Throws `BudgetExceededError` when recorded units plus the estimate would pass the ceiling. */
  assertCanSpend(provider: string, estimatedUnits: number): void {
    if (this.ceiling === null) return;
    const spent = this.get(provider).units;
    if (spent + estimatedUnits > this.ceiling + 1e-9) {
      throw new BudgetExceededError(provider, spent, estimatedUnits, this.ceiling);
    }
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

  summary(provider: string): ProviderSummary {
    const c = this.get(provider);
    return {
      requests: c.requests,
      units: c.units,
      estimatedUnits: c.estimatedUnits,
      estimatedRequests: c.estimatedRequests,
      ceiling: this.ceiling,
      remaining: this.ceiling === null ? null : Math.max(0, this.ceiling - c.units),
    };
  }

  providers(): string[] {
    return [...this.counters.keys()];
  }
}
