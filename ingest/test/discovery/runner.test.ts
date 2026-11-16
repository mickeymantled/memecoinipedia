/**
 * Tests for the discovery runner script. Dune is a fake: a POST fetch and a GET fetch that keep
 * count of the requests and of the credits "used". Nothing is sent anywhere, the clock is fake.
 * The fixtures are hand-written (see ../sources/fixtures/dune/README.md).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildPlan,
  discoveryFile,
  main,
  parseRunnerArgs,
  partFile,
  reconcileMargin,
  runDiscovery,
  settleUsage,
  sizeAndSample,
  stateFile,
  UsageError,
  USAGE_SETTLE_INTERVAL_MS,
  USAGE_SETTLE_LIMIT_MS,
  type RunnerArgs,
} from '../../scripts/dune-discovery.js';
import { GRADUATE_COLUMNS } from '../../src/discovery/index.js';
import { UnitBudget } from '../../src/sources/budget.js';
import { DuneClient } from '../../src/sources/dune/index.js';
import type { FetchLike } from '../../src/sources/http.js';
import { RateLimiter } from '../../src/sources/ratelimit.js';
import { fakeClock } from '../sources/helpers.js';
import { fakeGetFetch, fixtureText } from '../sources/net-helpers.js';

const KEY = 'runner-test-key-0d8c41aa9e';
const EXEC = 'exec-test-0001';
const HEADER = GRADUATE_COLUMNS.join(',');

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-test-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  vi.unstubAllGlobals();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A valid base58 mint for row i. */
const mint = (i: number) => 'Z' + i.toString(2).replace(/0/g, '2').padStart(40, '3');
const HALF_YEAR_START = 1_706_745_600; // 2024-02-01T00:00:00Z, in seconds

/** Row i: created in 2024, peak 40k, 70k, 500k, 5M or 50M in turn, hours 100 + i. */
function csvRow(i: number): string {
  const peaks = [40_000, 70_000, 500_000, 5_000_000, 50_000_000];
  const created = HALF_YEAR_START + i * 3600;
  return [
    mint(i),
    created,
    '',
    created + 1800,
    100 + i,
    (peaks[i % 5] as number) * 2,
    peaks[i % 5],
    created + 7200,
    created + 86_400,
  ].join(',');
}

interface WorldOptions {
  rows?: number;
  execCost?: number;
  /** Credits one page adds to the usage figure. */
  pageCost?: number;
  executeReply?: { status: number; body: string };
  statusFixture?: string;
  csvReply?: (offset: number) => { status: number; body: string } | null;
  usageBroken?: boolean;
  /** The `credits_used` the usage endpoint reports on read number `read` (1-based), given the true figure. */
  usageAt?: (ctx: { used: number; read: number }) => number;
  /** Credits some other job spends when the page at `offset` is served (the usage figure rises, our page does not cost it). */
  otherSpend?: (offset: number) => number;
}

interface World {
  args: RunnerArgs;
  client: () => DuneClient;
  posts: string[];
  executes: () => number;
  csvOffsets: number[];
  logs: string[];
  log: (l: string) => void;
  used: () => number;
  clock: ReturnType<typeof fakeClock>;
  usageReads: () => number;
}

