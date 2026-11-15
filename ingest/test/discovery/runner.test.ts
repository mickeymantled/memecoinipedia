/**
 * Tests for the discovery runner script. Dune is a fake fetch and the clock is fake: nothing is
 * sent anywhere. The status fixture is hand-written from Dune's docs, not recorded.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildPlan,
  main,
  monthParams,
  monthsBetween,
  parseRunnerArgs,
  runMonths,
  sizeAndSample,
  UsageError,
  type RunnerArgs,
} from '../../scripts/dune-discovery.js';
import { GRADUATE_COLUMNS } from '../../src/discovery/index.js';
import { UnitBudget } from '../../src/sources/budget.js';
import { DuneClient } from '../../src/sources/dune/index.js';
import type { FetchLike } from '../../src/sources/http.js';
import { RateLimiter } from '../../src/sources/ratelimit.js';
import { fakeClock } from '../sources/helpers.js';
import { fakeGetFetch, fixture } from '../sources/net-helpers.js';

const KEY = 'runner-test-key-0d8c41aa9e';
const A = '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump';
const B = '2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump';
const TEMPLATE =
  "select * from t where d >= DATE '{{month_start}}' and d < DATE '{{month_end}}' -- {{window_days}}\n";

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

function csvFor(month: string): string {
  const mint = month.endsWith('01') ? A : B;
  const cols = GRADUATE_COLUMNS.map((c) =>
    c === 'mint'
      ? mint
      : c === 'created_at'
        ? `${month}-10 00:00:00`
        : c === 'rough_peak_usd'
          ? '150000'
          : '',
  );
  return `${GRADUATE_COLUMNS.join(',')}\n${cols.join(',')}\n`;
}

interface World {
  args: RunnerArgs;
  client: DuneClient;
  budget: UnitBudget;
  posts: Array<{ url: string; body: unknown }>;
  gets: string[];
  logs: string[];
  log: (l: string) => void;
}

function world(
  over: Partial<RunnerArgs> = {},
  opts: { cost?: number; failMonth?: string; template?: string } = {},
): World {
  const dir = tmp();
  const sql = path.join(dir, 'graduates.sql');
  fs.writeFileSync(sql, opts.template ?? TEMPLATE);
  const args: RunnerArgs = {
    from: '2024-01',
    to: '2024-03',
    windowDays: 90,
    maxCredits: 1000,
    exportRate: 10,
    performance: 'medium',
    out: path.join(dir, 'out'),
    sql,
    probes: path.join(dir, 'probes.json'),
    minHeadroom: 50,
    confirm: true,
    ...over,
  };
  const clock = fakeClock();
  const posts: World['posts'] = [];
  const executions = new Map<string, string>(); // execution id -> month
  const post: FetchLike = async (url, init) => {
    const body = JSON.parse(init.body) as { sql?: string };
    posts.push({ url, body });
    let reply = '{}';
    if (url.endsWith('/sql/execute')) {
      const month = /DATE '(\d{4}-\d{2})-01' and/.exec(body.sql ?? '')?.[1] ?? 'x';
      const id = `exec-${month}`;
      executions.set(id, month);
      reply = JSON.stringify({ execution_id: id, state: 'QUERY_STATE_PENDING' });
    }
    return { status: 200, ok: true, headers: { get: () => null }, text: async () => reply };
  };
  const get = fakeGetFetch((req) => {
    const id = /execution\/([^/]+)\//.exec(req.url)?.[1] ?? '';
    const month = executions.get(id) ?? '';
    if (req.url.endsWith('/status')) {
      const s = fixture('dune', opts.failMonth === month ? 'status-failed' : 'status-completed');
      s.execution_id = id;
      if (opts.cost !== undefined && s.state === 'QUERY_STATE_COMPLETED')
        s.execution_cost_credits = opts.cost;
      if (s.result_metadata) s.result_metadata.total_result_set_bytes = 1000;
      return { body: JSON.stringify(s) };
    }
    return { body: csvFor(month) };
  });
  const budget = new UnitBudget({ ceilingUnits: args.maxCredits ?? undefined });
  const client = new DuneClient({
    apiKey: KEY,
    fetch: post,
    getFetch: get.fetch,
    budget,
    exportCreditsPerMb: args.exportRate,
    limiter: new RateLimiter({
      maxPerSecond: 1000,
      burst: 1000,
      now: clock.now,
      sleep: clock.sleep,
    }),
    now: clock.now,
    sleep: clock.sleep,
    http: { sleep: clock.sleep, random: () => 0.5, baseDelayMs: 1 },
  });
  const logs: string[] = [];
  return {
    args,
    client,
    budget,
    posts,
    gets: get.requests.map((r) => r.url),
    logs,
    log: (l) => logs.push(l),
  };
}

const run = (w: World) => runMonths({ args: w.args, client: w.client, log: w.log });
const files = (w: World) => (fs.existsSync(w.args.out) ? fs.readdirSync(w.args.out).sort() : []);

describe('parseRunnerArgs', () => {
  it('applies the defaults', () => {
    const a = parseRunnerArgs(['--from', '2024-01', '--to', '2026-10']);
    expect(a).toMatchObject({
      windowDays: 90,
      maxCredits: null,
      exportRate: 10,
      performance: 'medium',
      minHeadroom: 50,
      confirm: false,
    });
    expect(a.out.endsWith(path.join('data', 'dune'))).toBe(true);
    expect(a.sql.endsWith(path.join('ingest', 'sql', 'dune', 'graduates.sql'))).toBe(true);
  });

  it('reads every option', () => {
    const a = parseRunnerArgs([
      '--from',
      '2024-01',
      '--to',
      '2024-02',
      '--window-days',
      '30',
      '--max-credits',
      '200.5',
      '--export-rate',
      '2',
      '--performance',
      'large',
      '--out',
      '/x/y',
      '--min-headroom',
      '5',
      '--confirm',
    ]);
    expect(a).toMatchObject({
      windowDays: 30,
      maxCredits: 200.5,
      exportRate: 2,
      performance: 'large',
      out: '/x/y',
      minHeadroom: 5,
      confirm: true,
    });
  });

  it.each([
    [[]],
    [['--from', '2024-01']],
    [['--from', '2024-13', '--to', '2024-14']],
    [['--from', '2024-05', '--to', '2024-01']],
    [['--from', '2024-01', '--to', '2024-02', '--max-credits', '0']],
    [['--from', '2024-01', '--to', '2024-02', '--max-credits', 'abc']],
    [['--from', '2024-01', '--to', '2024-02', '--window-days', '1.5']],
    [['--from', '2024-01', '--to', '2024-02', '--performance', 'huge']],
    [['--from', '2024-01', '--to', '2024-02', '--bogus', '1']],
    [['--from', '2024-01', '--to']],
    [['--from', '2024-01', '--to', '2024-02', '--confirm']], // no --max-credits
  ])('rejects %j', (argv) => {
    expect(() => parseRunnerArgs(argv)).toThrow(UsageError);
  });
});

describe('months and parameters', () => {
  it('lists months across a year end, both ends included', () => {
    expect(monthsBetween('2024-11', '2025-02')).toEqual([
      '2024-11',
      '2024-12',
      '2025-01',
      '2025-02',
    ]);
    expect(monthsBetween('2024-05', '2024-05')).toEqual(['2024-05']);
  });

  it('fills only the placeholders the template uses, and rejects any other', () => {
    expect(
      monthParams('2024-12', 90, ['month_start', 'month_end', 'window_end', 'window_days']),
    ).toEqual({
      month_start: '2024-12-01',
      month_end: '2025-01-01',
      window_end: '2025-04-01',
      window_days: 90,
    });
    expect(monthParams('2024-02', 30, ['month_end'])).toEqual({ month_end: '2024-03-01' });
    expect(() => monthParams('2024-02', 30, ['month_start', 'wallet'])).toThrow(/wallet/);
  });
});

describe('without --confirm', () => {
  it('prints the plan, exits 0, builds no client and calls nothing', async () => {
    const w = world({ confirm: false });
    fs.mkdirSync(w.args.out, { recursive: true });
    fs.writeFileSync(path.join(w.args.out, 'graduates-2024-02.csv'), 'x');
    const fetchSpy = vi.fn(() => {
      throw new Error('network call');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const out: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((l: string) => void out.push(l));
    const code = await main(
      [
        '--from',
        '2024-01',
        '--to',
        '2024-03',
        '--out',
        w.args.out,
        '--sql',
        w.args.sql,
        '--max-credits',
        '100',
      ],
      { DUNE_API_KEY: KEY },
    );
    spy.mockRestore();
    expect(code).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(w.posts).toHaveLength(0);
    const text = out.join('\n');
    expect(text).toContain('Already on disk (skipped): 2024-02');
    expect(text).toContain('Would run: 2024-01, 2024-03');
    expect(text).toContain('SQL template renders for 2024-01');
    expect(text).not.toContain(KEY);
    expect(files(w)).toEqual(['graduates-2024-02.csv']); // nothing written
  });

  it('works without a key and says so when the SQL file is missing', async () => {
    const w = world({ confirm: false });
    const plan = buildPlan({ ...w.args, sql: path.join(path.dirname(w.args.sql), 'nope.sql') });
    expect(plan.sqlExists).toBe(false);
    expect(plan.text).toContain('MISSING');
    expect(
      await main(['--from', '2024-01', '--to', '2024-01', '--sql', '/nonexistent/x.sql'], {}),
    ).toBe(0);
  });

  it('with --confirm but no key, stops before any call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const code = await main(
      ['--from', '2024-01', '--to', '2024-01', '--max-credits', '10', '--confirm'],
      {},
    );
    err.mockRestore();
    log.mockRestore();
    expect(code).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('runMonths', () => {
  it('runs each month, saves its file, and prints rows, bytes, credits and the running total', async () => {
    const w = world();
    const s = await run(w);
    expect(s).toMatchObject({
      status: 'complete',
      ran: ['2024-01', '2024-02', '2024-03'],
      skipped: [],
      totalCredits: 60,
    });
    expect(files(w)).toEqual([
      'graduates-2024-01.csv',
      'graduates-2024-02.csv',
      'graduates-2024-03.csv',
    ]);
    expect(fs.readFileSync(path.join(w.args.out, 'graduates-2024-02.csv'), 'utf8')).toBe(
      csvFor('2024-02'),
    );
    expect(w.logs).toHaveLength(3);
    expect(w.logs[0]).toMatch(
      /^2024-01: rows 4, bytes \d+, execution credits 10, export credits 10, running total 20$/,
    );
    expect(w.logs[2]).toMatch(/running total 60$/);
    const executes = w.posts.filter((p) => p.url.endsWith('/sql/execute'));
    expect(executes).toHaveLength(3);
    expect((executes[0]!.body as { sql: string }).sql).toBe(
      "select * from t where d >= DATE '2024-01-01' and d < DATE '2024-02-01' -- 90\n",
    );
    expect((executes[0]!.body as { performance: string }).performance).toBe('medium');
  });

  it('is resumable: months already on disk are skipped and cost nothing', async () => {
    const w = world();
    await run(w);
    const before = { posts: w.posts.length, gets: w.gets.length };
    const again = await run(w);
    expect(again).toMatchObject({
      status: 'complete',
      ran: [],
      skipped: ['2024-01', '2024-02', '2024-03'],
    });
    expect(w.posts.length).toBe(before.posts);
    expect(w.gets.length).toBe(before.gets);
  });

  it('after a partial run, only the missing months run; a stale .part file is replaced', async () => {
    const w = world();
    fs.mkdirSync(w.args.out, { recursive: true });
    fs.writeFileSync(path.join(w.args.out, 'graduates-2024-01.csv'), csvFor('2024-01'));
    fs.writeFileSync(path.join(w.args.out, 'graduates-2024-02.csv.part'), 'half a file');
    const s = await run(w);
    expect(s).toMatchObject({
      status: 'complete',
      ran: ['2024-02', '2024-03'],
      skipped: ['2024-01'],
    });
    expect(files(w)).toEqual([
      'graduates-2024-01.csv',
      'graduates-2024-02.csv',
      'graduates-2024-03.csv',
    ]);
    expect(fs.readFileSync(path.join(w.args.out, 'graduates-2024-02.csv'), 'utf8')).toBe(
      csvFor('2024-02'),
    );
  });

  it('enforces --max-credits: stops before a month when the credits left are below the largest month', async () => {
    const w = world({ maxCredits: 45, minHeadroom: 10 });
    const s = await run(w);
    // Months cost 20 each. After two, 5 are left, below the largest month (20).
    expect(s).toMatchObject({
      status: 'stopped_budget',
      ran: ['2024-01', '2024-02'],
      totalCredits: 40,
    });
    expect(s.message).toMatch(/Stopped before 2024-03: 5 credits left, below 20/);
    expect(files(w)).toEqual(['graduates-2024-01.csv', 'graduates-2024-02.csv']);
    expect(w.posts.filter((p) => p.url.endsWith('/sql/execute'))).toHaveLength(2);
    expect(w.budget.summary('dune').units).toBeLessThanOrEqual(45);
  });

  it('uses --min-headroom before the first month has run', async () => {
    const w = world({ maxCredits: 30, minHeadroom: 50 });
    const s = await run(w);
    expect(s.status).toBe('stopped_budget');
    expect(s.message).toMatch(/below 50 \(--min-headroom\)/);
    expect(w.posts).toHaveLength(0);
    expect(files(w)).toEqual([]);
  });

  it('stops and names the execution when the export does not fit what is left', async () => {
    // The execution costs 20, so 5 credits are left, and the export needs 10.
    const w = world({ maxCredits: 25, minHeadroom: 10 }, { cost: 20 });
    const s = await run(w);
    expect(s.status).toBe('stopped_budget');
    expect(s.message).toContain('exec-2024-01');
    expect(s.ran).toEqual([]);
    expect(files(w)).toEqual([]); // no file, and no .part file left behind
    expect(w.gets.some((u) => u.endsWith('/results/csv'))).toBe(false);
    expect(w.budget.summary('dune').units).toBe(20);
  });

  it('stops on a failed execution without writing a file', async () => {
    const w = world({}, { failMonth: '2024-02' });
    const s = await run(w);
    expect(s.status).toBe('failed');
    expect(s.ran).toEqual(['2024-01']);
    expect(s.message).toMatch(/2024-02: execution exec-2024-02 failed: .*Column 'x'/);
    expect(files(w)).toEqual(['graduates-2024-01.csv']);
  });

  it('fails with a clear message, before any call, when the SQL file is missing', async () => {
    const w = world();
    fs.rmSync(w.args.sql);
    const s = await run(w);
    expect(s).toMatchObject({ status: 'failed', ran: [] });
    expect(s.message).toContain('SQL file not found');
    expect(w.posts).toHaveLength(0);
  });

  it('fails before spending when the template uses a placeholder it cannot fill', async () => {
    const w = world({}, { template: 'select {{wallet}}' });
    const s = await run(w);
    expect(s.status).toBe('failed');
    expect(s.message).toMatch(/wallet/);
    expect(w.posts).toHaveLength(0);
  });

  it('writes a header-only file for a month with no rows, without an export', async () => {
    const w = world();
    const get = vi.spyOn(w.client, 'downloadCsv');
    // Rewire the status to say zero rows.
    const client2 = new DuneClient({
      apiKey: KEY,
      budget: w.budget,
      fetch: async (url) => ({
        status: 200,
        ok: true,
        headers: { get: () => null },
        text: async () =>
          url.endsWith('/sql/execute')
            ? '{"execution_id":"e1","state":"QUERY_STATE_PENDING"}'
            : '{}',
      }),
      getFetch: fakeGetFetch(() => ({
        body: JSON.stringify({
          state: 'QUERY_STATE_COMPLETED',
          execution_cost_credits: 3,
          result_metadata: {
            total_row_count: 0,
            total_result_set_bytes: 0,
            column_names: ['mint', 'created_at'],
          },
        }),
      })).fetch,
      limiter: new RateLimiter({ maxPerSecond: 1000, burst: 1000 }),
    });
    const s = await runMonths({ args: { ...w.args, to: '2024-01' }, client: client2, log: w.log });
    expect(s).toMatchObject({ status: 'complete', ran: ['2024-01'], totalCredits: 3 });
    expect(fs.readFileSync(path.join(w.args.out, 'graduates-2024-01.csv'), 'utf8')).toBe(
      'mint,created_at\n',
    );
    expect(get).not.toHaveBeenCalled();
  });

  it('never prints the key', async () => {
    const w = world({}, { failMonth: '2024-02' });
    await run(w);
    expect(w.logs.join('\n')).not.toContain(KEY);
  });
});

describe('sizeAndSample', () => {
  it('reads the month files, prints the table and writes sample.csv with the probes', async () => {
    const w = world({ to: '2024-02' });
    await run(w);
    fs.writeFileSync(
      w.args.probes,
      JSON.stringify([
        { mint: A },
        { mint: 'GoneGoneGoneGoneGoneGoneGoneGoneGone1' },
        { symbol: 'no mint' },
      ]),
    );
    await sizeAndSample({ ...w.args, to: '2024-02' }, w.log);
    const text = w.logs.join('\n');
    expect(text).toContain('Read 2 rows from 2 files: 2 kept, 0 bad, 0 duplicates.');
    expect(text).toContain('month\tgrad');
    expect(text).toMatch(/Sample: 3 coins \(2 probes, 1 missing from the list\)/);
    const sample = fs.readFileSync(path.join(w.args.out, 'sample.csv'), 'utf8').trim().split('\n');
    expect(sample[0]).toBe('mint,half_year,cell,probe,probe_missing,created_at,rough_peak_usd');
    expect(sample).toHaveLength(1 + 3);
    expect(sample[1]!.startsWith(`${A},2024-H1,100k-1M,true,false,`)).toBe(true);
  });
});
