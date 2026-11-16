import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PLAN_LIMITS,
  EXHAUSTIVE_PLAN_LIMITS,
  estimateCoinUnits,
  graduationStart,
  mergeIntervals,
  planBaseRequests,
  planPeakRefinement,
  subtractIntervals,
  summarizeDaily,
  type Interval,
  type PlanPool,
  type PlanState,
  type PlannedRequest,
  type ResolutionSec,
} from '../../src/candles/plan.js';

const DAY = 86_400;
const HOUR = 3_600;
const MIN = 60;

// 2026-01-01 00:00:00 UTC, a multiple of a day.
const T0 = 1_767_225_600;
const LAUNCH = T0 + 3 * HOUR + 17 * MIN;
const GRAD = LAUNCH + 6 * HOUR + 41; // seconds past a minute on purpose
const ASOF = GRAD + 400 * DAY + 5 * HOUR + 13 * MIN;

const CURVE: PlanPool = { address: 'CURVE', role: 'curve', createdAt: LAUNCH };
const GRADPOOL: PlanPool = { address: 'GRAD', role: 'graduation', createdAt: GRAD };
const other = (n: string): PlanPool => ({ address: `OTHER_${n}`, role: 'other', createdAt: null });

function state(over: Partial<PlanState> = {}): PlanState {
  return {
    asOf: ASOF,
    launchedAt: LAUNCH,
    graduatedAt: GRAD,
    pools: [CURVE, GRADPOOL],
    coverage: {},
    daily: {},
    limits: EXHAUSTIVE_PLAN_LIMITS,
    ...over,
  };
}

const by = (requests: PlannedRequest[], address: string, res: ResolutionSec) =>
  requests.filter((r) => r.poolAddress === address && r.resolution === res);

/** Pretends every planned request was made: adds its cover to the coverage map. */
function withCovered(s: PlanState, requests: readonly PlannedRequest[]): PlanState['coverage'] {
  const out: Record<string, Partial<Record<ResolutionSec, Interval[]>>> = {};
  for (const [addr, byRes] of Object.entries(s.coverage)) {
    out[addr] = Object.fromEntries(
      Object.entries(byRes).map(([r, list]) => [r, [...(list ?? [])]]),
    ) as Partial<Record<ResolutionSec, Interval[]>>;
  }
  for (const r of requests) {
    const byRes = (out[r.poolAddress] ??= {});
    (byRes[r.resolution] ??= []).push(r.cover);
  }
  return out;
}

const dayBars = (...days: number[]) =>
  summarizeDaily(
    days.map((t) => ({ t, liquidityUsd: 10_000 })),
    5_000,
  );

describe('interval helpers', () => {
  it('merges touching ranges, and across a gap when asked', () => {
    expect(
      mergeIntervals([
        { from: 10, to: 20 },
        { from: 0, to: 5 },
        { from: 20, to: 30 },
      ]),
    ).toEqual([
      { from: 0, to: 5 },
      { from: 10, to: 30 },
    ]);
    expect(
      mergeIntervals(
        [
          { from: 0, to: 5 },
          { from: 10, to: 20 },
        ],
        5,
      ),
    ).toEqual([{ from: 0, to: 20 }]);
  });

  it('subtracts covered ranges from a need', () => {
    const need = { from: 0, to: 100 };
    expect(subtractIntervals(need, [])).toEqual([need]);
    expect(subtractIntervals(need, [{ from: 0, to: 100 }])).toEqual([]);
    expect(
      subtractIntervals(need, [
        { from: -5, to: 10 },
        { from: 40, to: 60 },
      ]),
    ).toEqual([
      { from: 10, to: 40 },
      { from: 60, to: 100 },
    ]);
    expect(subtractIntervals({ from: 5, to: 5 }, [])).toEqual([]);
  });
});

describe('graduation start', () => {
  const pools = (createdAt: number | null) =>
    [{ address: 'G', role: 'graduation', createdAt }] satisfies PlanPool[];

  it('uses the pool creation time when it is near the migration time', () => {
    expect(graduationStart({ pools: pools(GRAD + 12), graduatedAt: GRAD })).toBe(GRAD + 12);
  });
  it('uses the migration time when the pool date is more than a day off', () => {
    expect(graduationStart({ pools: pools(GRAD + 40 * DAY), graduatedAt: GRAD })).toBe(GRAD);
  });
  it('falls back to whichever is known, else null', () => {
    expect(graduationStart({ pools: pools(null), graduatedAt: GRAD })).toBe(GRAD);
    expect(graduationStart({ pools: pools(GRAD), graduatedAt: null })).toBe(GRAD);
    expect(graduationStart({ pools: pools(null), graduatedAt: null })).toBeNull();
    expect(graduationStart({ pools: [], graduatedAt: GRAD })).toBe(GRAD);
  });
});

