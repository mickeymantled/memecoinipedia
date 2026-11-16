import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PLAN_LIMITS,
  EXHAUSTIVE_PLAN_LIMITS,
  estimateCoinUnits,
  packHourlyWindows,
  planBaseRequests,
  planPeakRefinement,
  summarizeDaily,
  type BasePlan,
  type Interval,
  type PlanPool,
  type PlanState,
  type PlannedRequest,
  type PoolDaily,
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

/** What stage 0 gives: the graduation pool named by launch info, no creation time. */
const GRADP: PlanPool = { address: 'GRAD', role: 'graduation', createdAt: null };
const CURVE: PlanPool = { address: 'CURVE', role: 'curve', createdAt: LAUNCH };
const other = (n: string): PlanPool => ({ address: `OTHER_${n}`, role: 'other', createdAt: null });

/** A daily summary with the highs given directly in USD, so thresholds are exact. */
function pd(entries: [t: number, highUsd: number][], firstOpen = 0, liquid = true): PoolDaily {
  const days = entries.map((e) => e[0]);
  const highs = entries.map((e) => e[1]);
  return {
    first: days[0] ?? null,
    last: days[days.length - 1] ?? null,
    days,
    highs,
    maxHigh: highs.length > 0 ? Math.max(...highs) : null,
    firstOpen: days.length > 0 ? firstOpen : null,
    qualifyingDays: liquid ? days : [],
  };
}

function sstate(over: Partial<PlanState> = {}): PlanState {
  return {
    asOf: ASOF,
    launchedAt: LAUNCH,
    graduatedAt: GRAD,
    pools: [GRADP],
    coverage: {},
    daily: {},
    roughAthUsd: null,
    poolsListed: false,
    ...over,
  };
}

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

const by = (requests: readonly PlannedRequest[], address: string, res: ResolutionSec) =>
  requests.filter((r) => r.poolAddress === address && r.resolution === res);

const after = (s: PlanState, plan: BasePlan): PlanState => ({
  ...s,
  coverage: withCovered(s, plan.requests),
});

/**
 * Plays the plan to the end the way the fetcher does: makes every planned
 * request (its cover becomes coverage), and when asked for the pool list stores
 * `listed`. The daily summaries are given up front; the plan reads them only
 * after the daily requests are covered.
 */
function runToEnd(
  start: PlanState,
  listed: readonly PlanPool[] = [],
): { requests: PlannedRequest[]; final: BasePlan; state: PlanState; lookups: number } {
  let s = start;
  const requests: PlannedRequest[] = [];
  let lookups = 0;
  for (let i = 0; i < 30; i++) {
    const plan = planBaseRequests(s);
    if (plan.requests.length > 0) {
      requests.push(...plan.requests);
      s = after(s, plan);
      continue;
    }
    if (plan.needsPoolList && !s.poolsListed) {
      lookups += 1;
      s = {
        ...s,
        poolsListed: true,
        pools: [...s.pools, ...listed.filter((p) => !s.pools.some((q) => q.address === p.address))],
      };
      continue;
    }
    return { requests, final: plan, state: s, lookups };
  }
  throw new Error('plan did not finish');
}

