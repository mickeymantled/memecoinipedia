import { describe, expect, it } from 'vitest';
import { BudgetExceededError, UnitBudget } from '../../src/sources/budget.js';

describe('UnitBudget', () => {
  it('tracks requests and units per provider', () => {
    const b = new UnitBudget({ ceilingUnits: 100 });
    b.record('codex', 4, false);
    b.record('codex', 5.2, false);
    b.record('other', 1, true);
    expect(b.summary('codex')).toEqual({
      requests: 2,
      units: 9.2,
      estimatedUnits: 0,
      estimatedRequests: 0,
      reservedUnits: 0,
      ceiling: 100,
      remaining: 90.8,
    });
    expect(b.summary('other').requests).toBe(1);
    expect(b.providers().sort()).toEqual(['codex', 'other']);
  });

  it('reports estimated spend separately', () => {
    const b = new UnitBudget();
    b.record('codex', 4, false);
    b.record('codex', 4, true);
    const s = b.summary('codex');
    expect(s.units).toBe(8);
    expect(s.estimatedUnits).toBe(4);
    expect(s.estimatedRequests).toBe(1);
    expect(s.ceiling).toBeNull();
    expect(s.remaining).toBeNull();
  });

  it('stops before the call that would pass the ceiling', () => {
    const b = new UnitBudget({ ceilingUnits: 10 });
    b.settle(b.reserve('codex', 4), [{ units: 4, estimated: false }]);
    b.settle(b.reserve('codex', 4), [{ units: 4, estimated: false }]);
    // 8 spent + 4 estimated = 12 > 10
    expect(() => b.reserve('codex', 4)).toThrow(BudgetExceededError);
    // An estimate that lands exactly on the ceiling is allowed.
    expect(() => b.reserve('codex', 2)).not.toThrow();
  });

  it('counts reservations held by calls in flight', () => {
    const b = new UnitBudget({ ceilingUnits: 10 });
    const r1 = b.reserve('codex', 4);
    b.reserve('codex', 4);
    expect(b.summary('codex')).toMatchObject({ reservedUnits: 8, units: 0, remaining: 2 });
    expect(() => b.reserve('codex', 4)).toThrow(BudgetExceededError);
    // Settling releases the hold and records the real figure.
    b.settle(r1, [{ units: 1, estimated: false }]);
    expect(b.summary('codex')).toMatchObject({ reservedUnits: 4, units: 1, requests: 1 });
    expect(() => b.reserve('codex', 4)).not.toThrow();
  });

  it('settles once, and records one request per entry', () => {
    const b = new UnitBudget();
    const r = b.reserve('codex', 4);
    b.settle(r, [
      { units: 4, estimated: true },
      { units: 4, estimated: true },
      { units: 4.2, estimated: false },
    ]);
    b.settle(r, [{ units: 100, estimated: false }]);
    expect(b.summary('codex')).toMatchObject({
      requests: 3,
      units: 12.2,
      estimatedRequests: 2,
      reservedUnits: 0,
    });
  });

  it('never throws without a ceiling', () => {
    const b = new UnitBudget();
    b.record('codex', 1e9, false);
    expect(() => b.reserve('codex', 1e9)).not.toThrow();
  });

  it('keeps ceilings per provider', () => {
    const b = new UnitBudget({ ceilingUnits: 5 });
    b.record('a', 5, false);
    expect(() => b.reserve('a', 1)).toThrow(BudgetExceededError);
    expect(() => b.reserve('b', 5)).not.toThrow();
  });

  it('adjusts the total from a later figure and moves replaced estimates out of the estimated part', () => {
    const b = new UnitBudget({ ceilingUnits: 100 });
    b.record('a', 10, false);
    b.record('a', 30, true);
    b.adjust('a', 5, 30); // the 30 estimated credits were really 35
    expect(b.summary('a')).toMatchObject({
      requests: 2,
      units: 45,
      estimatedUnits: 0,
      estimatedRequests: 1,
      remaining: 55,
    });
    b.adjust('a', -15); // a negative correction lowers the total
    expect(b.summary('a').units).toBe(30);
  });
});