describe('initial phase (exhaustive plan)', () => {
  const plan = planBaseRequests(state({ pools: [CURVE, GRADPOOL, other('A')] }));

  it('is the initial phase, and every request is one aligned window of at most 1,500 buckets', () => {
    expect(plan.phase).toBe('initial');
    for (const r of plan.requests) {
      expect(r.from % r.resolution).toBe(0);
      expect(r.to % r.resolution).toBe(0);
      expect(r.buckets).toBe((r.to - r.from) / r.resolution);
      expect(r.buckets).toBeLessThanOrEqual(1500);
      expect(r.cover.from).toBeGreaterThanOrEqual(r.from);
      expect(r.cover.to).toBeLessThanOrEqual(r.to);
      expect(r.cover.to).toBeLessThanOrEqual(ASOF);
      expect(r.estimatedUnits).toBe(4);
    }
    expect(plan.estimatedUnits).toBe(plan.requests.length * 4);
  });

  it('asks for the curve minute bars from launch when the curve lived under 24 hours', () => {
    const tail = by(plan.requests, 'CURVE', 60);
    expect(tail).toHaveLength(1);
    expect(tail[0]!.reason).toBe('curve_tail');
    // Launch is 6h41m before graduation, so the window starts at launch (to the minute).
    expect(tail[0]!.cover).toEqual({ from: Math.floor(LAUNCH / MIN) * MIN, to: GRAD });
  });

  it('caps the curve minute bars at 24 hours before graduation', () => {
    const p = planBaseRequests(state({ launchedAt: GRAD - 30 * DAY, pools: [CURVE, GRADPOOL] }));
    const tail = by(p.requests, 'CURVE', 60);
    expect(tail).toHaveLength(1);
    expect(tail[0]!.cover).toEqual({ from: Math.floor((GRAD - DAY) / MIN) * MIN, to: GRAD });
    expect(tail[0]!.buckets).toBeLessThanOrEqual(1441);
  });

  it('asks for 48 hours of minute bars after the graduation pool was created, in two requests', () => {
    const post = by(plan.requests, 'GRAD', 60);
    expect(post).toHaveLength(2);
    expect(post.every((r) => r.reason === 'post_graduation_minute')).toBe(true);
    const covers = mergeIntervals(post.map((r) => r.cover));
    expect(covers).toHaveLength(1);
    expect(covers[0]!.to).toBe(GRAD + 2 * DAY);
    // It starts a few minutes early, because the first bar can precede the recorded creation.
    expect(covers[0]!.from).toBeLessThan(GRAD);
    expect(covers[0]!.from).toBeGreaterThanOrEqual(GRAD - 6 * MIN);
  });

  it('shortens the post-graduation window to asOf for a coin that graduated an hour ago', () => {
    const p = planBaseRequests(state({ asOf: GRAD + HOUR }));
    const post = by(p.requests, 'GRAD', 60);
    expect(post).toHaveLength(1);
    expect(post[0]!.cover.to).toBe(GRAD + HOUR);
  });

  it('asks for daily bars over the whole life of both primary pools and of the others', () => {
    const curveDaily = by(plan.requests, 'CURVE', 86400);
    expect(curveDaily).toHaveLength(1);
    expect(curveDaily[0]!.cover.from).toBe(T0);
    expect(curveDaily[0]!.cover.to).toBe(T0 + DAY); // the day after the graduation day, clipped
    const gradDaily = by(plan.requests, 'GRAD', 86400);
    expect(gradDaily).toHaveLength(1);
    expect(gradDaily[0]!.cover).toEqual({ from: T0, to: ASOF });
    const otherDaily = by(plan.requests, 'OTHER_A', 86400);
    expect(otherDaily).toHaveLength(1);
    expect(otherDaily[0]!.cover).toEqual({ from: T0, to: ASOF });
  });

  it('asks for no hourly bars for other pools before their daily bars are known', () => {
    expect(plan.requests.some((r) => r.resolution === 3600)).toBe(false);
  });

  it('pages a life longer than 1,500 days', () => {
    const p = planBaseRequests(state({ asOf: GRAD + 3_200 * DAY }));
    const daily = by(p.requests, 'GRAD', 86400);
    expect(daily).toHaveLength(3);
    expect(daily.every((r) => r.buckets <= 1500)).toBe(true);
    expect(mergeIntervals(daily.map((r) => r.cover))).toEqual([
      { from: T0, to: GRAD + 3_200 * DAY },
    ]);
  });

  it('plans nothing after asOf', () => {
    const p = planBaseRequests(state({ asOf: GRAD + 10 * MIN }));
    for (const r of p.requests) expect(r.cover.to).toBeLessThanOrEqual(GRAD + 10 * MIN);
  });

  it('plans a curve-only coin (no graduation known) from launch to asOf', () => {
    const p = planBaseRequests(
      state({ graduatedAt: null, pools: [CURVE], launchedAt: ASOF - 3 * HOUR }),
    );
    expect(p.requests.map((r) => `${r.poolAddress}:${r.resolution}`).sort()).toEqual([
      'CURVE:60',
      'CURVE:86400',
    ]);
    const tail = by(p.requests, 'CURVE', 60)[0]!;
    expect(tail.cover.to).toBe(ASOF);
    expect(tail.cover.from).toBe(Math.floor((ASOF - 3 * HOUR) / MIN) * MIN);
  });
});