describe('staged plan: the defaults', () => {
  it('has the lead numbers and is the default', () => {
    expect(DEFAULT_PLAN_LIMITS).toMatchObject({
      staged: true,
      screenBelowUsd: 90_000,
      fullPathFromUsd: 1_000_000,
      hourlyFromUsd: 80_000,
      curveFromUsd: 90_000,
      escalationRatio: 1.5,
      maxHourlyRequests: 8,
      maxHourlyRequestsFull: 24,
      maxRefinementRequests: 12,
    });
    expect(EXHAUSTIVE_PLAN_LIMITS).toEqual({ staged: false });
  });

  it('summarizes daily bars into market-cap highs, the largest and the first open', () => {
    const d = summarizeDaily(
      [
        { t: T0 + DAY, liquidityUsd: 1, o: 2e-5, h: 3e-5, l: 1e-5, c: 2e-5 },
        { t: T0, liquidityUsd: 9_000, o: 1e-5, h: 5e-5, l: 1e-5, c: 2e-5 },
      ],
      5_000,
    );
    expect(d.days).toEqual([T0, T0 + DAY]);
    expect(d.highs[0]).toBeCloseTo(50_000, 6);
    expect(d.highs[1]).toBeCloseTo(30_000, 6);
    expect(d.maxHigh).toBeCloseTo(50_000, 6);
    expect(d.firstOpen).toBeCloseTo(10_000, 6);
    expect(d.qualifyingDays).toEqual([T0]);
    expect(summarizeDaily([], 5_000)).toMatchObject({ maxHigh: null, firstOpen: null, highs: [] });
  });
});

describe('stage 1: the screen', () => {
  it('asks for one request of daily bars of the primary pool, whole life, and nothing else', () => {
    const p = planBaseRequests(sstate());
    expect(p.phase).toBe('initial');
    expect(p.stage.path).toBe('screen');
    expect(p.needsPoolList).toBe(false);
    expect(p.requests).toHaveLength(1);
    expect(p.requests[0]).toMatchObject({
      poolAddress: 'GRAD',
      resolution: 86400,
      reason: 'daily_life',
      estimatedUnits: 4,
    });
    expect(p.requests[0]!.cover).toEqual({ from: T0, to: ASOF });
  });

  it('stops under the line: screened out, one request in all, no pool list', () => {
    const s = after(sstate({ daily: { GRAD: pd([[T0, 89_999]]) } }), planBaseRequests(sstate()));
    const p = planBaseRequests(s);
    expect(p.phase).toBe('complete');
    expect(p.requests).toEqual([]);
    expect(p.needsPoolList).toBe(false);
    expect(p.stage).toEqual({ path: 'light', w: 89_999, escalated: false, screenedOut: true });
  });

  it('does not screen out at exactly the line', () => {
    const s = after(sstate({ daily: { GRAD: pd([[T0, 90_000]]) } }), planBaseRequests(sstate()));
    const p = planBaseRequests(s);
    expect(p.stage.screenedOut).toBe(false);
    expect(p.requests.length).toBeGreaterThan(0);
  });

  it('a coin with no graduation pool is screened on its bonding curve', () => {
    const base = sstate({ pools: [CURVE], graduatedAt: null, poolsListed: true });
    const first = planBaseRequests(base);
    expect(first.requests).toHaveLength(1);
    expect(first.requests[0]).toMatchObject({ poolAddress: 'CURVE', resolution: 86400 });
    expect(first.requests[0]!.cover).toEqual({ from: T0, to: ASOF });
    const low = planBaseRequests(after({ ...base, daily: { CURVE: pd([[T0, 60_000]]) } }, first));
    expect(low.stage.screenedOut).toBe(true);
    const high = planBaseRequests(after({ ...base, daily: { CURVE: pd([[T0, 200_000]]) } }, first));
    // The curve is primary: its first 1,500 minutes from launch, no curve tail on top.
    expect(high.requests.map((r) => `${r.poolAddress}:${r.resolution}:${r.reason}`)).toEqual([
      'CURVE:60:primary_minute',
    ]);
    expect(high.requests[0]!.cover.from).toBe(Math.floor((LAUNCH - 5 * MIN) / MIN) * MIN);
  });

  it('with no pool known, asks for the pool list', () => {
    const p = planBaseRequests(sstate({ pools: [] }));
    expect(p.requests).toEqual([]);
    expect(p.needsPoolList).toBe(true);
    expect(planBaseRequests(sstate({ pools: [], poolsListed: true })).needsPoolList).toBe(false);
  });
});

