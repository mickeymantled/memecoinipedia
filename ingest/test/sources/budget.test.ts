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
    b.assertCanSpend('codex', 4);
    b.record('codex', 4, false);
    b.assertCanSpend('codex', 4);
    b.record('codex', 4, false);
    // 8 spent + 4 estimated = 12 > 10
    expect(() => b.assertCanSpend('codex', 4)).toThrow(BudgetExceededError);
    // An estimate that lands exactly on the ceiling is allowed.
    expect(() => b.assertCanSpend('codex', 2)).not.toThrow();
  });

  it('never throws without a ceiling', () => {
    const b = new UnitBudget();
    b.record('codex', 1e9, false);
    expect(() => b.assertCanSpend('codex', 1e9)).not.toThrow();
  });

  it('keeps ceilings per provider', () => {
    const b = new UnitBudget({ ceilingUnits: 5 });
    b.record('a', 5, false);
    expect(() => b.assertCanSpend('a', 1)).toThrow(BudgetExceededError);
    expect(() => b.assertCanSpend('b', 5)).not.toThrow();
  });
});