describe('what is covered is never requested again', () => {
  it('plans nothing once the initial and follow-up requests are covered', () => {
    let s = state();
    const first = planBaseRequests(s);
    s = { ...s, coverage: withCovered(s, first.requests) };
    const second = planBaseRequests(s);
    expect(second.phase).toBe('complete');
    expect(second.requests).toEqual([]);
  });

  it('plans only the new part when asOf moves on', () => {
    let s = state();
    s = { ...s, coverage: withCovered(s, planBaseRequests(s).requests) };
    const later = planBaseRequests({ ...s, asOf: ASOF + 2 * HOUR });
    expect(later.phase).toBe('initial');
    // Only daily bars on the graduation pool are open: the minute windows ended long ago.
    expect(later.requests.map((r) => `${r.poolAddress}:${r.resolution}`)).toEqual(['GRAD:86400']);
    expect(later.requests[0]!.cover).toEqual({ from: ASOF, to: ASOF + 2 * HOUR });
  });
});

describe('follow-up phase: hourly bars', () => {
  const dailyState = (days: number[], limits: PlanState['limits'] = undefined): PlanState => {
    const s = state({
      daily: { GRAD: dayBars(...days), CURVE: dayBars(T0) },
      limits: { ...EXHAUSTIVE_PLAN_LIMITS, ...limits },
    });
    return { ...s, coverage: withCovered(s, planBaseRequests(s).requests) };
  };

  it('fetches hourly bars for a primary pool over the stretch with daily bars', () => {
    const s = dailyState([T0, T0 + 1 * DAY, T0 + 2 * DAY]);
    const p = planBaseRequests(s);
    expect(p.phase).toBe('followup');
    const grad = by(p.requests, 'GRAD', 3600);
    expect(grad).toHaveLength(1);
    expect(grad[0]!.reason).toBe('hourly_life');
    expect(grad[0]!.cover).toEqual({ from: T0, to: T0 + 3 * DAY });
    const curve = by(p.requests, 'CURVE', 3600);
    expect(curve).toHaveLength(1);
    expect(curve[0]!.cover).toEqual({ from: T0, to: T0 + DAY });
  });

  it('skips long empty stretches but joins short gaps', () => {
    // Days 0 and 20 are joined (a 19-day gap fits in one request); day 300 is not.
    const s = dailyState([T0, T0 + 20 * DAY, T0 + 300 * DAY]);
    const grad = by(planBaseRequests(s).requests, 'GRAD', 3600);
    const covers = mergeIntervals(grad.map((r) => r.cover));
    expect(covers).toEqual([
      { from: T0, to: T0 + 21 * DAY },
      { from: T0 + 300 * DAY, to: T0 + 301 * DAY },
    ]);
  });

  it('pages hourly bars at 1,500 per request', () => {
    // 100 consecutive days = 2,400 hours = two requests.
    const days = Array.from({ length: 100 }, (_, i) => T0 + i * DAY);
    const grad = by(planBaseRequests(dailyState(days)).requests, 'GRAD', 3600);
    expect(grad).toHaveLength(2);
    expect(grad.every((r) => r.buckets <= 1500)).toBe(true);
    expect(mergeIntervals(grad.map((r) => r.cover))).toEqual([{ from: T0, to: T0 + 100 * DAY }]);
  });

  it('caps hourly requests per coin, keeping the first windows, and says so', () => {
    // 400 consecutive days is 9,600 hours: seven windows. A cap of 3 keeps the first three.
    const days = Array.from({ length: 400 }, (_, i) => T0 + i * DAY);
    const s = dailyState(days, { maxHourlyRequests: 3 });
    const p = planBaseRequests(s);
    const grad = by(p.requests, 'GRAD', 3600);
    expect(grad).toHaveLength(3);
    expect(p.hourly.capHit).toBe(true);
    expect(p.hourly.deferredWindows).toBeGreaterThan(0);
    expect(Math.max(...grad.map((r) => r.cover.to))).toBeLessThan(T0 + 400 * DAY);
    // The cap is on the whole plan, so the curve's hourly request is among the three or dropped.
    expect(p.requests.filter((r) => r.resolution === 3600).length).toBeLessThanOrEqual(3);

    // After those are made, the same cap plans nothing more (no creeping past the cap).
    const again = planBaseRequests({ ...s, coverage: withCovered(s, p.requests) });
    expect(again.requests).toEqual([]);
    expect(again.phase).toBe('complete');
  });

  it('does not report the cap when everything fits', () => {
    const p = planBaseRequests(dailyState([T0, T0 + DAY]));
    expect(p.hourly).toEqual({ capHit: false, deferredWindows: 0 });
  });
});

