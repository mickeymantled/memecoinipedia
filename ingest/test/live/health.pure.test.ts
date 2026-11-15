/**
 * The limits of `live health`, tested with plain objects: `evaluateHealth` is a pure function of
 * the facts and the limits. Each check has a figure that makes it alert, one just inside the alert
 * limit, and one inside the warn limit.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HEALTH_LIMITS as L,
  applyLimitOverrides,
  evaluateHealth,
  formatHealth,
  healthExitCode,
  summarize,
  type HealthCheck,
  type HealthFacts,
} from '../../src/live/health.js';

const NOW = new Date('2026-11-16T12:00:00.000Z');
const ago = (seconds: number): Date => new Date(NOW.getTime() - seconds * 1000);

function healthy(over: Partial<HealthFacts> = {}): HealthFacts {
  return {
    now: NOW,
    lock: { held: true, hint: { kind: 'live', pid: 1, since: ago(3600).toISOString() } },
    liveRun: { id: 7, status: 'running', startedAt: ago(3600) },
    heartbeatAt: ago(10),
    settings: { maxCodexUnitsPerDay: 1000 },
    lastDiscovery: { at: ago(60), status: 'ok' },
    watch: { watched: 10, young: 4, lastPass: { endedAt: ago(30), okAt: ago(30) } },
    stages: [
      {
        stage: 'candles',
        timeoutSeconds: 600,
        running: 0,
        oldestRunningStartedAt: null,
        waitingWatched: 0,
        oldestWaitingAt: null,
        lastFinishedAt: ago(30),
      },
    ],
    failures: [],
    finished24h: { candles: 100 },
    usage: { codexDayUnits: 100, codexMonthUnits: 100, jupiterPausesToday: null },
    refresh: { day: 'day:2026-11-16', done: false },
    ...over,
  };
}

const get = (checks: HealthCheck[], name: string): HealthCheck => {
  const c = checks.find((x) => x.name === name);
  if (!c) throw new Error(`no check ${name}: ${checks.map((x) => x.name).join(', ')}`);
  return c;
};
const level = (f: HealthFacts, name: string, opts = {}) =>
  get(evaluateHealth(f, L, opts), name).level;

describe('a healthy database', () => {
  it('has no alert and no warn', () => {
    const checks = evaluateHealth(healthy());
    expect(checks.filter((c) => c.level !== 'ok')).toEqual([]);
    expect(healthExitCode(summarize(checks, NOW))).toBe(0);
  });

  it('prints one line per check with the level, the figure and the limit', () => {
    const text = formatHealth(summarize(evaluateHealth(healthy()), NOW));
    const lines = text.split('\n');
    expect(lines.length).toBe(evaluateHealth(healthy()).length);
    for (const l of lines) expect(l).toMatch(/^(ok|warn|alert)\s+\S+: .+ \(limit .+\)$/);
  });
});

describe('never run', () => {
  it('says so in one line, a warn, and exits 0', () => {
    const checks = evaluateHealth(healthy({ liveRun: null, lock: { held: false, hint: null } }));
    expect(checks).toHaveLength(1);
    expect(checks[0]!.level).toBe('warn');
    expect(checks[0]!.figure).toContain('never run');
    expect(healthExitCode(summarize(checks, NOW))).toBe(0);
  });
});

describe('exit code', () => {
  it('is 1 for an alert, 0 for a warn', () => {
    const warn = summarize(
      evaluateHealth(
        healthy({ lastDiscovery: { at: ago(L.discoveryWarnSeconds + 1), status: 'ok' } }),
      ),
      NOW,
    );
    expect(warn.status).toBe('warn');
    expect(healthExitCode(warn)).toBe(0);
    const alert = summarize(evaluateHealth(healthy({ lock: { held: false, hint: null } })), NOW);
    expect(alert.status).toBe('alert');
    expect(healthExitCode(alert)).toBe(1);
  });
});

describe('1. process', () => {
  it('alerts when nobody holds the lock', () => {
    expect(level(healthy({ lock: { held: false, hint: null } }), 'process')).toBe('alert');
  });
  it('warns, does not alert, when a backfill holds it', () => {
    const f = healthy({ lock: { held: true, hint: { kind: 'backfill', pid: 2, since: null } } });
    expect(level(f, 'process')).toBe('warn');
  });
  it.each([
    [L.heartbeatWarnSeconds - 1, 'ok'],
    [L.heartbeatWarnSeconds, 'warn'],
    [L.heartbeatAlertSeconds - 1, 'warn'],
    [L.heartbeatAlertSeconds, 'alert'],
  ])('heartbeat %i s old is %s', (age, want) => {
    expect(level(healthy({ heartbeatAt: ago(age) }), 'process')).toBe(want);
  });
  it('judges a missing heartbeat from the start of the run', () => {
    const f = (s: number) =>
      healthy({ heartbeatAt: null, liveRun: { id: 7, status: 'running', startedAt: ago(s) } });
    expect(level(f(20), 'process')).toBe('ok');
    expect(level(f(L.heartbeatAlertSeconds + 1), 'process')).toBe('alert');
  });
});

describe('2. discovery', () => {
  it.each([
    [L.discoveryWarnSeconds - 1, 'ok'],
    [L.discoveryAlertSeconds - 1, 'warn'],
    [L.discoveryAlertSeconds, 'alert'],
  ])('last pass %i s ago is %s', (age, want) => {
    expect(level(healthy({ lastDiscovery: { at: ago(age), status: 'ok' } }), 'discovery')).toBe(
      want,
    );
  });
  it('a failed pass is a warn even when recent', () => {
    expect(level(healthy({ lastDiscovery: { at: ago(30), status: 'error' } }), 'discovery')).toBe(
      'warn',
    );
  });
  it('a long pause at the unit ceiling is a warn, not an alert', () => {
    const f = healthy({
      lastDiscovery: { at: ago(L.discoveryAlertSeconds * 3), status: 'paused' },
    });
    expect(level(f, 'discovery')).toBe('warn');
  });
  it('no pass recorded is judged from the start of the run', () => {
    const f = (s: number) =>
      healthy({ lastDiscovery: null, liveRun: { id: 7, status: 'running', startedAt: ago(s) } });
    expect(level(f(60), 'discovery')).toBe('ok');
    expect(level(f(L.discoveryAlertSeconds + 1), 'discovery')).toBe('alert');
  });
});

describe('3. watch loop', () => {
  // Coins under 3 days old are read every 10 minutes: 3 intervals warn, 6 alert.
  it.each([
    [3 * 600 - 1, 'ok'],
    [6 * 600 - 1, 'warn'],
    [6 * 600, 'alert'],
  ])('last clean pass %i s ago, young coins watched, is %s', (age, want) => {
    expect(
      level(
        healthy({
          watch: { watched: 5, young: 2, lastPass: { endedAt: ago(5), okAt: ago(age) } },
        }),
        'watch:prices',
      ),
    ).toBe(want);
  });
  it('allows hourly intervals when only old coins are watched', () => {
    const f = (age: number) =>
      healthy({
        liveRun: { id: 7, status: 'running', startedAt: ago(10 * 3600) },
        watch: { watched: 5, young: 0, lastPass: { endedAt: ago(5), okAt: ago(age) } },
      });
    expect(level(f(6 * 3600 - 1), 'watch:prices')).toBe('warn');
    expect(level(f(6 * 3600), 'watch:prices')).toBe('alert');
    expect(level(f(3 * 3600 - 1), 'watch:prices')).toBe('ok');
  });
  // The loop runs a pass every 30 s: 10 missed warn, 20 alert.
  it.each([
    [10 * 30 - 1, 'ok'],
    [20 * 30 - 1, 'warn'],
    [20 * 30, 'alert'],
  ])('last pass ended %i s ago is %s', (age, want) => {
    expect(
      level(
        healthy({ watch: { watched: 5, young: 2, lastPass: { endedAt: ago(age), okAt: ago(5) } } }),
        'watch',
      ),
    ).toBe(want);
  });
  it('tells a stopped loop from Jupiter not answering', () => {
    const stopped = healthy({
      watch: { watched: 5, young: 2, lastPass: { endedAt: ago(900), okAt: ago(900) } },
    });
    expect(level(stopped, 'watch')).toBe('alert');
    const failing = healthy({
      watch: { watched: 5, young: 2, lastPass: { endedAt: ago(10), okAt: ago(6 * 600) } },
    });
    expect(level(failing, 'watch')).toBe('ok');
    expect(level(failing, 'watch:prices')).toBe('alert');
  });
  it('warns before the loop has written anything', () => {
    const f = healthy({ watch: { watched: 5, young: 2, lastPass: null } });
    expect(level(f, 'watch')).toBe('warn');
    expect(evaluateHealth(f, L).some((c) => c.name === 'watch:prices')).toBe(false);
  });
  it('warns when every pass of this run had a failed request, alerts once the run is old enough', () => {
    const f = (runAge: number) =>
      healthy({
        liveRun: { id: 7, status: 'running', startedAt: ago(runAge) },
        watch: { watched: 5, young: 2, lastPass: { endedAt: ago(5), okAt: null } },
      });
    expect(level(f(3 * 600 - 1), 'watch:prices')).toBe('ok');
    expect(level(f(6 * 600), 'watch:prices')).toBe('alert');
  });
  it('is quiet about prices with nothing watched, and still reads the loop', () => {
    const f = healthy({
      watch: { watched: 0, young: 0, lastPass: { endedAt: ago(5), okAt: ago(5) } },
    });
    expect(level(f, 'watch')).toBe('ok');
    expect(evaluateHealth(f, L).some((c) => c.name === 'watch:prices')).toBe(false);
  });
});

describe('4. stalled queue', () => {
  const running = (age: number): HealthFacts =>
    healthy({
      stages: [
        {
          stage: 'candles',
          timeoutSeconds: 600,
          running: 3,
          oldestRunningStartedAt: ago(age),
          waitingWatched: 0,
          oldestWaitingAt: null,
          lastFinishedAt: ago(5),
        },
      ],
    });
  it.each([
    [599, 'ok'],
    [600, 'warn'],
    [1199, 'warn'],
    [1200, 'alert'],
  ])('a stage running %i s (timeout 600) is %s', (age, want) => {
    expect(level(running(age), 'queue:candles:running')).toBe(want);
  });

  const waiting = (waited: number, idle: number | null): HealthFacts =>
    healthy({
      stages: [
        {
          stage: 'candles',
          timeoutSeconds: 600,
          running: 0,
          oldestRunningStartedAt: null,
          waitingWatched: 12,
          oldestWaitingAt: ago(waited),
          lastFinishedAt: idle === null ? null : ago(idle),
        },
      ],
    });
  it.each([
    [L.waitingAlertSeconds, L.waitingAlertSeconds, 'alert'],
    [L.waitingAlertSeconds, L.waitingAlertSeconds - 1, 'warn'],
    [L.waitingAlertSeconds - 1, L.waitingAlertSeconds, 'warn'],
    [L.waitingWarnSeconds - 1, L.waitingAlertSeconds * 5, 'ok'],
    [L.waitingAlertSeconds * 5, 10, 'ok'],
  ])('waiting %i s while the last finish was %i s ago is %s', (waited, idle, want) => {
    expect(level(waiting(waited, idle), 'queue:candles:waiting')).toBe(want);
  });
  it('work waiting while nothing ever finished counts as idle', () => {
    expect(level(waiting(L.waitingAlertSeconds, null), 'queue:candles:waiting')).toBe('alert');
  });
});

describe('5. failures', () => {
  const failing = (count: number, total: number): HealthFacts =>
    healthy({
      failures: [{ stage: 'candles', reason: 'price_error', count }],
      finished24h: { candles: total },
    });
  const name = 'failures:candles:price_error';
  it('alerts at the count and the share together', () => {
    expect(level(failing(L.failureAlertCount, 80), name)).toBe('alert');
  });
  it('is not an alert just under the count, or just under the share', () => {
    expect(level(failing(L.failureAlertCount - 1, 40), name)).toBe('warn');
    expect(level(failing(L.failureAlertCount, 81), name)).toBe('warn'); // 24.7 percent
  });
  it('is quiet under the warn count, or under the warn share', () => {
    expect(get(evaluateHealth(failing(L.failureWarnCount - 1, 10)), 'failures').level).toBe('ok');
    expect(get(evaluateHealth(failing(L.failureWarnCount, 100)), 'failures').level).toBe('ok'); // 5 percent
  });
  it('names the stage and the reason, and groups apart', () => {
    const f = healthy({
      failures: [
        { stage: 'candles', reason: 'price_error', count: 30 },
        { stage: 'metadata', reason: 'metadata_unreachable', count: 30 },
      ],
      finished24h: { candles: 40, metadata: 40 },
    });
    const names = evaluateHealth(f).map((c) => c.name);
    expect(names).toContain('failures:candles:price_error');
    expect(names).toContain('failures:metadata:metadata_unreachable');
  });
});

describe('6. providers', () => {
  const day = (units: number) =>
    healthy({ usage: { codexDayUnits: units, codexMonthUnits: 0, jupiterPausesToday: null } });
  it.each([
    [799, 'ok'],
    [800, 'warn'],
    [949, 'warn'],
    [950, 'alert'],
  ])('%i of 1,000 units today is %s', (units, want) => {
    expect(level(day(units), 'provider:codex:day')).toBe(want);
  });
  it('the ceiling can be overridden', () => {
    expect(level(day(400), 'provider:codex:day', { maxCodexUnitsPerDay: 400 })).toBe('alert');
  });
  it('the month check needs an allowance, and is left out without one', () => {
    const f = healthy({
      usage: { codexDayUnits: 0, codexMonthUnits: 9_500, jupiterPausesToday: null },
    });
    expect(evaluateHealth(f).map((c) => c.name)).not.toContain('provider:codex:month');
    expect(level(f, 'provider:codex:month', { monthlyCodexUnits: 10_000 })).toBe('alert');
    expect(level(f, 'provider:codex:month', { monthlyCodexUnits: 10_001 })).toBe('warn');
    expect(level(f, 'provider:codex:month', { monthlyCodexUnits: 20_000 })).toBe('ok');
  });
  it('Jupiter pauses: left out without the row, then warn and alert', () => {
    const f = (p: number | null) =>
      healthy({ usage: { codexDayUnits: 0, codexMonthUnits: 0, jupiterPausesToday: p } });
    expect(evaluateHealth(f(null)).map((c) => c.name)).not.toContain('provider:jupiter:pauses');
    expect(level(f(0), 'provider:jupiter:pauses')).toBe('ok');
    expect(level(f(L.jupiterPauseWarn - 1), 'provider:jupiter:pauses')).toBe('ok');
    expect(level(f(L.jupiterPauseWarn), 'provider:jupiter:pauses')).toBe('warn');
    expect(level(f(L.jupiterPauseAlert - 1), 'provider:jupiter:pauses')).toBe('warn');
    expect(level(f(L.jupiterPauseAlert), 'provider:jupiter:pauses')).toBe('alert');
  });
});

describe('7. daily refresh', () => {
  const at = (iso: string, refresh: HealthFacts['refresh']): HealthFacts => ({
    ...healthy({ refresh }),
    now: new Date(iso),
  });
  it("alerts when yesterday's did not finish", () => {
    const f = at('2026-11-16T00:30:00Z', { day: 'day:2026-11-15', done: false });
    expect(get(evaluateHealth(f), 'refresh:yesterday').level).toBe('alert');
    expect(
      get(
        evaluateHealth(at('2026-11-16T00:30:00Z', { day: 'day:2026-11-15', done: true })),
        'refresh:yesterday',
      ).level,
    ).toBe('ok');
  });
  it("alerts when today's has not started by the hour, and not before", () => {
    const old = { day: 'day:2026-11-15', done: true };
    expect(get(evaluateHealth(at('2026-11-16T00:59:00Z', old)), 'refresh:today').level).toBe('ok');
    expect(get(evaluateHealth(at('2026-11-16T01:00:00Z', old)), 'refresh:today').level).toBe(
      'alert',
    );
    expect(
      get(
        evaluateHealth(at('2026-11-16T05:00:00Z', { day: 'day:2026-11-16', done: false })),
        'refresh:today',
      ).level,
    ).toBe('ok');
  });
});

describe('limit overrides', () => {
  it('replace a default by name', () => {
    expect(applyLimitOverrides(['discoveryAlertSeconds=60']).discoveryAlertSeconds).toBe(60);
    expect(applyLimitOverrides([]).discoveryAlertSeconds).toBe(L.discoveryAlertSeconds);
  });
  it('refuse an unknown name or a bad number', () => {
    expect(() => applyLimitOverrides(['nope=1'])).toThrow(/unknown limit/);
    expect(() => applyLimitOverrides(['discoveryAlertSeconds=abc'])).toThrow(/positive/);
    expect(() => applyLimitOverrides(['discoveryAlertSeconds'])).toThrow(/positive/);
    expect(() => applyLimitOverrides(['discoveryAlertSeconds=0'])).toThrow(/positive/);
  });
  it('change what evaluateHealth does', () => {
    const f = healthy({ lastDiscovery: { at: ago(100), status: 'ok' } });
    const tight = applyLimitOverrides(['discoveryAlertSeconds=60', 'discoveryWarnSeconds=30']);
    expect(get(evaluateHealth(f, tight), 'discovery').level).toBe('alert');
  });
});
