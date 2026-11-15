import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { sql } from 'kysely';
import {
  countByRoughPeak,
  countListed,
  keyOf,
  recordUsageSample,
  resolveSelection,
  seedBackfillChunk,
  selectionPage,
  stageBreakdown,
  usageWindow,
  type BackfillSeedRow,
  type ResolvedSelection,
  type SelectionSpec,
} from '../src/backfill.js';
import { createReadOnlyDb } from '../src/client.js';
import { createRun, recordUsage } from '../src/runs.js';
import { claimStage, finishStage } from '../src/stages.js';
import { createTestDatabase, type TestDatabase } from '../src/testing.js';
import { adminUrl, describeDb } from './helpers.js';

const NOW = new Date('2026-11-15T10:00:00Z');
const LATER = new Date('2026-11-15T11:00:00Z');

const addr = (i: number): string => `A${String(i).padStart(43, '0')}`;
const row = (
  i: number,
  rough: number | null,
  extra: Partial<BackfillSeedRow> = {},
): BackfillSeedRow => ({
  address: addr(i),
  launchpad: 'pump.fun',
  launchedAt: new Date('2025-01-01T00:00:00Z'),
  creatorWallet: null,
  graduatedAt: new Date('2025-01-01T01:00:00Z'),
  roughAthMarketCapUsd: rough,
  ...extra,
});
const opts = { chain: 'solana', discoverySource: 'test-file', now: NOW };
const SPEC: SelectionSpec = {
  chain: 'solana',
  minRoughPeakUsd: 30_000,
  includeNoPrice: false,
  order: 'peak',
};

describeDb('seeding for a backfill', () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase(adminUrl!);
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await t.db.deleteFrom('coins').execute();
  });

  const snapshot = async () =>
    (
      await sql<Record<string, unknown>>`
        select c.*, (select coalesce(jsonb_agg(to_jsonb(s) order by s.stage), '[]') from coin_stages s where s.coin_id = c.id) as stages
        from coins c order by c.id`.execute(t.db)
    ).rows;

  it('inserts coins with the discovered stage done, and loading the same rows again changes no row', async () => {
    const rows = [row(1, 100_000), row(2, null), row(3, 5_000, { creatorWallet: 'W'.repeat(44) })];
    const first = await seedBackfillChunk(t.db, rows, opts);
    expect(first).toMatchObject({
      total: 3,
      inserted: 3,
      updated: 0,
      unchanged: 0,
      stagesMarked: 3,
    });
    const before = await snapshot();
    const second = await seedBackfillChunk(t.db, rows, { ...opts, now: LATER });
    expect(second).toMatchObject({ inserted: 0, updated: 0, unchanged: 3, stagesMarked: 0 });
    expect(await snapshot()).toEqual(before);
    const stages = await t.db.selectFrom('coin_stages').selectAll().execute();
    expect(stages.map((s) => [s.stage, s.status])).toEqual([
      ['discovered', 'done'],
      ['discovered', 'done'],
      ['discovered', 'done'],
    ]);
  });

  it('never overwrites what a stage wrote, fills only empty fields, updates the rough ATH, and leaves stage rows alone', async () => {
    await seedBackfillChunk(t.db, [row(1, 100_000, { launchpad: null })], opts);
    const { id } = await t.db
      .selectFrom('coins')
      .select('id')
      .where('address', '=', addr(1))
      .executeTakeFirstOrThrow();
    await t.db
      .updateTable('coins')
      .set({ ticker: 'KEEP', name: 'Kept', ath_market_cap_usd: 123_456, status: 'alive' })
      .where('id', '=', id)
      .execute();
    const c = await claimStage(t.db, {
      coinId: id,
      stage: 'candles',
      now: NOW,
      staleAfterMs: 1000,
    });
    expect(c.status).toBe('claimed');
    await finishStage(t.db, {
      coinId: id,
      stage: 'candles',
      attempt: 1,
      outcome: { status: 'done', detail: { path: 'screen' } },
      now: NOW,
    });
    const stagesBefore = await t.db
      .selectFrom('coin_stages')
      .selectAll()
      .orderBy('stage')
      .execute();

    const r = await seedBackfillChunk(
      t.db,
      [
        row(1, 250_000, {
          launchpad: 'other',
          creatorWallet: 'W'.repeat(44),
          launchedAt: new Date('2020-01-01Z'),
        }),
      ],
      { ...opts, discoverySource: 'second-file', now: LATER },
    );
    expect(r).toMatchObject({ inserted: 0, updated: 1, stagesMarked: 0 });
    const after = await t.db
      .selectFrom('coins')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(after).toMatchObject({
      ticker: 'KEEP',
      name: 'Kept',
      ath_market_cap_usd: 123_456,
      status: 'alive',
      rough_ath_market_cap_usd: 250_000, // the file's number replaces the old one
      launchpad: 'other', // was empty: filled
      creator_wallet: 'W'.repeat(44), // was empty: filled
      discovery_source: 'test-file', // kept
    });
    expect(after.launched_at).toEqual(new Date('2025-01-01T00:00:00Z')); // kept
    expect(await t.db.selectFrom('coin_stages').selectAll().orderBy('stage').execute()).toEqual(
      stagesBefore,
    );
  });

  it('does not null out a rough ATH when the file has none', async () => {
    await seedBackfillChunk(t.db, [row(1, 90_000)], opts);
    await seedBackfillChunk(t.db, [row(1, null)], { ...opts, now: LATER });
    const c = await t.db
      .selectFrom('coins')
      .select('rough_ath_market_cap_usd')
      .executeTakeFirstOrThrow();
    expect(c.rough_ath_market_cap_usd).toBe(90_000);
  });

  it('stores hash_order as the first 52 bits of the md5 of the address', async () => {
    await seedBackfillChunk(t.db, [row(7, 50_000)], opts);
    const c = await t.db.selectFrom('coins').select('hash_order').executeTakeFirstOrThrow();
    const hex = createHash('md5').update(addr(7)).digest('hex').slice(0, 13);
    expect(c.hash_order).toBe(Number(BigInt(`0x${hex}`)));
    expect(Number.isSafeInteger(c.hash_order)).toBe(true);
  });
});

