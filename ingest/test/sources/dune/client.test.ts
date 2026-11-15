/**
 * Tests for the Dune client. No live calls: every request goes to a fake fetch, and the clock is
 * fake, so nothing waits. The fixtures are hand-written from Dune's documentation (see
 * ../fixtures/dune/README.md); they were not recorded from the live API.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BudgetExceededError, UnitBudget } from '../../../src/sources/budget.js';
import {
  DuneClient,
  DuneDownloadTooLargeError,
  DuneRedirectError,
  DuneSizeUnknownError,
  exportCredits,
  type DuneClientOptions,
} from '../../../src/sources/dune/index.js';
import { HttpError, type FetchLike } from '../../../src/sources/http.js';
import { RateLimiter } from '../../../src/sources/ratelimit.js';
import { fakeClock } from '../helpers.js';
import { fakeGetFetch, fixtureText, type GetReply } from '../net-helpers.js';

const KEY = 'test-dune-key-5f3a9c0e77b14d2a';
const ID = '01HKZJ2683PHF9Q9PHHQ8FW4Q1';
const fx = (name: string) => fixtureText('dune', name);

interface PostRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}
interface PostReply {
  status?: number;
  body?: string;
  throws?: Error;
}

function fakePostFetch(answer: (req: PostRequest, n: number) => PostReply) {
  const requests: PostRequest[] = [];
  const fn: FetchLike = async (url, init) => {
    const req = { url, headers: init.headers, body: JSON.parse(init.body) as unknown };
    requests.push(req);
    const reply = answer(req, requests.length - 1);
    if (reply.throws) throw reply.throws;
    const status = reply.status ?? 200;
    return {
      status,
      ok: status < 300,
      headers: { get: () => null },
      text: async () => reply.body ?? '{}',
    };
  };
  return { fetch: fn, requests };
}

const pathOf = (url: string) => new URL(url).pathname;

function setup(
  opts: {
    post?: (req: PostRequest, n: number) => PostReply;
    get?: (url: string, n: number) => GetReply;
    budget?: UnitBudget;
  } & Partial<DuneClientOptions> = {},
) {
  const clock = fakeClock();
  const post = fakePostFetch(
    opts.post ??
      ((req) =>
        pathOf(req.url).endsWith('/sql/execute')
          ? { body: fx('execute') }
          : pathOf(req.url).endsWith('/cancel')
            ? { body: fx('cancel') }
            : { body: fx('usage-billing-periods') }),
  );
  const get = fakeGetFetch((req, n) =>
    opts.get ? opts.get(req.url, n) : { body: fx('status-completed') },
  );
  const { post: _p, get: _g, budget: _b, ...rest } = opts;
  void _p;
  void _g;
  void _b;
  const budget = opts.budget ?? new UnitBudget({ ceilingUnits: 1000 });
  const client = new DuneClient({
    apiKey: KEY,
    fetch: post.fetch,
    getFetch: get.fetch,
    budget,
    limiter: new RateLimiter({
      maxPerSecond: 1000,
      burst: 1000,
      now: clock.now,
      sleep: clock.sleep,
    }),
    now: clock.now,
    sleep: clock.sleep,
    http: { sleep: clock.sleep, random: () => 0.5, baseDelayMs: 10, maxRetries: 2 },
    ...rest,
  });
  return { client, budget, clock, post, get };
}

const dune = (b: UnitBudget) => b.summary('dune');

const tmpDirs: string[] = [];
function tmpFile(name = 'out.csv'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-test-'));
  tmpDirs.push(dir);
  return path.join(dir, name);
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('usage', () => {
  it('reads the billing_periods spelling and the key goes in the header, never the URL', async () => {
    const { client, post } = setup();
    const u = await client.usage();
    expect(u?.creditsRemaining).toBeCloseTo(3899.9);
    expect(u?.current).toMatchObject({ creditsUsed: 100.1, creditsIncluded: 4000 });
    expect(u?.bytesAllowed).toBe(10101);
    const req = post.requests[0]!;
    expect(pathOf(req.url)).toBe('/api/v1/usage');
    expect(req.headers['x-dune-api-key']).toBe(KEY);
    expect(req.url).not.toContain(KEY);
    expect(req.url).not.toContain('?');
  });

  it('reads the billingPeriods spelling and picks the latest period', async () => {
    const { client } = setup({ post: () => ({ body: fx('usage-billingPeriods') }) });
    const u = await client.usage();
    expect(u?.billingPeriods).toHaveLength(2);
    expect(u?.current?.endDate).toBe('2026-12-01');
  });

  it('is not charged to the budget', async () => {
    const { client, budget } = setup();
    await client.usage();
    expect(dune(budget).requests).toBe(0);
    expect(dune(budget).units).toBe(0);
  });
});

describe('executeSql', () => {
  it('reserves maxCredits before the call and sends the performance tier', async () => {
    let heldDuringCall = -1;
    const budget = new UnitBudget({ ceilingUnits: 1000 });
    const { client, post } = setup({
      budget,
      post: () => {
        heldDuringCall = budget.summary('dune').reservedUnits;
        return { body: fx('execute') };
      },
    });
    const r = await client.executeSql('select 1', { maxCredits: 40, performance: 'medium' });
    expect(r).toEqual({ status: 'started', executionId: ID, state: 'QUERY_STATE_PENDING' });
    expect(heldDuringCall).toBe(40);
    expect(dune(budget).reservedUnits).toBe(40); // still held until the execution ends
    expect(post.requests[0]!.body).toEqual({ sql: 'select 1', performance: 'medium' });
    expect(pathOf(post.requests[0]!.url)).toBe('/api/v1/sql/execute');
  });

  it('makes no request when maxCredits does not fit the budget', async () => {
    const { client, post } = setup({ budget: new UnitBudget({ ceilingUnits: 30 }) });
    await expect(client.executeSql('select 1', { maxCredits: 40 })).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
    expect(post.requests).toHaveLength(0);
  });

  it('rejects a maxCredits that is not positive', async () => {
    const { client } = setup();
    await expect(client.executeSql('select 1', { maxCredits: 0 })).rejects.toThrow(RangeError);
    await expect(client.executeSql('select 1', { maxCredits: Number.NaN })).rejects.toThrow(
      RangeError,
    );
  });

  it('releases the reservation when the request fails', async () => {
    const budget = new UnitBudget({ ceilingUnits: 1000 });
    const { client } = setup({ budget, post: () => ({ status: 400, body: '{"error":"bad"}' }) });
    await expect(client.executeSql('select', { maxCredits: 40 })).rejects.toBeInstanceOf(HttpError);
    expect(dune(budget).reservedUnits).toBe(0);
    expect(dune(budget).units).toBe(0);
  });

  it('assumes the worst case when Dune answers with something unreadable', async () => {
    const budget = new UnitBudget({ ceilingUnits: 1000 });
    const { client } = setup({ budget, post: () => ({ body: '{"nope":1}' }) });
    await expect(client.executeSql('select 1', { maxCredits: 40 })).rejects.toThrow(/execute/);
    expect(dune(budget)).toMatchObject({ reservedUnits: 0, units: 40, estimatedUnits: 40 });
  });
});

describe('waitForExecution', () => {
  const statuses = ['status-pending', 'status-executing', 'status-executing', 'status-completed'];

  it('polls with backoff until done and records the cost Dune reports', async () => {
    const budget = new UnitBudget({ ceilingUnits: 1000 });
    const { client, clock } = setup({
      budget,
      get: (_url, n) => ({ body: fx(statuses[Math.min(n, statuses.length - 1)]!) }),
    });
    await client.executeSql('select 1', { maxCredits: 40 });
    const r = await client.waitForExecution(ID);
    expect(r).toMatchObject({
      outcome: 'completed',
      reportedCredits: 10,
      chargedCredits: 10,
      estimated: false,
      rowCount: 4,
      resultBytes: 1_500_000,
    });
    // 2 s, then 1.5 times that, and so on.
    expect(clock.sleeps).toEqual([2000, 3000, 4500]);
    // What the budget holds is the reported 10, not the reserved 40 and not an estimate.
    expect(dune(budget)).toMatchObject({
      units: 10,
      estimatedUnits: 0,
      reservedUnits: 0,
      requests: 1,
    });
    expect(client.openExecutions()).toEqual([]);
  });

  it('caps the wait between polls', async () => {
    const { client, clock } = setup({
      get: (_u, n) => ({ body: fx(n < 8 ? 'status-executing' : 'status-completed') }),
    });
    await client.executeSql('select 1', { maxCredits: 40 });
    await client.waitForExecution(ID, { pollStartMs: 5000, pollMaxMs: 8000, backoffFactor: 2 });
    expect(clock.sleeps).toEqual([5000, 8000, 8000, 8000, 8000, 8000, 8000, 8000]);
  });

  it('settles at maxCredits, marked estimated, when Dune reports no cost', async () => {
    const budget = new UnitBudget({ ceilingUnits: 1000 });
    const noCost = JSON.stringify({
      ...JSON.parse(fx('status-completed')),
      execution_cost_credits: undefined,
    });
    const { client } = setup({ budget, get: () => ({ body: noCost }) });
    await client.executeSql('select 1', { maxCredits: 40 });
    const r = await client.waitForExecution(ID);
    expect(r).toMatchObject({
      outcome: 'completed',
      reportedCredits: null,
      chargedCredits: 40,
      estimated: true,
    });
    expect(dune(budget)).toMatchObject({ units: 40, estimatedUnits: 40, reservedUnits: 0 });
  });

  it('returns a failed execution as a result, with its error text and zero cost', async () => {
    const budget = new UnitBudget({ ceilingUnits: 1000 });
    const { client } = setup({ budget, get: () => ({ body: fx('status-failed') }) });
    await client.executeSql('select x', { maxCredits: 40 });
    const r = await client.waitForExecution(ID);
    expect(r).toMatchObject({
      outcome: 'failed',
      errorType: 'FAILED_TYPE_EXECUTION_FAILED',
      chargedCredits: 0,
    });
    expect(r.outcome === 'failed' && r.error).toContain("Column 'x' cannot be resolved");
    expect(dune(budget).units).toBe(0);
    expect(dune(budget).reservedUnits).toBe(0);
  });

  it('scrubs the key from a failed execution error text', async () => {
    const failed = JSON.parse(fx('status-failed'));
    failed.error.message = `bad thing near ${KEY} and https://x/y?api_key=${KEY}&z=1`;
    const { client } = setup({ get: () => ({ body: JSON.stringify(failed) }) });
    await client.executeSql('select x', { maxCredits: 40 });
    const r = await client.waitForExecution(ID);
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(r.outcome === 'failed' && r.error).toContain('api_key=[redacted]');
  });

  it('reports a partial result without treating it as complete', async () => {
    const { client } = setup({ get: () => ({ body: fx('status-partial') }) });
    await client.executeSql('select 1', { maxCredits: 40 });
    expect(await client.waitForExecution(ID)).toMatchObject({
      outcome: 'partial',
      chargedCredits: 12,
    });
  });

  it('stops at the time limit, cancels, and records the cost of the cancelled execution', async () => {
    const budget = new UnitBudget({ ceilingUnits: 1000 });
    let cancelled = false;
    const { client, clock, post } = setup({
      budget,
      post: (req) => {
        if (pathOf(req.url).endsWith('/cancel')) {
          cancelled = true;
          return { body: fx('cancel') };
        }
        return { body: fx('execute') };
      },
      get: () => ({ body: fx(cancelled ? 'status-cancelled' : 'status-executing') }),
    });
    await client.executeSql('select 1', { maxCredits: 40 });
    const r = await client.waitForExecution(ID, { timeLimitMs: 60_000 });
    expect(r).toMatchObject({
      outcome: 'timed_out',
      cancelRequested: true,
      cancelSucceeded: true,
      reportedCredits: 4.5,
      chargedCredits: 4.5,
    });
    const cancels = post.requests.filter((q) => pathOf(q.url).endsWith('/cancel'));
    expect(cancels).toHaveLength(1);
    expect(pathOf(cancels[0]!.url)).toBe(`/api/v1/execution/${ID}/cancel`);
    expect(clock.now()).toBeGreaterThanOrEqual(60_000);
    expect(clock.now()).toBeLessThan(60_000 + 15_000); // it did not keep polling past the limit
    expect(dune(budget)).toMatchObject({ units: 4.5, reservedUnits: 0 });
  });

  it('settles a timed-out execution at maxCredits when the cancel fails and no cost is known', async () => {
    const budget = new UnitBudget({ ceilingUnits: 1000 });
    const { client } = setup({
      budget,
      post: (req) =>
        pathOf(req.url).endsWith('/cancel')
          ? { status: 400, body: '{"error":"no"}' }
          : { body: fx('execute') },
      get: () => ({ body: fx('status-executing') }),
    });
    await client.executeSql('select 1', { maxCredits: 40 });
    const r = await client.waitForExecution(ID, { timeLimitMs: 10_000 });
    expect(r).toMatchObject({
      outcome: 'timed_out',
      cancelSucceeded: false,
      chargedCredits: 40,
      estimated: true,
    });
    expect(dune(budget)).toMatchObject({ units: 40, estimatedUnits: 40, reservedUnits: 0 });
  });

  it('throws an HTTP failure while polling, keeps the reservation, and abandon settles it', async () => {
    const budget = new UnitBudget({ ceilingUnits: 1000 });
    const { client, get } = setup({ budget, get: () => ({ status: 503, body: 'down' }) });
    await client.executeSql('select 1', { maxCredits: 40 });
    await expect(client.waitForExecution(ID)).rejects.toBeInstanceOf(HttpError);
    expect(get.requests).toHaveLength(3); // 1 try and 2 retries
    expect(dune(budget).reservedUnits).toBe(40);
    client.abandon(ID);
    expect(dune(budget)).toMatchObject({ reservedUnits: 0, units: 40, estimatedUnits: 40 });
  });

  it('sends status requests through the shared rate limiter', async () => {
    const clock = fakeClock();
    // One request a second: three status requests need two waits of one second.
    const limiter = new RateLimiter({
      maxPerSecond: 1,
      burst: 1,
      now: clock.now,
      sleep: clock.sleep,
    });
    const { client } = setup({
      limiter,
      now: clock.now,
      sleep: clock.sleep,
      get: (_u, n) => ({ body: fx(n < 2 ? 'status-executing' : 'status-completed') }),
    });
    await client.executeSql('select 1', { maxCredits: 40 });
    await client.waitForExecution(ID, { pollStartMs: 1, pollMaxMs: 1, backoffFactor: 1 });
    // The limiter slept to keep to one request a second, on top of the 1 ms poll waits.
    expect(clock.sleeps.filter((s) => s > 100).length).toBeGreaterThanOrEqual(2);
  });
});

describe('redirects', () => {
  it('refuses a redirect on POST', async () => {
    const { client } = setup({ post: () => ({ status: 302 }) });
    await expect(client.usage()).rejects.toBeInstanceOf(DuneRedirectError);
  });

  it('refuses a redirect on GET (status)', async () => {
    const { client, get } = setup({
      get: () => ({ status: 302, headers: { location: 'https://elsewhere.example/x' } }),
    });
    await client.executeSql('select 1', { maxCredits: 40 });
    await expect(client.waitForExecution(ID)).rejects.toBeInstanceOf(DuneRedirectError);
    expect(get.requests).toHaveLength(1);
    expect(get.requests.every((r) => r.url.startsWith('https://api.dune.com/'))).toBe(true);
  });

  it('refuses a redirect on GET (csv) and releases the export reservation', async () => {
    const budget = new UnitBudget({ ceilingUnits: 1000 });
    const { client } = setup({ budget, get: () => ({ status: 307 }) });
    await expect(client.downloadCsv(ID, tmpFile(), { resultBytes: 100 })).rejects.toBeInstanceOf(
      DuneRedirectError,
    );
    expect(dune(budget).reservedUnits).toBe(0);
  });
});

describe('downloadCsv', () => {
  it('computes the cost per started MB and the rate is an option', () => {
    expect(exportCredits(1, 10)).toBe(10);
    expect(exportCredits(1024 * 1024, 10)).toBe(10);
    expect(exportCredits(1024 * 1024 + 1, 10)).toBe(20);
    expect(exportCredits(1_500_000, 2)).toBe(4);
  });

  it('streams to the file, counts bytes, and records the computed export cost', async () => {
    const budget = new UnitBudget({ ceilingUnits: 1000 });
    const body = fs.readFileSync(
      new URL('../fixtures/dune/graduates.csv', import.meta.url),
      'utf8',
    );
    const { client, get } = setup({ budget, get: () => ({ body }) });
    const out = tmpFile();
    const r = await client.downloadCsv(ID, out, { resultBytes: 1_500_000, maxBytes: 2_000_000 });
    expect(r).toMatchObject({
      status: 'downloaded',
      bytes: Buffer.byteLength(body),
      credits: 10,
      reservedCredits: 20,
    });
    expect(fs.readFileSync(out, 'utf8')).toBe(body);
    expect(get.requests[0]!.url).toBe(`https://api.dune.com/api/v1/execution/${ID}/results/csv`);
    expect(get.requests[0]!.headers['x-dune-api-key']).toBe(KEY);
    expect(dune(budget)).toMatchObject({ units: 10, estimatedUnits: 10, reservedUnits: 0 });
  });

  it('uses the configured rate', async () => {
    const budget = new UnitBudget({ ceilingUnits: 1000 });
    const { client } = setup({
      budget,
      exportCreditsPerMb: 2,
      get: () => ({ body: 'a,b\n1,2\n' }),
    });
    const r = await client.downloadCsv(ID, tmpFile(), { resultBytes: 3 * 1024 * 1024 });
    expect(r).toMatchObject({ reservedCredits: 6, credits: 2 });
  });

  it('is refused, with no request, when the computed cost does not fit the budget', async () => {
    const { client, get } = setup({ budget: new UnitBudget({ ceilingUnits: 15 }) });
    // 1.5 MB rounds up to 2 MB, 20 credits at the default rate of 10.
    await expect(
      client.downloadCsv(ID, tmpFile(), { resultBytes: 1_500_000 }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    expect(get.requests).toHaveLength(0);
  });

  it('is refused when the size is not known and no maxBytes is given', async () => {
    const { client, get } = setup();
    await expect(client.downloadCsv(ID, tmpFile(), {})).rejects.toBeInstanceOf(
      DuneSizeUnknownError,
    );
    await expect(client.downloadCsv(ID, tmpFile(), { resultBytes: null })).rejects.toBeInstanceOf(
      DuneSizeUnknownError,
    );
    expect(get.requests).toHaveLength(0);
  });

  it('cuts the stream off at maxBytes, removes the file and records what was received', async () => {
    const budget = new UnitBudget({ ceilingUnits: 1000 });
    const chunks = Array.from({ length: 50 }, () => new TextEncoder().encode('x'.repeat(100)));
    const { client, get } = setup({ budget, get: () => ({ body: chunks }) });
    const out = tmpFile();
    await expect(client.downloadCsv(ID, out, { maxBytes: 1000 })).rejects.toBeInstanceOf(
      DuneDownloadTooLargeError,
    );
    expect(fs.existsSync(out)).toBe(false);
    expect(get.pulled[0]).toBeLessThan(50); // it stopped reading instead of draining the body
    expect(dune(budget).reservedUnits).toBe(0);
    expect(dune(budget).units).toBeLessThanOrEqual(10);
  });

  it('refuses a body whose declared length is over the cap before reading it', async () => {
    const { client, get } = setup({
      get: () => ({ body: 'abc', headers: { 'content-length': '5000' } }),
    });
    await expect(client.downloadCsv(ID, tmpFile(), { maxBytes: 1000 })).rejects.toBeInstanceOf(
      DuneDownloadTooLargeError,
    );
    expect(get.pulled[0]).toBe(0);
  });
});

describe('dry run', () => {
  it('lists the executions and exports and makes no call', async () => {
    const { client, post, get } = setup({ dryRun: true });
    expect(await client.usage()).toBeNull();
    expect(await client.executeSql('select 1', { maxCredits: 40 })).toEqual({ status: 'dry_run' });
    expect(await client.waitForExecution('x')).toEqual({ outcome: 'dry_run' });
    expect(await client.downloadCsv('x', tmpFile(), { maxBytes: 1_500_000 })).toEqual({
      status: 'dry_run',
    });
    expect(post.requests).toHaveLength(0);
    expect(get.requests).toHaveLength(0);
    expect(client.requestCount()).toBe(0);
    const plan = client.plan();
    expect(plan.calls.map((c) => c.kind)).toEqual(['usage', 'execute', 'export']);
    expect(plan.calls[1]).toMatchObject({ credits: 40 });
    expect(plan.calls[2]).toMatchObject({ credits: 20 });
    expect(plan.totalCredits).toBe(60);
  });

  it('writes no file', async () => {
    const { client } = setup({ dryRun: true });
    const out = tmpFile();
    await client.downloadCsv('x', out, { maxBytes: 100 });
    expect(fs.existsSync(out)).toBe(false);
  });
});

describe('the key', () => {
  it('never appears in an error, whatever Dune echoes back', async () => {
    const echo = `{"error":"Invalid API Key ${KEY}","url":"https://api.dune.com/api/v1/usage?api_key=${KEY}"}`;
    const attempts: Array<() => Promise<unknown>> = [];
    const post401 = setup({ post: () => ({ status: 401, body: echo }) });
    attempts.push(() => post401.client.usage());
    attempts.push(() => post401.client.executeSql('select 1', { maxCredits: 5 }));
    const post500 = setup({ post: () => ({ status: 500, body: echo }) });
    attempts.push(() => post500.client.usage());
    const get404 = setup({ get: () => ({ status: 404, body: echo }) });
    await get404.client.executeSql('select 1', { maxCredits: 5 });
    attempts.push(() => get404.client.waitForExecution(ID));
    attempts.push(() => get404.client.downloadCsv(ID, tmpFile(), { maxBytes: 100 }));
    const get500 = setup({ get: () => ({ status: 500, body: echo }) });
    await get500.client.executeSql('select 1', { maxCredits: 5 });
    attempts.push(() => get500.client.waitForExecution(ID));

    for (const attempt of attempts) {
      const err = (await attempt().then(
        () => null,
        (e: unknown) => e,
      )) as HttpError | null;
      expect(err).toBeInstanceOf(HttpError);
      const everything = [
        err!.message,
        err!.bodySnippet,
        err!.stack ?? '',
        JSON.stringify(err),
      ].join('\n');
      expect(everything).not.toContain(KEY);
      expect(everything).toContain('[redacted]');
    }
  });

  it('is not in the error when the fetch itself throws', async () => {
    const { client } = setup({ post: () => ({ throws: new Error(`connect failed for ${KEY}`) }) });
    const err = await client.usage().then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(HttpError);
    expect(err!.message).not.toContain(KEY);
  });

  it('is never sent in a URL', async () => {
    const { client, post, get } = setup({ get: () => ({ body: 'a\n1\n' }) });
    await client.usage();
    await client.executeSql('select 1', { maxCredits: 5 });
    await client.waitForExecution(ID).catch(() => undefined);
    await client.downloadCsv(ID, tmpFile(), { maxBytes: 100 });
    const urls = [...post.requests, ...get.requests].map((r) => r.url);
    expect(urls.length).toBeGreaterThan(3);
    for (const u of urls) {
      expect(u).not.toContain(KEY);
      expect(u).not.toMatch(/api_key/i);
    }
  });

  it('is not in the plan or the budget summary', async () => {
    const { client, budget } = setup({ dryRun: true });
    await client.executeSql('select 1', { maxCredits: 5 });
    expect(JSON.stringify(client.plan())).not.toContain(KEY);
    expect(JSON.stringify(budget.summary('dune'))).not.toContain(KEY);
  });

  it('rejects an empty key', () => {
    expect(() => new DuneClient({ apiKey: '  ' })).toThrow();
  });
});