describe('stage 1: escalation by the Dune peak', () => {
  const screened = (rough: number | null, w = 50_000, extra: Partial<PlanState> = {}): PlanState =>
    after(
      sstate({ daily: { GRAD: pd([[T0, w]]) }, roughAthUsd: rough, ...extra }),
      planBaseRequests(sstate()),
    );

  it('screens out when the Dune peak is at most 1.5 times W, or unknown', () => {
    expect(planBaseRequests(screened(75_000)).stage.screenedOut).toBe(true);
    expect(planBaseRequests(screened(null)).stage.screenedOut).toBe(true);
    expect(planBaseRequests(screened(10_000)).stage.screenedOut).toBe(true);
  });

  it('does not screen out above 1.5 times W: it goes to the full path and wants the pool list', () => {
    const p = planBaseRequests(screened(75_001));
    expect(p.stage).toEqual({ path: 'full', w: 50_000, escalated: true, screenedOut: false });
    expect(p.needsPoolList).toBe(true);
    expect(p.requests).toEqual([]);
    expect(p.phase).toBe('complete');
  });

  it('fetches the other pools daily bars next, then recomputes W over all pools', () => {
    const base = screened(500_000, 50_000, { poolsListed: true, pools: [GRADP, other('A')] });
    const ask = planBaseRequests(base);
    expect(ask.phase).toBe('initial');
    expect(ask.requests.map((r) => `${r.poolAddress}:${r.resolution}`)).toEqual(['OTHER_A:86400']);
    expect(ask.requests[0]!.cover).toEqual({ from: T0, to: ASOF });

    // Still under the line over every pool: screened out after all.
    const quiet = planBaseRequests(
      after({ ...base, daily: { ...base.daily, OTHER_A: pd([[T0, 60_000]]) } }, ask),
    );
    expect(quiet.phase).toBe('complete');
    expect(quiet.stage).toEqual({ path: 'full', w: 60_000, escalated: true, screenedOut: true });

    // The trading was in the other pool: the coin goes on, with W over both.
    const loud = planBaseRequests(
      after({ ...base, daily: { ...base.daily, OTHER_A: pd([[T0, 400_000]]) } }, ask),
    );
    expect(loud.stage).toEqual({ path: 'full', w: 400_000, escalated: true, screenedOut: false });
    expect(by(loud.requests, 'GRAD', 60)).toHaveLength(1);
  });

  it('a Dune peak with no pools to find costs only the lookup: still screened out', () => {
    const r = runToEnd(screened(500_000), []);
    expect(r.lookups).toBe(1);
    expect(r.final.stage.screenedOut).toBe(true);
    // Nothing after the screen, which `screened` already made: no minutes, no hourly bars.
    expect(r.requests).toEqual([]);
  });
});