describe('other pools', () => {
  const base = (): PlanState => {
    const s = state({ pools: [CURVE, GRADPOOL, other('A'), other('B')] });
    return { ...s, coverage: withCovered(s, planBaseRequests(s).requests) };
  };

  it('fetches hourly bars only for days with enough liquidity, from the first such day', () => {
    const s = base();
    const withDaily: PlanState = {
      ...s,
      daily: {
        GRAD: dayBars(),
        CURVE: dayBars(),
        // Liquid on days 3, 4 and 9 only.
        OTHER_A: summarizeDaily(
          [
            { t: T0 + 1 * DAY, liquidityUsd: 100 },
            { t: T0 + 2 * DAY, liquidityUsd: null },
            { t: T0 + 3 * DAY, liquidityUsd: 5_000 },
            { t: T0 + 4 * DAY, liquidityUsd: 9_000 },
            { t: T0 + 5 * DAY, liquidityUsd: 4_999.99 },
            { t: T0 + 9 * DAY, liquidityUsd: 6_000 },
          ],
          5_000,
        ),
        // Never liquid enough.
        OTHER_B: summarizeDaily([{ t: T0 + DAY, liquidityUsd: 10 }], 5_000),
      },
    };
    const p = planBaseRequests(withDaily);
    const a = by(p.requests, 'OTHER_A', 3600);
    expect(a.every((r) => r.reason === 'secondary_hourly')).toBe(true);
    expect(mergeIntervals(a.map((r) => r.cover))).toEqual([
      { from: T0 + 3 * DAY, to: T0 + 5 * DAY },
      { from: T0 + 9 * DAY, to: T0 + 10 * DAY },
    ]);
    expect(by(p.requests, 'OTHER_B', 3600)).toEqual([]);
    expect(p.requests.filter((r) => r.resolution === 60)).toEqual([]);
  });
});

describe('graduation time unknown', () => {
  it('derives the minute window from the first daily bar of the graduation pool', () => {
    const pools: PlanPool[] = [{ address: 'GRAD', role: 'graduation', createdAt: null }];
    const s = state({ graduatedAt: null, pools, launchedAt: LAUNCH });
    expect(by(planBaseRequests(s).requests, 'GRAD', 60)).toEqual([]);
    const covered = { ...s, coverage: withCovered(s, planBaseRequests(s).requests) };
    const next = planBaseRequests({ ...covered, daily: { GRAD: dayBars(T0 + 2 * DAY) } });
    const minute = by(next.requests, 'GRAD', 60);
    expect(minute.length).toBeGreaterThan(0);
    expect(minute.every((r) => r.reason === 'post_graduation_minute')).toBe(true);
    expect(mergeIntervals(minute.map((r) => r.cover))[0]!.to).toBe(T0 + 4 * DAY);
  });
});