describeDb('selection', () => {
  let t: TestDatabase;
  const N = 400;
  /** Rough peaks with many ties, and a few with no price. */
  const rough = (i: number): number | null => (i % 37 === 0 ? null : 10_000 + (i % 25) * 4_000);
  beforeAll(async () => {
    t = await createTestDatabase(adminUrl!);
    const rows = Array.from({ length: N }, (_, i) => row(i + 1, rough(i + 1)));
    for (let i = 0; i < rows.length; i += 150) {
      await seedBackfillChunk(t.db, rows.slice(i, i + 150), opts);
    }
  });
  afterAll(async () => {
    await t.drop();
  });

  async function walk(sel: ResolvedSelection, size: number): Promise<number[]> {
    const ids: number[] = [];
    let cursor = null;
    for (;;) {
      const page = await selectionPage(t.db, sel, cursor, size);
      if (page.length === 0) return ids;
      ids.push(...page.map((p) => p.id));
      cursor = keyOf(page[page.length - 1]!);
    }
  }
  const expectedCount = (floor: number, noPrice: boolean) =>
    Array.from({ length: N }, (_, i) => rough(i + 1)).filter((r) =>
      r === null ? noPrice : r >= floor,
    ).length;

  it.each(['peak', 'hash'] as const)(
    'pages through the whole selection exactly once in %s order, whatever the page size',
    async (order) => {
      for (const includeNoPrice of [false, true]) {
        const sel = await resolveSelection(t.db, { ...SPEC, order, includeNoPrice });
        expect(sel.size).toBe(expectedCount(30_000, includeNoPrice));
        const a = await walk(sel, 7);
        const b = await walk(sel, 1000);
        expect(a).toHaveLength(sel.size);
        expect(new Set(a).size).toBe(a.length);
        expect(a).toEqual(b);
      }
    },
  );

  it('orders by rough peak, largest first, with coins with no price last when included', async () => {
    const sel = await resolveSelection(t.db, { ...SPEC, includeNoPrice: true });
    const page = await selectionPage(t.db, sel, null, 1000);
    const peaks = page.map((p) => p.rough);
    const priced = peaks.filter((p): p is number => p !== null);
    expect(priced).toEqual([...priced].sort((x, y) => y - x));
    expect(peaks.slice(priced.length).every((p) => p === null)).toBe(true);
    expect(peaks.at(-1)).toBeNull();
    // Without the option, a coin with no price is not selected.
    const plain = await resolveSelection(t.db, SPEC);
    expect((await selectionPage(t.db, plain, null, 1000)).some((p) => p.rough === null)).toBe(
      false,
    );
  });

  it.each(['peak', 'hash'] as const)(
    'a limit is the first N coins of the order, the same on every call (%s)',
    async (order) => {
      const full = await walk(await resolveSelection(t.db, { ...SPEC, order }), 50);
      const lim = await resolveSelection(t.db, { ...SPEC, order, limit: 60 });
      expect(lim.size).toBe(60);
      expect(await walk(lim, 13)).toEqual(full.slice(0, 60));
      const again = await resolveSelection(t.db, { ...SPEC, order, limit: 60 });
      expect(await walk(again, 60)).toEqual(full.slice(0, 60));
      // A limit larger than the selection is the whole selection.
      const big = await resolveSelection(t.db, { ...SPEC, order, limit: 100_000 });
      expect(big.size).toBe(full.length);
    },
  );

  it('counts the selection by rough-peak cell', async () => {
    const sel = await resolveSelection(t.db, { ...SPEC, minRoughPeakUsd: 0, includeNoPrice: true });
    const c = await countByRoughPeak(t.db, sel, [30_000, 50_000, 100_000], {
      stage: 'candles',
      version: 1,
    });
    expect(c.counts.reduce((a, b) => a + b, 0) + c.noPrice).toBe(N);
    expect(c.noPrice).toBe(
      Array.from({ length: N }, (_, i) => rough(i + 1)).filter((r) => r === null).length,
    );
    expect(c.done.every((d) => d === 0)).toBe(true);
  });
});