describe('stage 2: the light path', () => {
  const daily = {
    GRAD: pd(
      [
        [T0, 500_000],
        [T0 + DAY, 85_000],
        [T0 + 5 * DAY, 60_000],
      ],
      20_000,
    ),
  };
  const screenDone = (extra: Partial<PlanState> = {}): PlanState =>
    after(sstate({ daily, ...extra }), planBaseRequests(sstate()));

  it('takes one request of 1,500 minutes from five minutes before the pool began trading', () => {
    const p = planBaseRequests(screenDone());
    expect(p.stage).toEqual({ path: 'light', w: 500_000, escalated: false, screenedOut: false });
    expect(p.needsPoolList).toBe(false);
    expect(p.requests).toHaveLength(1);
    const from = Math.floor((GRAD - 5 * MIN) / MIN) * MIN;
    expect(p.requests[0]).toMatchObject({
      poolAddress: 'GRAD',
      resolution: 60,
      reason: 'primary_minute',
      from,
      to: from + 1_500 * MIN,
      buckets: 1_500,
    });
  });

  it('takes the primary pool only: no curve, no other pools, no pool list, all the way', () => {
    const r = runToEnd(screenDone(), [CURVE, other('A')]);
    expect(r.lookups).toBe(0);
    expect(new Set(r.requests.map((x) => x.poolAddress))).toEqual(new Set(['GRAD']));
    expect(r.final.phase).toBe('complete');
  });

  it('then packs hourly bars: days at or above $80,000 that the minutes do not cover', () => {
    const minute = after(screenDone(), planBaseRequests(screenDone()));
    const p = planBaseRequests(minute);
    expect(p.phase).toBe('followup');
    // Day 0 (500k) is not wholly inside the 25 hours of minutes; its window runs 1,500 hours from the
    // first uncovered time, so it also takes day 1 (85k). Day 5 is under $80,000.
    expect(p.requests).toHaveLength(1);
    expect(p.requests[0]).toMatchObject({
      poolAddress: 'GRAD',
      resolution: 3600,
      reason: 'hourly_life',
      from: T0,
      to: T0 + 1_500 * HOUR,
      buckets: 1_500,
    });
  });

  it('skips a day that is below $80,000 or wholly inside 1-minute coverage', () => {
    const d = { GRAD: pd([[T0 + 3 * DAY, 79_999]]) };
    const s = after(
      after(sstate({ daily: d }), planBaseRequests(sstate())),
      planBaseRequests(after(sstate({ daily: d }), planBaseRequests(sstate()))),
    );
    // W of 79,999 would screen out; give the coin one big day so the path continues.
    expect(planBaseRequests(s).stage.screenedOut).toBe(true);
    expect(
      packHourlyWindows(
        [T0 + 3 * DAY],
        [{ from: T0 + 3 * DAY - HOUR, to: T0 + 4 * DAY + HOUR }],
        [],
        ASOF,
      ),
    ).toEqual([]);
  });

  it('plans nothing on a second run, and only the new part when asOf moves', () => {
    const r = runToEnd(screenDone());
    expect(planBaseRequests(r.state).requests).toEqual([]);
    expect(planBaseRequests(r.state).phase).toBe('complete');
    const later = planBaseRequests({ ...r.state, asOf: ASOF + 2 * HOUR });
    expect(later.requests.map((x) => `${x.poolAddress}:${x.resolution}`)).toEqual(['GRAD:86400']);
    expect(later.requests[0]!.cover).toEqual({ from: ASOF, to: ASOF + 2 * HOUR });
  });
});