function world(over: Partial<RunnerArgs> = {}, opts: WorldOptions = {}): World {
  const dir = tmp();
  const sql = path.join(dir, 'discovery.sql');
  fs.writeFileSync(sql, 'select 1\n');
  const args: RunnerArgs = {
    sql,
    out: path.join(dir, 'out'),
    maxCredits: 1000,
    performance: 'medium',
    probes: path.join(dir, 'probes.json'),
    timeLimitMinutes: 10,
    executionId: null,
    columns: null,
    filter: null,
    pageRows: 100,
    confirm: true,
    ...over,
  };
  const rows = opts.rows ?? 250;
  let used = 1000;
  let usageReads = 0;
  const posts: string[] = [];
  const csvOffsets: number[] = [];
  const post: FetchLike = async (url) => {
    posts.push(new URL(url).pathname);
    let status = 200;
    let reply = '{}';
    if (url.endsWith('/sql/execute')) {
      if (opts.executeReply) {
        status = opts.executeReply.status;
        reply = opts.executeReply.body;
      } else {
        used += opts.execCost ?? 0.35;
        reply = JSON.stringify({ execution_id: EXEC, state: 'QUERY_STATE_PENDING' });
      }
    } else if (url.endsWith('/usage')) {
      if (opts.usageBroken) {
        status = 500;
      } else {
        usageReads++;
        reply = JSON.stringify({
          billing_periods: [
            {
              start_date: '2026-11-01',
              end_date: '2026-12-01',
              credits_used: opts.usageAt ? opts.usageAt({ used, read: usageReads }) : used,
              credits_included: 4000,
            },
          ],
        });
      }
    }
    return { status, ok: status < 300, headers: { get: () => null }, text: async () => reply };
  };
  const get = fakeGetFetch((req) => {
    if (req.url.endsWith('/status')) {
      const s = JSON.parse(opts.statusFixture ?? fixtureText('dune', 'status-completed'));
      s.execution_id = EXEC;
      if (s.result_metadata) s.result_metadata.total_row_count = rows;
      return { body: JSON.stringify(s) };
    }
    const u = new URL(req.url);
    const limit = Number(u.searchParams.get('limit'));
    const offset = Number(u.searchParams.get('offset'));
    csvOffsets.push(offset);
    const custom = opts.csvReply?.(offset);
    if (custom) return custom;
    const n = Math.max(0, Math.min(limit, rows - offset));
    used += (opts.pageCost ?? 0.5) + (opts.otherSpend?.(offset) ?? 0);
    const body =
      HEADER + '\n' + Array.from({ length: n }, (_, i) => csvRow(offset + i) + '\n').join('');
    const more = offset + n < rows;
    return {
      body,
      headers: (more ? { 'x-dune-next-offset': String(offset + n) } : {}) as Record<string, string>,
    };
  });
  const clock = fakeClock();
  const budget = () => new UnitBudget({ ceilingUnits: args.maxCredits ?? undefined });
  const logs: string[] = [];
  return {
    args,
    client: () =>
      new DuneClient({
        apiKey: KEY,
        fetch: post,
        getFetch: get.fetch,
        budget: budget(),
        limiter: new RateLimiter({
          maxPerSecond: 1000,
          burst: 1000,
          now: clock.now,
          sleep: clock.sleep,
        }),
        now: clock.now,
        sleep: clock.sleep,
        http: { sleep: clock.sleep, random: () => 0.5, baseDelayMs: 1, maxRetries: 1 },
      }),
    posts,
    executes: () => posts.filter((p) => p.endsWith('/sql/execute')).length,
    csvOffsets,
    logs,
    log: (l) => logs.push(l),
    used: () => used,
    clock,
    usageReads: () => usageReads,
  };
}

const run = (w: World, client = w.client()) =>
  runDiscovery({ args: w.args, client, log: w.log, sleep: w.clock.sleep, now: w.clock.now });
const readOut = (w: World, name: string) => fs.readFileSync(path.join(w.args.out, name), 'utf8');
const exists = (w: World, name: string) => fs.existsSync(path.join(w.args.out, name));
const expectedCsv = (n: number) =>
  HEADER + '\n' + Array.from({ length: n }, (_, i) => csvRow(i) + '\n').join('');

describe('parseRunnerArgs', () => {
  it('applies the defaults', () => {
    const a = parseRunnerArgs([]);
    expect(a).toMatchObject({
      maxCredits: null,
      performance: 'medium',
      timeLimitMinutes: 10,
      executionId: null,
      columns: null,
      filter: null,
      pageRows: 32_000,
      confirm: false,
    });
    expect(a.out.endsWith(path.join('data', 'dune'))).toBe(true);
    expect(a.sql.endsWith(path.join('ingest', 'sql', 'dune', 'discovery.sql'))).toBe(true);
    expect(a.probes.endsWith(path.join('probes', 'coins.json'))).toBe(true);
  });

  it('reads every option', () => {
    const a = parseRunnerArgs([
      '--sql',
      '/x/q.sql',
      '--out',
      '/x/y',
      '--max-credits',
      '200.5',
      '--performance',
      'large',
      '--probes',
      '/x/p.json',
      '--time-limit-minutes',
      '3',
      '--execution-id',
      'abc12345',
      '--columns',
      'mint,created_at,graduated_at',
      '--filter',
      'hours >= 10',
      '--page-rows',
      '5000',
      '--confirm',
    ]);
    expect(a).toMatchObject({
      sql: '/x/q.sql',
      out: '/x/y',
      maxCredits: 200.5,
      performance: 'large',
      probes: '/x/p.json',
      timeLimitMinutes: 3,
      executionId: 'abc12345',
      columns: ['mint', 'created_at', 'graduated_at'],
      filter: 'hours >= 10',
      pageRows: 5000,
      confirm: true,
    });
  });

  it.each([
    [['--max-credits', '0']],
    [['--max-credits', 'abc']],
    [['--performance', 'huge']],
    [['--page-rows', '32001']],
    [['--page-rows', '1.5']],
    [['--execution-id', 'a b']],
    [['--columns', 'mint;drop']],
    [['--time-limit-minutes', '-1']],
    [['--bogus', '1']],
    [['--sql']],
    [['--confirm']], // no --max-credits
    [['--from', '2024-01']], // the old month arguments are gone
  ])('rejects %j', (argv) => {
    expect(() => parseRunnerArgs(argv)).toThrow(UsageError);
  });
});

