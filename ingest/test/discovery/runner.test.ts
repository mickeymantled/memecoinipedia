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
  runDiscovery,
  sizeAndSample,
  stateFile,
  UsageError,
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
        reply = JSON.stringify({
          billing_periods: [
            {
              start_date: '2026-11-01',
              end_date: '2026-12-01',
              credits_used: used,
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
    used += opts.pageCost ?? 0.5;
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
  };
}

const run = (w: World, client = w.client()) => runDiscovery({ args: w.args, client, log: w.log });
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
    expect(text).toContain('1.6 credits per 1,000 rows');
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
    // The ledger holds the execution cost and the measured page costs (the usage difference).
    expect(s.totalCredits).toBeCloseTo(0.35 + 3 * 0.5, 5);
    expect(
      w.logs.some((l) =>
        /^page 1: offset 0, rows 100, bytes \d+, credits 0\.5 \(measured\)/.test(l),
      ),
    ).toBe(true);
    expect(w.logs.some((l) => /^page 3: offset 200, rows 50,/.test(l))).toBe(true);
    expect(
      w.logs.some((l) => l.startsWith('Credits used this billing period before the run: 1000')),
    ).toBe(true);
    expect(
      w.logs.some((l) =>
        l.includes('Usage endpoint: 1.85 credits used during the run. Ledger: 1.85.'),
      ),
    ).toBe(true);
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
      { executionId: EXEC, nextOffset: 100, rows: 100, pages: 1, lastPageCredits: 0.5 },
      { executionId: EXEC, nextOffset: 200, rows: 200, pages: 2 },
    ]);
  });

  it('stops before a page when the credits left are below the previous page cost, and resumes without paying twice', async () => {
    const w = world({ maxCredits: 100, pageRows: 50 }, { rows: 250, pageCost: 30 });
    const first = await run(w);
    // 100 - 0.35 - 3 x 30 leaves 9.65, below the 30 the last page cost.
    expect(first.status).toBe('stopped_budget');
    expect(first.message).toMatch(
      /Stopped before offset 150: 9\.65 credits left of the ceiling, below 30/,
    );
    expect(w.csvOffsets).toEqual([0, 50, 100]);
    expect(JSON.parse(readOut(w, 'discovery.csv.part.state.json'))).toMatchObject({
      nextOffset: 150,
      rows: 150,
    });
    expect(exists(w, 'discovery.csv')).toBe(false);

    // A second run with more budget continues from the next page: no new execution, no repeated page.
    w.args.maxCredits = 1000;
    const second = await run(w);
    expect(second).toMatchObject({ status: 'complete', pages: 5, rows: 250 });
    expect(w.executes()).toBe(1);
    expect(w.csvOffsets).toEqual([0, 50, 100, 150, 200]);
    expect(readOut(w, 'discovery.csv')).toBe(expectedCsv(250));
    expect(exists(w, 'discovery.csv.part.state.json')).toBe(false);
  });

  it('counts credits from earlier runs: a download stopped by the ceiling stops again on resume with the same ceiling', async () => {
    const w = world({ maxCredits: 100, pageRows: 50 }, { rows: 250, pageCost: 30 });
    const first = await run(w);
    expect(first.status).toBe('stopped_budget');
    expect(first.message).toContain('whole download');
    expect(w.csvOffsets).toEqual([0, 50, 100]);
    expect(JSON.parse(readOut(w, 'discovery.csv.part.state.json')).creditsSpent).toBeCloseTo(
      0.35 + 90,
      5,
    );

    // A new process, the same ceiling: the earlier spending is loaded before anything is requested.
    const second = await run(w);
    expect(second.status).toBe('stopped_budget');
    expect(second.message).toMatch(/Stopped before offset 150: 9\.65 credits left of the ceiling/);
    expect(w.csvOffsets).toEqual([0, 50, 100]); // no page was requested
    expect(w.executes()).toBe(1);
    expect(second.totalCredits).toBeCloseTo(90.35, 5);
    expect(w.logs.some((l) => l.startsWith('Earlier runs of this download recorded'))).toBe(true);
  });

  it('records the estimate for every page when usage does not move, and the stop rule still works', async () => {
    // 32,000 rows a page estimate 51.2 credits each; a ceiling of 160 allows three pages (the execution adds 0.35, from the status fixture).
    const w = world(
      { maxCredits: 160, pageRows: 32_000 },
      { rows: 200_000, pageCost: 0, execCost: 0 },
    );
    const s = await run(w);
    expect(s.status).toBe('stopped_budget');
    expect(w.csvOffsets).toEqual([0, 32_000, 64_000]);
    expect(w.logs.filter((l) => /^page \d+:.*credits 51\.2 \(estimated\)/.test(l))).toHaveLength(3);
    expect(w.logs.some((l) => l.includes('(measured)'))).toBe(false);
    expect(s.totalCredits).toBeCloseTo(153.95, 5);
    expect(s.message).toMatch(/Stopped before offset 96000: 6\.05 credits left of the ceiling/);
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
        lastPageCredits: 0.5,
        columns: null,
        filter: null,
        creditsSpent: 0.85,
      }),
    );
    const s = await run(w);
    expect(s).toMatchObject({ status: 'complete', rows: 250 });
    expect(readOut(w, 'discovery.csv')).toBe(expectedCsv(250));
  });

  it('needs 60 credits left before the first page', async () => {
    const w = world({ maxCredits: 50 });
    const s = await run(w);
    expect(s.status).toBe('stopped_budget');
    expect(s.message).toMatch(/below 60 \(the first-page headroom\)/);
    expect(w.csvOffsets).toEqual([]);
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
        lastPageCredits: 0.5,
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
    expect(w.logs.some((l) => l.startsWith('Usage endpoint'))).toBe(false);
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