describe('greedy hourly packing', () => {
  const d = (n: number) => T0 + n * DAY;

  it('starts a window at the first uncovered day and runs 1,500 hours (62.5 days)', () => {
    const w = packHourlyWindows([d(0), d(1), d(61)], [], [], ASOF);
    expect(w).toEqual([{ from: d(0), to: d(0) + 1_500 * HOUR }]);
  });

  it('opens the next window at the next qualifying day it does not cover, and never joins across gaps', () => {
    const w = packHourlyWindows([d(0), d(10), d(70), d(71), d(200), d(201)], [], [], ASOF);
    expect(w).toEqual([
      { from: d(0), to: d(0) + 1_500 * HOUR },
      { from: d(70), to: d(70) + 1_500 * HOUR },
      { from: d(200), to: d(200) + 1_500 * HOUR },
    ]);
  });

  it('starts the next window where the last one ended when a day straddles the boundary', () => {
    // Day 62 is half inside the first window (62.5 days long): the next starts at its second half.
    const w = packHourlyWindows([d(0), d(62)], [], [], ASOF);
    expect(w).toHaveLength(2);
    expect(w[1]!.from).toBe(d(0) + 1_500 * HOUR);
  });

  it('leaves out days already covered by hourly or minute bars, and clips at asOf', () => {
    expect(packHourlyWindows([d(5)], [], [{ from: d(5), to: d(6) }], ASOF)).toEqual([]);
    expect(packHourlyWindows([d(5)], [{ from: d(4), to: d(7) }], [], ASOF)).toEqual([]);
    const last = Math.floor(ASOF / DAY) * DAY;
    expect(packHourlyWindows([last], [], [], ASOF)).toEqual([{ from: last, to: ASOF }]);
    expect(packHourlyWindows([last + DAY], [], [], ASOF)).toEqual([]);
    // Half the day is inside minute coverage: the window starts at the first uncovered hour.
    expect(
      packHourlyWindows([d(5)], [{ from: d(5), to: d(5) + 12 * HOUR + 30 * MIN }], [], ASOF),
    ).toEqual([{ from: d(5) + 12 * HOUR, to: d(5) + 12 * HOUR + 1_500 * HOUR }]);
  });

  it('caps the windows per coin: 8 on the light path, 24 on the full path, and says so', () => {
    const days = [0, 100, 200, 300].map(d).map((t): [number, number] => [t, 200_000]);
    const limits = { maxHourlyRequests: 2, maxHourlyRequestsFull: 3 };
    const base = (extra: Partial<PlanState>): PlanState =>
      sstate({ asOf: d(400), daily: { GRAD: pd(days, 10_000) }, limits, ...extra });

    const light = runToEnd(base({}));
    const lightHourly = light.requests.filter((r) => r.resolution === 3600);
    expect(lightHourly).toHaveLength(2);
    // The cap is on the coin's life, so a later run plans nothing more, and asks for no more.
    const again = planBaseRequests(light.state);
    expect(again.requests).toEqual([]);
    expect(again.hourly.capHit).toBe(true);
    expect(again.hourly.deferredWindows).toBe(2);

    const full = runToEnd(base({ roughAthUsd: 5_000_000 }), []);
    const fullHourly = full.requests.filter((r) => r.resolution === 3600);
    expect(fullHourly).toHaveLength(3);
    expect(planBaseRequests(full.state).hourly).toEqual({ capHit: true, deferredWindows: 1 });
  });
});

describe('stage 3: the full path', () => {
  const A = other('A');
  const B = other('B');
  const D = (n: number) => T0 + n * DAY;

  it('is taken when W is at or above $1,000,000, and wants the pool list first', () => {
    const base = after(
      sstate({ daily: { GRAD: pd([[T0, 1_000_000]]) } }),
      planBaseRequests(sstate()),
    );
    const p = planBaseRequests(base);
    expect(p.stage).toEqual({ path: 'full', w: 1_000_000, escalated: false, screenedOut: false });
    expect(p.needsPoolList).toBe(true);
    expect(p.requests).toEqual([]);
    const light = after(
      sstate({ daily: { GRAD: pd([[T0, 999_999]]) } }),
      planBaseRequests(sstate()),
    );
    expect(planBaseRequests(light).stage.path).toBe('light');
  });

  it('adds daily bars and liquid-day hourly bars for the other pools', () => {
    const daily = {
      GRAD: pd([[D(0), 2_000_000]], 20_000),
      OTHER_A: {
        ...pd([
          [D(10), 200_000],
          [D(11), 50_000],
          [D(12), 300_000],
        ]),
        qualifyingDays: [D(10), D(11)], // day 12 is not liquid enough
      },
      OTHER_B: pd([[D(10), 900_000]], 0, false), // never liquid
    };
    const r = runToEnd(sstate({ daily }), [A, B]);
    expect(r.lookups).toBe(1);
    expect(by(r.requests, 'OTHER_A', 86400)).toHaveLength(1);
    expect(by(r.requests, 'OTHER_B', 86400)).toHaveLength(1);
    expect(by(r.requests, 'OTHER_A', 60)).toEqual([]);
    const a = by(r.requests, 'OTHER_A', 3600);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ reason: 'secondary_hourly', from: D(10), buckets: 1_500 });
    expect(by(r.requests, 'OTHER_B', 3600)).toEqual([]);
    // The primary pool gets its minutes and hourly bars as on the light path.
    expect(by(r.requests, 'GRAD', 60)).toHaveLength(1);
    expect(by(r.requests, 'GRAD', 3600).length).toBeGreaterThan(0);
    expect(planBaseRequests(r.state).requests).toEqual([]);
  });

  it('plans nothing on a second run', () => {
    const daily = { GRAD: pd([[D(0), 2_000_000]], 20_000), OTHER_A: pd([[D(1), 100_000]]) };
    const r = runToEnd(sstate({ daily }), [A]);
    const again = runToEnd(r.state, [A]);
    expect(again.requests).toEqual([]);
    expect(again.lookups).toBe(0);
  });
});