describe('without --confirm', () => {
  it('prints the plan, exits 0, builds no client and calls nothing', async () => {
    const w = world({ confirm: false });
    const fetchSpy = vi.fn(() => {
      throw new Error('network call');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const out: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((l: string) => void out.push(l));
    const code = await main(['--out', w.args.out, '--sql', w.args.sql, '--max-credits', '100'], {
      DUNE_API_KEY: KEY,
    });
    spy.mockRestore();
    expect(code).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(w.posts).toHaveLength(0);
    const text = out.join('\n');
    expect(text).toContain('Nothing was sent to Dune');
    expect(text).toContain('1.534 credits per 1,000 rows');
    expect(text).toContain("Dune's usage figure is read until it settles");
    expect(text).toContain('Execution: run the SQL once');
    expect(text).not.toContain(KEY);
    expect(fs.existsSync(w.args.out)).toBe(false); // nothing written
  });

  it('says what it would resume, reuse or skip', () => {
    const w = world({ confirm: false });
    fs.mkdirSync(w.args.out, { recursive: true });
    fs.writeFileSync(
      stateFile(w.args.out),
      JSON.stringify({ executionId: EXEC, nextOffset: 300, partBytes: 10, rows: 300, pages: 3 }),
    );
    expect(buildPlan(w.args).text).toContain('resume the saved one (next offset 300, 300 rows');
    expect(buildPlan({ ...w.args, executionId: 'abc12345' }).text).toContain(
      'reuse the given execution',
    );
    fs.writeFileSync(discoveryFile(w.args.out), HEADER + '\n');
    const plan = buildPlan(w.args);
    expect(plan.csvExists).toBe(true);
    expect(plan.text).toContain('Dune is skipped');
  });

  it('reports a missing SQL file and a template with placeholders', () => {
    const w = world({ confirm: false });
    expect(buildPlan({ ...w.args, sql: '/nonexistent/x.sql' }).text).toContain('MISSING');
    fs.writeFileSync(w.args.sql, 'select {{month_start}}');
    expect(buildPlan(w.args).text).toContain('must have none');
  });

  it('with --confirm but no key, stops before any call', async () => {
    const w = world();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const code = await main(
      ['--out', w.args.out, '--sql', w.args.sql, '--max-credits', '10', '--confirm'],
      {},
    );
    err.mockRestore();
    log.mockRestore();
    expect(code).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('runDiscovery', () => {
  it('executes once, downloads page by page into one file, and cleans up', async () => {
    const w = world();
    const s = await run(w);
    expect(s).toMatchObject({ status: 'complete', pages: 3, rows: 250 });
    expect(w.executes()).toBe(1);
    expect(w.csvOffsets).toEqual([0, 100, 200]);
    expect(readOut(w, 'discovery.csv')).toBe(expectedCsv(250)); // one header row only
    expect(exists(w, 'discovery.csv.part')).toBe(false);
    expect(exists(w, 'discovery.csv.part.state.json')).toBe(false);
    // Each page is recorded at its rows times the known rate, marked estimated (0.15, 0.15, 0.08);
    // the execution adds 0.35. The run then reads usage, which agrees, and the ledger takes it.
    expect(
      w.logs.some((l) =>
        /^page 1: offset 0, rows 100, bytes \d+, credits 0\.15 \(estimated\), running total 0\.5$/.test(
          l,
        ),
      ),
    ).toBe(true);
    expect(s.reconciliation).toMatchObject({ outcome: 'replaced', recorded: 0.73, reads: 2 });
    expect(s.totalCredits).toBeCloseTo(0.35 + 3 * 0.5, 5);
    expect(w.logs.some((l) => /^page 3: offset 200, rows 50,/.test(l))).toBe(true);
    expect(
      w.logs.some((l) => l.startsWith('Credits used this billing period before the run: 1000')),
    ).toBe(true);
    expect(
      w.logs.some((l) =>
        l.startsWith(
          "Reconciled with Dune's usage figure (settled after 2 reads): this run used 1.85 credits; the 0.73 recorded were replaced by it.",
        ),
      ),
    ).toBe(true);
    // The wait is on the fake clock: one interval, no real time.
    expect(w.clock.sleeps.filter((ms) => ms === USAGE_SETTLE_INTERVAL_MS)).toHaveLength(1);
  });

  it('sends the page size and tier, and the columns and filter when given', async () => {
    const w = world({ columns: ['mint', 'created_at', 'graduated_at'], filter: 'hours >= 10' });
    const seen: string[] = [];
    const client = w.client();
    const orig = client.downloadCsv.bind(client);
    client.downloadCsv = (id, p, o) => {
      seen.push(JSON.stringify([o?.limit, o?.offset, o?.columns, o?.filters]));
      return orig(id, p, o);
    };
    await run(w, client);
    expect(seen[0]).toBe('[100,0,["mint","created_at","graduated_at"],"hours >= 10"]');
  });

  it('records the state after every page and removes it when the last page is in', async () => {
    const w = world();
    const states: unknown[] = [];
    const client = w.client();
    const orig = client.downloadCsv.bind(client);
    client.downloadCsv = async (id, p, o) => {
      if (fs.existsSync(stateFile(w.args.out))) {
        states.push(JSON.parse(fs.readFileSync(stateFile(w.args.out), 'utf8')));
      }
      return orig(id, p, o);
    };
    await run(w, client);
    expect(states).toMatchObject([
      { executionId: EXEC, nextOffset: 0, rows: 0, pages: 0 },
      { executionId: EXEC, nextOffset: 100, rows: 100, pages: 1 },
      { executionId: EXEC, nextOffset: 200, rows: 200, pages: 2 },
    ]);
  });

  it('stops before a page when the credits left are below the estimate for it, and resumes without paying twice', async () => {
    // A 100-row page is estimated at 0.15. The execution costs 0.35 and each page really costs 0.15.
    const w = world({ maxCredits: 1.5, pageRows: 100 }, { rows: 2000, pageCost: 0.15 });
    const first = await run(w);
    // 1.5 - 0.35 - 7 x 0.15 leaves 0.1, below the 0.15 the next page is estimated at.
    expect(first.status).toBe('stopped_budget');
    expect(first.message).toMatch(
      /Stopped before offset 700: 0\.1 credits left of the ceiling, below 0\.15 \(the estimate for the next page of 100 rows\)/,
    );
    expect(w.csvOffsets).toEqual([0, 100, 200, 300, 400, 500, 600]);
    expect(JSON.parse(readOut(w, 'discovery.csv.part.state.json'))).toMatchObject({
      nextOffset: 700,
      rows: 700,
    });
    expect(first.reconciliation.outcome).toBe('replaced');
    expect(exists(w, 'discovery.csv')).toBe(false);

    // A second run with more budget continues from the next page: no new execution, no repeated page.
    w.args.maxCredits = 1000;
    const second = await run(w);
    expect(second).toMatchObject({ status: 'complete', pages: 20, rows: 2000 });
    expect(w.executes()).toBe(1);
    expect(w.csvOffsets).toHaveLength(20);
    expect(readOut(w, 'discovery.csv')).toBe(expectedCsv(2000));
    expect(exists(w, 'discovery.csv.part.state.json')).toBe(false);
  });

  it('counts credits from earlier runs: a download stopped by the ceiling stops again on resume with the same ceiling', async () => {
    const w = world({ maxCredits: 1.5, pageRows: 100 }, { rows: 2000, pageCost: 0.15 });
    const first = await run(w);
    expect(first.status).toBe('stopped_budget');
    expect(first.message).toContain('whole download');
    expect(w.csvOffsets).toHaveLength(7);
    expect(JSON.parse(readOut(w, 'discovery.csv.part.state.json')).creditsSpent).toBeCloseTo(
      0.35 + 7 * 0.15,
      5,
    );

    // A new process, the same ceiling: the earlier spending is loaded before anything is requested.
    const second = await run(w);
    expect(second.status).toBe('stopped_budget');
    expect(second.message).toMatch(/Stopped before offset 700: 0\.1 credits left of the ceiling/);
    expect(w.csvOffsets).toHaveLength(7); // no page was requested
    expect(w.executes()).toBe(1);
    expect(second.totalCredits).toBeCloseTo(1.4, 5);
    expect(second.reconciliation.outcome).toBe('not_needed'); // nothing was spent this time
    expect(w.logs.some((l) => l.startsWith('Earlier runs of this download recorded'))).toBe(true);
  });

  it('records every page at the known rate, marked estimated, and the stop rule uses the next page estimate', async () => {
    // 32,000 rows a page are estimated at 49.1 credits each. The usage figure does not move (the
    // fake charges nothing), so the settled difference is far below the estimates and they stay.
    const w = world(
      { maxCredits: 160, pageRows: 32_000 },
      { rows: 200_000, pageCost: 0, execCost: 0 },
    );
    const s = await run(w);
    expect(s.status).toBe('stopped_budget');
    expect(w.csvOffsets).toEqual([0, 32_000, 64_000]);
    expect(w.logs.filter((l) => /^page \d+:.*credits 49\.1 \(estimated\)/.test(l))).toHaveLength(3);
    expect(w.logs.some((l) => l.includes('(measured)'))).toBe(false);
    // 0.35 for the execution (from the status fixture) and 3 x 49.1.
    expect(s.message).toMatch(
      /Stopped before offset 96000: 12\.35 credits left of the ceiling, below 49\.1 \(the estimate for the next page of 32000 rows\)/,
    );
    expect(s.reconciliation.outcome).toBe('below_estimate');
    expect(s.totalCredits).toBeCloseTo(147.65, 5);
  });

  it('does not start a first page its estimate does not fit under the ceiling', async () => {
    const w = world({ maxCredits: 49, pageRows: 32_000 }, { rows: 40_000 });
    const s = await run(w);
    expect(s.status).toBe('stopped_budget');
    expect(s.message).toMatch(/below 49\.1 \(the estimate for the next page of 32000 rows\)/);
    expect(w.csvOffsets).toEqual([]);
  });

  it('estimates a small result as a small page: 35 rows fit under a ceiling of 10', async () => {
    const w = world({ maxCredits: 10, pageRows: 32_000 }, { rows: 35 });
    const sizes: number[] = [];
    const client = w.client();
    const orig = client.downloadCsv.bind(client);
    client.downloadCsv = (id, p, o) => {
      sizes.push(o?.limit ?? -1);
      return orig(id, p, o);
    };
    const s = await run(w, client);
    expect(s).toMatchObject({ status: 'complete', pages: 1, rows: 35 });
    expect(sizes).toEqual([35]);
    expect(w.logs.some((l) => /credits 0\.05 \(estimated\)/.test(l))).toBe(true);
  });

  it('keeps a page file consistent when the file before it has no trailing newline', async () => {
    const w = world({ pageRows: 100 }, { rows: 250 });
    // Page 1 is saved by an earlier run, but its last newline was lost.
    const page1 = expectedCsv(100).slice(0, -1);
    fs.mkdirSync(w.args.out, { recursive: true });
    fs.writeFileSync(partFile(w.args.out), page1);
    fs.writeFileSync(
      stateFile(w.args.out),
      JSON.stringify({
        executionId: EXEC,
        nextOffset: 100,
        partBytes: Buffer.byteLength(page1),
        rows: 100,
        pages: 1,
        columns: null,
        filter: null,
        creditsSpent: 0.85,
      }),
    );
    const s = await run(w);
    expect(s).toMatchObject({ status: 'complete', rows: 250 });
    expect(readOut(w, 'discovery.csv')).toBe(expectedCsv(250));
  });

  it('after a crash in the middle of a page, drops the partial page and does not repeat saved ones', async () => {
    const w = world();
    fs.mkdirSync(w.args.out, { recursive: true });
    const firstPage = expectedCsv(100);
    fs.writeFileSync(partFile(w.args.out), firstPage + 'half,a,page');
    fs.writeFileSync(
      stateFile(w.args.out),
      JSON.stringify({
        executionId: EXEC,
        nextOffset: 100,
        partBytes: Buffer.byteLength(firstPage),
        rows: 100,
        pages: 1,
        columns: null,
        filter: null,
      }),
    );
    const s = await run(w);
    expect(s).toMatchObject({ status: 'complete', rows: 250, pages: 3 });
    expect(w.executes()).toBe(0);
    expect(w.csvOffsets).toEqual([100, 200]);
    expect(readOut(w, 'discovery.csv')).toBe(expectedCsv(250));
  });

  it('fails when the part file is shorter than the state says', async () => {
    const w = world();
    fs.mkdirSync(w.args.out, { recursive: true });
    fs.writeFileSync(partFile(w.args.out), 'tiny');
    fs.writeFileSync(
      stateFile(w.args.out),
      JSON.stringify({ executionId: EXEC, nextOffset: 100, partBytes: 5000 }),
    );
    const s = await run(w);
    expect(s.status).toBe('failed');
    expect(s.message).toMatch(/shorter than the state says/);
    expect(w.csvOffsets).toEqual([]);
  });

  it('reuses an execution given by --execution-id and does not run the SQL', async () => {
    const w = world({ executionId: EXEC });
    const s = await run(w);
    expect(s).toMatchObject({ status: 'complete', rows: 250 });
    expect(w.executes()).toBe(0);
    expect(s.totalCredits).toBeCloseTo(3 * 0.5, 5); // the execution was not paid for by this run
  });

  it('refuses a saved state that belongs to another execution or other columns', async () => {
    const w = world({ executionId: 'other-id-0002' });
    fs.mkdirSync(w.args.out, { recursive: true });
    fs.writeFileSync(
      stateFile(w.args.out),
      JSON.stringify({ executionId: EXEC, nextOffset: 100, partBytes: 0 }),
    );
    expect((await run(w)).message).toMatch(/different execution/);
    w.args.executionId = null;
    w.args.columns = ['mint'];
    expect((await run(w)).message).toMatch(/other --columns or --filter/);
    expect(w.posts).toHaveLength(0);
  });

  it('shows Dune message when the performance tier is not available', async () => {
    const w = world(
      {},
      { executeReply: { status: 400, body: fixtureText('dune', 'execute-tier-400') } },
    );
    const s = await run(w);
    expect(s.status).toBe('failed');
    expect(s.message).toBe(
      'HTTP 400: This performance tier is not available with your subscription. Please upgrade your subscription plan here: https://dune.com/pricing',
    );
    expect(w.csvOffsets).toEqual([]);
  });

  it('stops on a failed execution with its error text and drops the state', async () => {
    const w = world({}, { statusFixture: fixtureText('dune', 'status-failed') });
    const s = await run(w);
    expect(s.status).toBe('failed');
    expect(s.message).toMatch(/The execution failed: value must be finite; was Infinity/);
    expect(exists(w, 'discovery.csv.part.state.json')).toBe(false);
    expect(w.csvOffsets).toEqual([]);
  });

  it('stops with Dune message on a 402, keeps what was saved, and can continue later', async () => {
    const w = world(
      {},
      {
        csvReply: (offset) =>
          offset === 100 && !w.args.executionId
            ? { status: 402, body: fixtureText('dune', 'results-csv-402') }
            : null,
      },
    );
    const s = await run(w);
    expect(s.status).toBe('failed');
    expect(s.message).toMatch(
      /Download stopped before offset 100: .*exceed your configured credits limit/,
    );
    expect(JSON.parse(readOut(w, 'discovery.csv.part.state.json'))).toMatchObject({
      nextOffset: 100,
    });
    expect(w.csvOffsets).toEqual([0, 100]); // the refused page was asked for once, not retried
  });

  it('fails before any call when the SQL file is missing or has placeholders', async () => {
    const w = world();
    fs.writeFileSync(w.args.sql, 'select {{month_start}}');
    const s1 = await run(w);
    expect(s1.status).toBe('failed');
    expect(s1.message).toMatch(/placeholders \(month_start\)/);
    fs.rmSync(w.args.sql);
    const s2 = await run(w);
    expect(s2.message).toContain('SQL file not found');
    expect(w.posts).toHaveLength(0);
  });

  it('still runs when the usage endpoint fails, and records estimated page costs', async () => {
    const w = world({}, { usageBroken: true });
    const s = await run(w);
    expect(s.status).toBe('complete');
    expect(w.logs.some((l) => l.includes('(estimated)'))).toBe(true);
    expect(s.reconciliation).toMatchObject({ outcome: 'unavailable', usageDifference: null });
    expect(w.logs.some((l) => l.includes('Usage figure not read before the run'))).toBe(true);
    expect(s.totalCredits).toBeCloseTo(0.35 + 0.38, 5); // the estimates stay
  });

  it('does nothing when discovery.csv already exists', async () => {
    const w = world();
    fs.mkdirSync(w.args.out, { recursive: true });
    fs.writeFileSync(discoveryFile(w.args.out), expectedCsv(5));
    const s = await run(w);
    expect(s.status).toBe('complete');
    expect(w.posts).toHaveLength(0);
    expect(w.csvOffsets).toEqual([]);
  });

  it('never prints the key', async () => {
    const w = world({}, { statusFixture: fixtureText('dune', 'status-failed') });
    const s = await run(w);
    expect(w.logs.join('\n') + (s.message ?? '')).not.toContain(KEY);
  });
});

describe('reconciliation with the usage figure', () => {
  // Pages: 100 + 100 + 50 rows, recorded at 0.15 + 0.15 + 0.08. The execution is 0.35.
  const ESTIMATED = 0.73;

  it('records the true total when the usage figure lags by two pages and then catches up', async () => {
    // Each page really costs 0.2, so the true total is 0.35 + 0.6 = 0.95 (the figure starts at 1000).
    // After the download the figure is read: first two pages behind, then one behind, then true, then true.
    const w = world(
      {},
      {
        pageCost: 0.2,
        usageAt: ({ used, read }) => {
          // Read 1 is the start of the run. Reads 2 to 5 are the end-of-run reads.
          if (read === 2) return used - 0.4; // two pages behind
          if (read === 3) return used - 0.2; // one behind
          return used;
        },
      },
    );
    const s = await run(w);
    expect(s.status).toBe('complete');
    expect(s.reconciliation).toMatchObject({
      outcome: 'replaced',
      recorded: ESTIMATED,
      usageDifference: 0.95,
      reads: 4,
    });
    // The true total, not a multiple of it, and not the estimates added to the lagging reads.
    expect(s.totalCredits).toBeCloseTo(0.95, 5);
    expect(w.usageReads()).toBe(5); // one before the run, four after: none per page
    expect(w.clock.sleeps.filter((ms) => ms === USAGE_SETTLE_INTERVAL_MS)).toHaveLength(3);
    expect(w.logs.filter((l) => l.includes('(measured)'))).toHaveLength(0);
  });

  it("does not add another job's spending to the pages, and says so", async () => {
    // Another job spends 100 credits while page 2 is served.
    const w = world({}, { otherSpend: (offset) => (offset === 100 ? 100 : 0) });
    const s = await run(w);
    expect(s.status).toBe('complete');
    // The page ledger keeps its estimates. Usage rose by 0.35 + 1.5 + 100 = 101.85.
    expect(s.reconciliation).toMatchObject({
      outcome: 'other_spending',
      recorded: ESTIMATED,
      usageDifference: 101.85,
    });
    expect(s.totalCredits).toBeCloseTo(ESTIMATED, 5);
    const pageLines = w.logs.filter((l) => l.startsWith('page '));
    expect(pageLines[0]).toContain('credits 0.15 (estimated)');
    expect(pageLines[1]).toContain('credits 0.15 (estimated)'); // not inflated by the other job
    const line = w.logs.find((l) => l.startsWith('Usage rose by'));
    expect(line).toContain('spending by something else, or a figure that has not settled');
    expect(line).toContain('it is not added to the ledger');
  });

  it('keeps the estimates and says so when the figure has not settled by the limit', async () => {
    // The figure rises by 1 on every read: no two reads in a row agree.
    const w = world({}, { usageAt: ({ used, read }) => used + read });
    const s = await run(w);
    expect(s.status).toBe('complete');
    expect(s.reconciliation.outcome).toBe('unsettled');
    expect(s.reconciliation.reads).toBe(11); // one at once, then one after each of ten intervals
    expect(w.clock.sleeps.filter((ms) => ms === USAGE_SETTLE_INTERVAL_MS)).toHaveLength(10);
    expect(s.totalCredits).toBeCloseTo(ESTIMATED, 5);
    expect(w.logs.some((l) => l.includes('had not settled after 300 seconds'))).toBe(true);
  });

  it('reconciles when the run stops on the ceiling too, and the resumed run starts from the real figure', async () => {
    // Pages really cost 0.3 (the estimate is 0.15): after 3 pages the true total is 0.35 + 0.9.
    const w = world({ maxCredits: 1.0, pageRows: 100 }, { rows: 2000, pageCost: 0.3 });
    const s = await run(w);
    expect(s.status).toBe('stopped_budget');
    expect(s.pages).toBe(4); // 1.0 - 0.35 = 0.65 left, four 0.15 estimates fit (0.05 left)
    expect(s.reconciliation).toMatchObject({ outcome: 'replaced', usageDifference: 1.55 });
    expect(s.totalCredits).toBeCloseTo(1.55, 5);
    expect(JSON.parse(readOut(w, 'discovery.csv.part.state.json')).creditsSpent).toBeCloseTo(
      1.55,
      5,
    );
  });

  it('reconciles after a failed download too', async () => {
    const w = world(
      {},
      {
        csvReply: (offset) =>
          offset === 100 ? { status: 402, body: fixtureText('dune', 'results-csv-402') } : null,
      },
    );
    const s = await run(w);
    expect(s.status).toBe('failed');
    expect(s.reconciliation.outcome).toBe('replaced');
  });

  it('does nothing when the run spent nothing', async () => {
    const w = world();
    fs.rmSync(w.args.sql);
    const s = await run(w);
    expect(s.reconciliation.outcome).toBe('not_needed');
    expect(w.usageReads()).toBe(0);
    expect(w.clock.sleeps).toHaveLength(0);
  });

  it('has a margin that is the larger of 5 credits and a tenth of the recorded total', () => {
    expect(reconcileMargin(0.73)).toBe(5);
    expect(reconcileMargin(249)).toBeCloseTo(24.9, 5);
  });
});

describe('settleUsage', () => {
  const clock = () => {
    let t = 0;
    return {
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
    };
  };

  it('returns at once on two equal reads', async () => {
    const c = clock();
    const reads = [5, 5];
    const r = await settleUsage(async () => reads.shift() ?? null, c.sleep, c.now, 1000, 10_000);
    expect(r).toEqual({ value: 5, settled: true, reads: 2 });
    expect(c.now()).toBe(1000);
  });

  it('gives up when waiting once more would pass the limit', async () => {
    const c = clock();
    let n = 0;
    const r = await settleUsage(async () => ++n, c.sleep, c.now, 1000, 3500);
    expect(r).toEqual({ value: 4, settled: false, reads: 4 }); // reads at 0, 1000, 2000, 3000
    expect(c.now()).toBe(3000);
  });

  it('reports no value when the first read fails, and the last good value when a later one fails', async () => {
    const c = clock();
    expect(await settleUsage(async () => null, c.sleep, c.now)).toEqual({
      value: null,
      settled: false,
      reads: 1,
    });
    const seq = [7, null];
    expect(
      await settleUsage(async () => seq.shift() ?? null, c.sleep, c.now, 1000, 10_000),
    ).toEqual({ value: 7, settled: false, reads: 2 });
  });

  it('uses the documented defaults: reads 30 seconds apart, giving up after five minutes', () => {
    expect(USAGE_SETTLE_INTERVAL_MS).toBe(30_000);
    expect(USAGE_SETTLE_LIMIT_MS).toBe(300_000);
  });
});

describe('sizeAndSample', () => {
  function setup(rowsN: number) {
    const w = world();
    fs.mkdirSync(w.args.out, { recursive: true });
    fs.writeFileSync(
      discoveryFile(w.args.out),
      expectedCsv(rowsN) + csvRow(1).replace(mint(1), 'bad mint') + '\n',
    );
    fs.writeFileSync(
      w.args.probes,
      JSON.stringify([
        { mint: mint(3) },
        { mint: 'GoneGoneGoneGoneGoneGoneGoneGoneGone1' },
        { symbol: 'no mint' },
      ]),
    );
    return w;
  }

  it('reads discovery.csv, reports rejected rows, prints the table with totals, and writes sample.csv', async () => {
    const w = setup(100);
    await sizeAndSample(w.args, w.log);
    const text = w.logs.join('\n');
    expect(text).toContain('Read 101 rows: 100 kept, 1 rejected.');
    expect(text).toContain('rejected, line 102: mint');
    expect(text).toMatch(/\ntotal\t100\t/);
    expect(text).toMatch(/Sample: \d+ coins \(2 probes, 1 missing from the list\)/);
    const sample = readOut(w, 'sample.csv').trim().split('\n');
    expect(sample[0]).toBe(
      'mint,half_year,cell,probe,probe_missing,created_at,creator,graduated_at,hours,peak_max_usd,peak_p999_usd,peak_at',
    );
    expect(sample[1]!.startsWith(`${mint(3)},2024-H1,`)).toBe(true);
    expect(sample[1]).toContain(',true,false,');
    // Per cell: 5 of 20 (30k), 10 of 20 (50k), 20 of 20 (500k), 19 of 20 (5M, one is the probe),
    // 15 of 20 (50M): 69 drawn, plus the 2 probes and the header.
    expect(sample).toHaveLength(1 + 69 + 2);
  });

  it('runs from main without --confirm and without --max-credits when discovery.csv exists', async () => {
    const w = setup(40);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const code = await main(['--out', w.args.out, '--probes', w.args.probes], {});
    const printed = log.mock.calls.map((c) => String(c[0])).join('\n');
    log.mockRestore();
    expect(code).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(exists(w, 'sample.csv')).toBe(true);
    expect(printed).toMatch(/\ntotal\t40\t/);
  });

  it('runs from main with --confirm and an existing discovery.csv, needing no key and no network', async () => {
    const w = setup(40);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const code = await main(
      ['--out', w.args.out, '--probes', w.args.probes, '--max-credits', '10', '--confirm'],
      {},
    );
    log.mockRestore();
    expect(code).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(exists(w, 'sample.csv')).toBe(true);
  });
});

describe('the curve-only list (issue #102)', () => {
  const CURVE_HEADER = [...GRADUATE_COLUMNS, 'is_mayhem_mode'].join(',');
  /** Row i of the curve-only file: graduated_at empty as Dune writes a null. */
  const curveRow = (i: number, flag: string, graduated = '<nil>'): string => {
    const f = csvRow(i).split(',');
    f[3] = graduated;
    return [...f, flag].join(',');
  };
  function setupCurve(extra: string[] = []) {
    const w = world({ list: 'curve-only' });
    fs.mkdirSync(w.args.out, { recursive: true });
    const rows = [curveRow(1, 'true'), curveRow(2, 'false'), curveRow(3, '<nil>'), ...extra];
    fs.writeFileSync(discoveryFile(w.args.out), `${CURVE_HEADER}\n${rows.join('\n')}\n`);
    return w;
  }

  it('parses --list, with the curve-only defaults for the query and the folder, and rejects others', () => {
    const a = parseRunnerArgs(['--list', 'curve-only']);
    expect(a.list).toBe('curve-only');
    expect(a.sql.endsWith('curve-only-candidates.sql')).toBe(true);
    expect(a.out.endsWith('dune-curve-only')).toBe(true);
    const g = parseRunnerArgs([]);
    expect(g.list).toBe('graduates');
    expect(g.sql.endsWith('discovery.sql')).toBe(true);
    expect(() => parseRunnerArgs(['--list', 'other'])).toThrow(UsageError);
  });

  it('reads the file with the new reader: counts by launch month and flag, no sample', async () => {
    const w = setupCurve();
    await sizeAndSample(w.args, w.log);
    const text = w.logs.join('\n');
    expect(text).toContain('Read 3 rows: 3 kept, 0 rejected.');
    expect(text).toContain('Rows by launch month (UTC):');
    expect(text).toContain('  2024-02: 3');
    expect(text).toContain('Mayhem flag: true 1, false 1, empty 1.');
    expect(exists(w, 'sample.csv')).toBe(false);
  });

  it('a row with a graduation time is an error, not a coin', async () => {
    const w = setupCurve([curveRow(4, 'false', String(HALF_YEAR_START + 4 * 3600 + 1800))]);
    await sizeAndSample(w.args, w.log);
    const text = w.logs.join('\n');
    expect(text).toContain('3 kept, 1 rejected');
    expect(text).toContain('a curve-only row must not carry a graduation time');
  });

  it('the dry run from main reads an existing file, sends nothing, and says it is the curve-only list', async () => {
    const w = setupCurve();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const code = await main(['--list', 'curve-only', '--out', w.args.out], {});
    const printed = log.mock.calls.map((c) => String(c[0])).join('\n');
    log.mockRestore();
    expect(code).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(printed).toContain('List: curve-only.');
    expect(printed).toContain('Mayhem flag: true 1, false 1, empty 1.');
    expect(exists(w, 'sample.csv')).toBe(false);
  });

  it('without --list nothing changes: the file is read as graduates and the sample is written', async () => {
    const w = world();
    fs.mkdirSync(w.args.out, { recursive: true });
    fs.writeFileSync(discoveryFile(w.args.out), `${HEADER}\n${csvRow(1)}\n`);
    fs.writeFileSync(w.args.probes, '[]');
    await sizeAndSample(w.args, w.log);
    expect(exists(w, 'sample.csv')).toBe(true);
    expect(w.logs.join('\n')).not.toContain('Mayhem flag');
  });
});