describeDb('stage breakdown for a backfill', () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase(adminUrl!);
  });
  afterAll(async () => {
    await t.drop();
  });

  async function finish(address: string, stage: 'candles' | 'metrics' | 'metadata', ath?: number) {
    const { id } = await t.db
      .selectFrom('coins')
      .select('id')
      .where('address', '=', address)
      .executeTakeFirstOrThrow();
    await claimStage(t.db, { coinId: id, stage, now: NOW, staleAfterMs: 1000 });
    if (ath !== undefined) {
      await t.db
        .updateTable('coins')
        .set({ ath_market_cap_usd: ath })
        .where('id', '=', id)
        .execute();
    }
    await finishStage(t.db, {
      coinId: id,
      stage,
      attempt: 1,
      outcome: { status: 'done' },
      now: NOW,
    });
  }

  it('does not count an unlisted coin as waiting for metadata', async () => {
    await seedBackfillChunk(
      t.db,
      [row(1, 80_000), row(2, 80_000), row(3, 80_000), row(4, 80_000)],
      opts,
    );
    const sel = await resolveSelection(t.db, SPEC);
    const stages = (since: Date) => [
      {
        stage: 'candles',
        version: 1,
        requires: 'discovered',
        minAthMarketCapUsd: null,
        runningSince: since,
      },
      {
        stage: 'metrics',
        version: 1,
        requires: 'candles',
        minAthMarketCapUsd: null,
        runningSince: since,
      },
      {
        stage: 'metadata',
        version: 1,
        requires: 'metrics',
        minAthMarketCapUsd: 100_000,
        runningSince: since,
      },
    ];
    const since = new Date(NOW.getTime() - 60_000);
    // Coin 1: metrics done, listed. Coin 2: metrics done, ATH $60,000, not listed. Coin 3: candles only.
    for (const a of [addr(1), addr(2)]) {
      await finish(a, 'candles');
    }
    await finish(addr(1), 'metrics', 400_000);
    await finish(addr(2), 'metrics', 60_000);
    await finish(addr(3), 'candles');
    const b = Object.fromEntries(
      (await stageBreakdown(t.db, sel, stages(since))).map((x) => [x.stage, x]),
    );
    expect(b['candles']).toMatchObject({ done: 3, waiting: 1 });
    expect(b['metrics']).toMatchObject({ done: 2, waiting: 2 });
    // Metadata: coin 1 waits; coins 3 and 4 have no metrics yet, so whether they are listed is unknown (waiting);
    // coin 2 is known to be unlisted and is not waiting for anything.
    expect(b['metadata']).toMatchObject({ done: 0, waiting: 3, notApplicable: 1 });
    expect(await countListed(t.db, sel, 100_000)).toBe(1);
  });
});

describeDb('provider usage history and the read-only connection', () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase(adminUrl!);
  });
  afterAll(async () => {
    await t.drop();
  });

  it('reports usage in total and over the last hour', async () => {
    const run = await createRun(t.db, { kind: 'backfill' });
    const at = (min: number) => new Date(NOW.getTime() + min * 60_000);
    await recordUsage(t.db, run, { provider: 'codex', requests: 1000, units: 4000 }, at(90));
    for (const [m, req] of [
      [0, 100],
      [30, 400],
      [70, 800],
      [90, 1000],
    ] as const) {
      await recordUsageSample(
        t.db,
        run,
        { provider: 'codex', requests: req, units: req * 4 },
        at(m),
      );
    }
    const w = await usageWindow(t.db, at(90));
    expect(w).toEqual([
      {
        provider: 'codex',
        requests: 1000,
        units: 4000,
        lastHourRequests: 600,
        lastHourUnits: 2400,
      },
    ]);
  });

  it('refuses every write on a read-only connection', async () => {
    const ro = createReadOnlyDb(t.url);
    try {
      expect(
        (await sql<{ n: string }>`select count(*)::text as n from coins`.execute(ro)).rows,
      ).toHaveLength(1);
      await expect(
        ro.insertInto('coins').values({ chain: 'solana', address: 'X' }).execute(),
      ).rejects.toThrow(/read-only/);
      await expect(sql`create table nope (a int)`.execute(ro)).rejects.toThrow(/read-only/);
      const mode = await sql<{
        v: string;
      }>`select current_setting('default_transaction_read_only') as v`.execute(ro);
      expect(mode.rows[0]!.v).toBe('on');
    } finally {
      await ro.destroy();
    }
  });
});