describe('the bonding curve', () => {
  const grad = (firstOpen: number) => ({ GRAD: pd([[T0, 500_000]], firstOpen) });
  const screened = (firstOpen: number, extra: Partial<PlanState> = {}): PlanState =>
    after(sstate({ daily: grad(firstOpen), ...extra }), planBaseRequests(sstate()));

  it('is not fetched when the graduation pool opens under $90,000', () => {
    const r = runToEnd(screened(89_999, { pools: [GRADP, CURVE], poolsListed: true }));
    expect(by(r.requests, 'CURVE', 60)).toEqual([]);
    expect(r.lookups).toBe(0);
  });

  it('is fetched, its last 1,500 minutes, when the pool opens at $90,000 or more', () => {
    const p = planBaseRequests(screened(90_000, { pools: [GRADP, CURVE], poolsListed: true }));
    const curve = by(p.requests, 'CURVE', 60);
    expect(curve).toHaveLength(1);
    const to = Math.ceil(GRAD / MIN) * MIN;
    // The curve lived 6h41m: from launch, which is shorter than 1,500 minutes.
    expect(curve[0]).toMatchObject({ reason: 'curve_tail', to });
    expect(curve[0]!.cover).toEqual({ from: Math.floor(LAUNCH / MIN) * MIN, to });
    expect(curve[0]!.buckets).toBeLessThan(1_500);
    expect(by(p.requests, 'GRAD', 60)).toHaveLength(1); // alongside the pool's own minutes
  });

  it('is capped at 1,500 minutes before graduation for a long-lived curve', () => {
    const p = planBaseRequests(
      screened(120_000, {
        pools: [GRADP, CURVE],
        poolsListed: true,
        launchedAt: GRAD - 30 * DAY,
      }),
    );
    const curve = by(p.requests, 'CURVE', 60)[0]!;
    const to = Math.ceil(GRAD / MIN) * MIN;
    expect(curve.buckets).toBe(1_500);
    expect(curve.cover).toEqual({ from: to - 1_500 * MIN, to });
  });

  it('needs the pool list when the curve is not stored, and only then', () => {
    const p = planBaseRequests(screened(90_000));
    expect(p.needsPoolList).toBe(true);
    expect(by(p.requests, 'GRAD', 60)).toHaveLength(1);
    const r = runToEnd(screened(90_000), [CURVE]);
    expect(r.lookups).toBe(1);
    expect(by(r.requests, 'CURVE', 60)).toHaveLength(1);
    // A list that holds no curve is not asked for again.
    const none = runToEnd(screened(90_000), []);
    expect(none.lookups).toBe(1);
    expect(by(none.requests, 'CURVE', 60)).toEqual([]);
    expect(planBaseRequests(none.state).needsPoolList).toBe(false);
    // Under the line the list is never needed.
    expect(runToEnd(screened(50_000)).lookups).toBe(0);
  });
});