describe('peak refinement', () => {
  const s0 = (): PlanState => {
    const s = state();
    return { ...s, coverage: withCovered(s, planBaseRequests(s).requests) };
  };
  const hourTarget = (t: number, pool = 'GRAD') => ({
    poolAddress: pool,
    t,
    resolution: 3600 as const,
  });

  it('asks for the 1-minute bars of the highest target', () => {
    const t = T0 + 200 * DAY + 5 * HOUR;
    const r = planPeakRefinement(s0(), [hourTarget(t), hourTarget(t + HOUR)], 0);
    expect(r.request).toMatchObject({
      poolAddress: 'GRAD',
      resolution: 60,
      reason: 'peak_refinement',
      from: t,
      to: t + HOUR,
      buckets: 60,
    });
    expect(r.capHit).toBe(false);
  });

  it('asks for a whole day of minutes for a daily target, in one request', () => {
    const t = T0 + 200 * DAY;
    const r = planPeakRefinement(s0(), [{ poolAddress: 'GRAD', t, resolution: 86400 }], 0);
    expect(r.request).toMatchObject({ from: t, to: t + DAY, buckets: 1440 });
  });

  it('moves to the next target when the first already has its minutes', () => {
    const s = s0();
    const t = T0 + 200 * DAY;
    const covered: PlanState = {
      ...s,
      coverage: {
        ...s.coverage,
        GRAD: {
          ...s.coverage['GRAD'],
          60: [...s.coverage['GRAD']![60]!, { from: t, to: t + HOUR }],
        },
      },
    };
    const r = planPeakRefinement(covered, [hourTarget(t), hourTarget(t + 5 * HOUR)], 0);
    expect(r.request!.from).toBe(t + 5 * HOUR);
  });

  it('reports exhausted when every target is covered', () => {
    const s = s0();
    const t = T0 + 200 * DAY;
    const covered: PlanState = {
      ...s,
      coverage: {
        ...s.coverage,
        GRAD: {
          ...s.coverage['GRAD'],
          60: [...s.coverage['GRAD']![60]!, { from: t, to: t + HOUR }],
        },
      },
    };
    expect(planPeakRefinement(covered, [hourTarget(t)], 0)).toEqual({
      request: null,
      capHit: false,
      exhausted: true,
    });
    expect(planPeakRefinement(covered, [], 0).exhausted).toBe(true);
  });

  it('stops at the cap and says so, 12 by default', () => {
    expect(DEFAULT_PLAN_LIMITS.maxRefinementRequests).toBe(12);
    const t = T0 + 200 * DAY;
    expect(planPeakRefinement(s0(), [hourTarget(t)], 11).request).not.toBeNull();
    expect(planPeakRefinement(s0(), [hourTarget(t)], 12)).toEqual({
      request: null,
      capHit: true,
      exhausted: false,
    });
    const s = { ...s0(), limits: { maxRefinementRequests: 2 } };
    expect(planPeakRefinement(s, [hourTarget(t)], 2).capHit).toBe(true);
  });

  it('does not ask past asOf', () => {
    const r = planPeakRefinement(
      s0(),
      [{ poolAddress: 'GRAD', t: floorDay(ASOF), resolution: 86400 }],
      0,
    );
    expect(r.request!.cover.to).toBe(ASOF);
  });
});

const floorDay = (t: number): number => Math.floor(t / DAY) * DAY;

describe('estimate', () => {
  it('reports initial units exactly and the hourly part as an upper bound before daily bars exist', () => {
    const e = estimateCoinUnits(state({ pools: [CURVE, GRADPOOL, other('A')] }));
    const plan = planBaseRequests(state({ pools: [CURVE, GRADPOOL, other('A')] }));
    expect(e.initialRequests).toBe(plan.requests.length);
    expect(e.initialUnits).toBe(plan.estimatedUnits);
    expect(e.hourlyIsUpperBound).toBe(true);
    expect(e.hourlyRequests).toBeLessThanOrEqual(DEFAULT_PLAN_LIMITS.maxHourlyRequests);
    expect(e.refinementCapUnits).toBe(48);
    expect(e.upperBoundUnits).toBe(e.initialUnits + e.hourlyUnits + 48);
    expect(e.typicalUnits).toBe(e.initialUnits + e.hourlyUnits);
  });

  it('is exact for the hourly part once the daily bars are known', () => {
    const s = state({ daily: { GRAD: dayBars(T0, T0 + DAY), CURVE: dayBars(T0) } });
    const covered = { ...s, coverage: withCovered(s, planBaseRequests(s).requests) };
    const e = estimateCoinUnits(covered);
    expect(e.hourlyIsUpperBound).toBe(false);
    expect(e.initialRequests).toBe(0);
    expect(e.hourlyRequests).toBe(planBaseRequests(covered).requests.length);
  });
});