describe('peak refinement: windows of 1,500 minutes', () => {
  const s0 = (extra: Partial<PlanState> = {}): PlanState => sstate({ ...extra });
  const t = T0 + 200 * DAY + 5 * HOUR;

  it('centres the window on an hourly target', () => {
    const r = planPeakRefinement(s0(), [{ poolAddress: 'GRAD', t, resolution: 3600 }], 0);
    expect(r.request).toMatchObject({
      poolAddress: 'GRAD',
      resolution: 60,
      reason: 'peak_refinement',
      from: t - 12 * HOUR,
      to: t + 13 * HOUR,
      buckets: 1_500,
    });
    // The target hour is inside it.
    expect(r.request!.from).toBeLessThanOrEqual(t);
    expect(r.request!.to).toBeGreaterThanOrEqual(t + HOUR);
  });

  it('starts the window at a daily target', () => {
    const day = T0 + 200 * DAY;
    const r = planPeakRefinement(s0(), [{ poolAddress: 'GRAD', t: day, resolution: 86400 }], 0);
    expect(r.request).toMatchObject({ from: day, to: day + 1_500 * MIN, buckets: 1_500 });
  });

  it('clips the window at asOf', () => {
    const day = Math.floor(ASOF / DAY) * DAY;
    const r = planPeakRefinement(s0(), [{ poolAddress: 'GRAD', t: day, resolution: 86400 }], 0);
    expect(r.request!.cover).toEqual({ from: day, to: ASOF });
    const hour = Math.floor(ASOF / HOUR) * HOUR;
    const h = planPeakRefinement(s0(), [{ poolAddress: 'GRAD', t: hour, resolution: 3600 }], 0);
    expect(h.request!.cover.to).toBe(ASOF);
  });

  it('takes out what is covered, keeping the part that holds the target', () => {
    const covered = s0({ coverage: { GRAD: { 60: [{ from: t - 12 * HOUR, to: t - HOUR }] } } });
    const r = planPeakRefinement(covered, [{ poolAddress: 'GRAD', t, resolution: 3600 }], 0);
    expect(r.request).toMatchObject({ from: t - HOUR, to: t + 13 * HOUR, buckets: 840 });
  });

  it('moves on when the target is covered, and reports exhausted at the end', () => {
    const covered = s0({
      coverage: { GRAD: { 60: [{ from: t - 12 * HOUR, to: t + 13 * HOUR }] } },
    });
    const next = planPeakRefinement(
      covered,
      [
        { poolAddress: 'GRAD', t, resolution: 3600 },
        { poolAddress: 'GRAD', t: t + 100 * DAY, resolution: 3600 },
      ],
      0,
    );
    expect(next.request!.from).toBe(t + 100 * DAY - 12 * HOUR);
    expect(planPeakRefinement(covered, [{ poolAddress: 'GRAD', t, resolution: 3600 }], 0)).toEqual({
      request: null,
      capHit: false,
      exhausted: true,
    });
  });

  it('stops at the cap, 12, and says so', () => {
    const target = [{ poolAddress: 'GRAD', t, resolution: 3600 as const }];
    expect(planPeakRefinement(s0(), target, 11).request).not.toBeNull();
    expect(planPeakRefinement(s0(), target, 12)).toEqual({
      request: null,
      capHit: true,
      exhausted: false,
    });
  });
});

describe('estimate (staged)', () => {
  it('counts the screen request exactly and bounds the hourly part by the cap', () => {
    const e = estimateCoinUnits(sstate());
    expect(e.initialRequests).toBe(1);
    expect(e.initialUnits).toBe(4);
    expect(e.hourlyIsUpperBound).toBe(true);
    expect(e.hourlyRequests).toBe(8);
    expect(e.upperBoundUnits).toBe(4 + 32 + 48);
  });

  it('is exact and small for a screened-out coin', () => {
    const screenedOut = after(
      sstate({ daily: { GRAD: pd([[T0, 1_000]]) } }),
      planBaseRequests(sstate()),
    );
    const e = estimateCoinUnits(screenedOut);
    expect(e.initialUnits).toBe(0);
    expect(e.hourlyUnits).toBe(0);
    expect(e.hourlyIsUpperBound).toBe(false);
  });
});
