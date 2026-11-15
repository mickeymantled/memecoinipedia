import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { ExtrasProvider } from '../src/classify/db-store.js';
import { evaluateParentPairs, formatEval, parsePairsCsv } from '../src/classify/parent-eval.js';
import {
  MAX_CONSIDERED,
  ParentIndex,
  combineExtras,
  createParentCandidateProvider,
} from '../src/classify/parent-index.js';
import {
  plantedSet,
  syntheticListedCoins,
  type SyntheticCoin,
} from '../src/classify/parent-synthetic.js';
import { createTestDb, describeDb, type TestDb } from './helpers.js';

const planted = plantedSet();
const byAddress = new Map(planted.coins.map((c) => [c.address, c]));
const tops = (idx: ParentIndex, address: string) =>
  idx.candidatesFor(byAddress.get(address)!).map((c) => c.address);

describe('ParentIndex on planted families', () => {
  const idx = new ParentIndex(planted.coins);

  it('puts the true parent in the top 3 for every planted child', () => {
    for (const [child, parent] of planted.parentOf) {
      const list = tops(idx, child);
      expect(list.slice(0, 3), `${child} -> ${parent}, got ${list.join(',')}`).toContain(parent);
    }
    // Most are in fact first.
    const first = [...planted.parentOf].filter(([c, p]) => tops(idx, c)[0] === p).length;
    expect(first).toBe(planted.parentOf.size);
  });

  it('gives unrelated coins an empty list', () => {
    for (const u of planted.unrelated) expect(tops(idx, u)).toEqual([]);
  });

  it('stop-list words alone produce no candidate', () => {
    for (const c of planted.stopWordOnly) expect(tops(idx, c)).toEqual([]);
  });

  it('never offers a later, unlisted, launch-less or the same coin', () => {
    for (const { child, decoy } of [...planted.later, ...planted.unlisted])
      expect(tops(idx, child)).not.toContain(decoy);
    expect(tops(idx, 'C_ZORBCASH')).not.toContain('E_NOLAUNCH');
    for (const c of planted.coins) expect(tops(idx, c.address)).not.toContain(c.address);
    // A coin with no launch time gets nothing.
    expect(tops(idx, 'E_NOLAUNCH')).toEqual([]);
    // Strictly earlier: equal launch time is not earlier.
    const a = { ...byAddress.get('P_PNUT')!, address: 'T1', ticker: 'TWINPNUT', name: 'x' };
    const same = new ParentIndex([...planted.coins, a]);
    expect(
      same
        .candidatesFor({
          ...a,
          address: 'T2',
          launched_at: byAddress.get('P_PNUT')!.launched_at,
          description: null,
        })
        .map((c) => c.address),
    ).not.toContain('P_PNUT');
  });

  it('is deterministic whatever the input order', () => {
    const shuffled = [...planted.coins].reverse();
    const other = new ParentIndex(shuffled);
    for (const c of planted.coins) expect(tops(other, c.address)).toEqual(tops(idx, c.address));
  });

  it('fills the candidate fields and caps the list at 10', () => {
    const many: SyntheticCoin[] = Array.from({ length: 40 }, (_, i) => ({
      address: `M${i}`,
      ticker: `ZORBO${String(i).padStart(2, '0')}`,
      name: `m${i}`,
      description: null,
      launched_at: Date.UTC(2025, 0, 1 + i),
      ath_market_cap_usd: 200_000 + i,
      ath_at: Date.UTC(2025, 0, 1 + i, 1),
    }));
    const big = new ParentIndex(many);
    const child = {
      ...many[0]!,
      address: 'KID',
      name: 'kid',
      ticker: 'ZORBO',
      launched_at: Date.UTC(2026, 0, 1),
    };
    const list = big.candidatesFor(child);
    expect(list).toHaveLength(10);
    expect(list[0]).toMatchObject({ address: expect.any(String), ticker: expect.any(String) });
    expect(list.map((c) => c.ath_market_cap_usd)).toEqual(
      [...list.map((c) => c.ath_market_cap_usd!)].sort((a, b) => b - a),
    );
  });
});

describe('ranking by size, one place per parent (#91)', () => {
  const DAY = 86_400_000;
  const D = (day: number) => Date.UTC(2025, 0, 1) + day * DAY;
  const mk = (
    address: string,
    ticker: string,
    name: string,
    over: Partial<SyntheticCoin> = {},
  ): SyntheticCoin => ({
    address,
    ticker,
    name,
    description: null,
    launched_at: D(0),
    ath_market_cap_usd: 1_000_000,
    ath_at: D(1),
    ...over,
  });

  it('a parent that peaks after the child launches beats copies that peaked before', () => {
    const coins = [
      // The real parent: launched 17 days before the child, peaks 3 days after it.
      mk('REAL', 'ANSEM', 'Ansem', {
        launched_at: D(0),
        ath_market_cap_usd: 439_000_000,
        ath_at: D(20),
      }),
      // Eight smaller copies that all peaked before the child launched, one named exactly alike.
      ...Array.from({ length: 8 }, (_, i) =>
        mk(`COPY${i}`, 'ANSEM', i === 0 ? 'Ansem' : `ansem ${i}`, {
          ath_market_cap_usd: 1_400_000 + i * 600_000,
          ath_at: D(2),
        }),
      ),
      // Other, different possible parents the freed places can go to.
      mk('OTHER1', 'BABYAN', 'zz1', { ath_market_cap_usd: 300_000 }),
      mk('OTHER2', 'ANSE', 'zz2', { ath_market_cap_usd: 200_000 }),
    ];
    const kid = mk('KID', 'BABYANSEM', 'The Black Calf', { launched_at: D(17) });
    const list = new ParentIndex(coins).candidatesFor(kid).map((c) => c.address);
    expect(list[0]).toBe('REAL');
    // Eight copies are one place, and the places they would have taken go to others.
    expect(list.filter((a) => a.startsWith('COPY') || a === 'REAL')).toEqual(['REAL']);
    expect(list).toEqual(expect.arrayContaining(['OTHER1', 'OTHER2']));
  });

  it('coins with the same name (different tickers) are one place, the larger kept', () => {
    const coins = [
      mk('BIG', 'GOATSEUS', 'Goatseus Maximus', { ath_market_cap_usd: 1_358_000_000 }),
      mk('SMALL', 'GOATSEUSM', 'Goatseus Maximus', { ath_market_cap_usd: 770_000 }),
      mk('TINY', 'GOATSXX', 'Goatseus Maximus', { ath_market_cap_usd: 110_000 }),
    ];
    const kid = mk('KID', 'BABYGOATSEUS', 'Baby Goatseus Maximus', { launched_at: D(30) });
    expect(new ParentIndex(coins).candidatesFor(kid).map((c) => c.address)).toEqual(['BIG']);
  });

  it('a real second coin with the same ticker is not lost when it is the larger one', () => {
    const coins = [
      mk('OLDSMALL', 'ZAPP', 'Zapp old', { ath_market_cap_usd: 200_000 }),
      mk('NEWBIG', 'ZAPP', 'Zapp new', { launched_at: D(5), ath_market_cap_usd: 90_000_000 }),
    ];
    const kid = mk('KID', 'BABYZAPP', 'Baby Zapp', { launched_at: D(10) });
    expect(new ParentIndex(coins).candidatesFor(kid).map((c) => c.address)).toEqual(['NEWBIG']);
  });

  it('size is the backed high where it is filled, else the stored ATH', () => {
    // Same evidence for all (same length, each inside the child's ticker).
    const coins = [
      mk('SPIKE', 'ZIGZAG', 'sp1', {
        ath_market_cap_usd: 14_500_000,
        ath_backed_market_cap_usd: 800_000,
      }),
      mk('REALONE', 'IGZAGM', 'rl2', {
        ath_market_cap_usd: 3_000_000,
        ath_backed_market_cap_usd: 2_000_000,
      }),
      mk('NOBACK', 'GZAGMA', 'nb3', { ath_market_cap_usd: 1_000_000 }),
    ];
    const kid = mk('KID', 'ZIGZAGMAX', 'child', { launched_at: D(9) });
    const list = new ParentIndex(coins).candidatesFor(kid);
    expect(list.map((c) => c.address)).toEqual(['REALONE', 'NOBACK', 'SPIKE']);
    // The reported size is the one ranked on.
    expect(list[2]!.ath_market_cap_usd).toBe(800_000);
    // A coin is still listed by its stored ATH: stored under $100k stays out, backed or not.
    const unlisted = mk('LOW', 'ZIGZAGM', 'lw', {
      ath_market_cap_usd: 50_000,
      ath_backed_market_cap_usd: 5_000_000,
    });
    expect(new ParentIndex([unlisted]).candidatesFor(kid)).toEqual([]);
  });

  it('"Moo Tun": the real parent is not crowded out by BROTHER and MOO copies', () => {
    const coins = [
      mk('REAL', 'MOODENG', 'Moo Deng', { ath_market_cap_usd: 600_000_000, ath_at: D(40) }),
      ...Array.from({ length: 4 }, (_, i) =>
        mk(`BRO${i}`, 'BROTHER', `bro ${i}`, { ath_market_cap_usd: 2_000_000 + i }),
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        mk(`MOO${i}`, 'MOO', `moo ${i}`, { ath_market_cap_usd: 3_000_000 + i }),
      ),
    ];
    const kid = mk('KID', 'MOOTUN', 'Moo Tun', {
      launched_at: D(30),
      description: 'The beloved brother of Moodeng',
    });
    const list = new ParentIndex(coins).candidatesFor(kid).map((c) => c.address);
    // Returned (the evidence weights are unchanged: a MOO ticker inside MOOTUN still scores higher).
    expect(list).toContain('REAL');
    expect(list.filter((a) => a.startsWith('BRO'))).toHaveLength(1);
    expect(list.filter((a) => a.startsWith('MOO'))).toHaveLength(1);
  });

  it('"Moo Tun" with another ticker: the description writes the two-word name as one word', () => {
    const coins = [mk('REAL', 'MD', 'Moo Deng', { ath_market_cap_usd: 600_000_000 })];
    const kid = mk('KID', 'QQQQ', 'Qqqq', {
      launched_at: D(30),
      description: 'The beloved brother of Moodeng',
    });
    expect(new ParentIndex(coins).candidatesFor(kid).map((c) => c.address)).toEqual(['REAL']);
  });
});

const coinAt = (
  address: string,
  ticker: string,
  name: string,
  ath: number,
  day = 1,
): SyntheticCoin => ({
  address,
  ticker,
  name,
  description: null,
  launched_at: Date.UTC(2025, 0, day),
  ath_market_cap_usd: ath,
  ath_at: null,
});
const later = (over: Partial<SyntheticCoin>): SyntheticCoin => ({
  ...coinAt('KID', 'X', 'x', 1, 200),
  ...over,
});

describe('evidence kinds are kept apart', () => {
  it('a common word in the description cannot push out a ticker containment', () => {
    const coins = [
      ...Array.from({ length: 600 }, (_, i) =>
        coinAt(`T${i}`, 'TRUMP', `trump ${i}`, 5_000_000 + i),
      ),
      coinAt('PNUT', 'PNUT', 'Peanut the Squirrel', 300_000),
    ];
    const kid = later({
      ticker: 'BABYPNUT',
      name: 'Baby Peanut',
      description: 'the next trump of squirrels',
    });
    const list = new ParentIndex(coins).candidatesFor(kid);
    expect(list[0]!.address).toBe('PNUT');
    // Without the description it is still first.
    expect(new ParentIndex(coins).candidatesFor({ ...kid, description: null })[0]!.address).toBe(
      'PNUT',
    );
  });

  it('one kind of evidence cannot take all ten places', () => {
    const frags = [
      'ELE',
      'LEP',
      'EPH',
      'PHA',
      'HAN',
      'ANT',
      'ELEP',
      'PHAN',
      'HANT',
      'LEPH',
      'EPHA',
      'PHANT',
    ];
    const coins = [
      ...frags.map((f, i) => coinAt(`F${i}`, f, `frag${i}x`, 200_000 + i)),
      coinAt('PNUT', 'PNUT', 'Peanut', 50_000_000),
    ];
    const list = new ParentIndex(coins).candidatesFor(
      later({ ticker: 'ELEPHANT', name: 'Peanut Elephant' }),
    );
    expect(list).toHaveLength(10);
    expect(list.map((c) => c.address)).toContain('PNUT');
    expect(list.filter((c) => c.address.startsWith('F')).length).toBeLessThanOrEqual(9);
  });

  it('returns the reserved picks in ranking order', () => {
    const coins = [
      ...Array.from({ length: 12 }, (_, i) =>
        coinAt(`F${i}`, `ZQX${'AB'[i % 2]}${i}`, `f${i}`, 200_000 + i),
      ),
      coinAt('W', 'WORDY', 'Wordy', 100_000),
    ];
    const list = new ParentIndex(coins).candidatesFor(
      later({ ticker: 'ZQX', name: 'the real Wordy' }),
    );
    expect(list.map((c) => c.address)).toContain('W');
  });
});

describe('common-string cap', () => {
  it('cuts thousands of matches to the largest by ATH before scoring', () => {
    const n = MAX_CONSIDERED * 4;
    const coins: SyntheticCoin[] = Array.from({ length: n }, (_, i) => ({
      address: `X${i}`,
      ticker: `QWERTYUIOP${i}`,
      name: `n${i}`,
      description: null,
      launched_at: Date.UTC(2025, 0, 1),
      ath_market_cap_usd: 100_000 + i,
      ath_at: null,
    }));
    const idx = new ParentIndex(coins);
    const kid: SyntheticCoin = {
      address: 'KID',
      ticker: 'QWERTYUIOP',
      name: 'zz',
      description: null,
      launched_at: Date.UTC(2025, 6, 1),
      ath_market_cap_usd: null,
      ath_at: null,
    };
    const list = idx.candidatesFor(kid);
    // Everything matches equally; the survivors are the biggest ATHs.
    expect(list).toHaveLength(10);
    expect(list.every((c) => c.ath_market_cap_usd! >= 100_000 + n - 10)).toBe(true);
  });
});

describe('150,000 listed coins (in memory)', () => {
  it('builds the index and answers 1,000 coins within the issue limits', () => {
    const coins = syntheticListedCoins(150_000, 7);
    const t0 = performance.now();
    const idx = new ParentIndex(coins);
    const build = performance.now() - t0;
    const kids = syntheticListedCoins(1_000, 99).map((c, i) => ({
      ...c,
      address: `KID${i}`,
      launched_at: c.launched_at! + 200 * 86_400_000,
    }));
    const t1 = performance.now();
    let found = 0;
    for (const k of kids) found += idx.candidatesFor(k).length > 0 ? 1 : 0;
    const query = performance.now() - t1;
    process.stdout.write(
      `parent index in memory: ${idx.size} coins, build ${build.toFixed(0)} ms, 1000 coins ${query.toFixed(0)} ms, ${found} with candidates\n`,
    );
    expect(idx.size).toBe(150_000);
    // Loose by default: CI catches a blow-up and nothing else. The issue's limits (10 s, 2 s)
    // are asserted under PARENT_PERF=1.
    const strict = process.env['PARENT_PERF'] === '1';
    expect(build).toBeLessThan(strict ? 10_000 : 30_000);
    expect(query).toBeLessThan(strict ? 2_000 : 10_000);
  }, 120_000);
});

// ---- Database ----------------------------------------------------------------------------------

async function insert(t: TestDb, coins: SyntheticCoin[], chain = 'solana'): Promise<void> {
  for (let i = 0; i < coins.length; i += 2000) {
    await t.db
      .insertInto('coins')
      .values(
        coins.slice(i, i + 2000).map((c) => ({
          chain,
          address: c.address,
          ticker: c.ticker,
          name: c.name,
          description: c.description,
          launched_at: c.launched_at === null ? null : new Date(c.launched_at),
          ath_market_cap_usd: c.ath_market_cap_usd,
          ath_at: c.ath_at === null ? null : new Date(c.ath_at),
          ath_backed_market_cap_usd: c.ath_backed_market_cap_usd ?? null,
        })),
      )
      .execute();
  }
}

const ids = async (t: TestDb, addresses: string[]) =>
  (
    await t.db
      .selectFrom('coins')
      .select(['id', 'chain', 'address'])
      .where('address', 'in', addresses)
      .execute()
  ).sort((a, b) => a.id - b.id);

describeDb('provider and evaluation on a throwaway database', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
    await insert(t, planted.coins);
    // Same text on another chain: must never cross chains.
    await insert(t, [{ ...byAddress.get('P_PNUT')!, address: 'OTHER_PNUT' }], 'base');
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  });

  it('fills parent_candidates only, for every row, and matches the in-memory index', async () => {
    const provider = createParentCandidateProvider(t.db);
    const rows = await ids(
      t,
      planted.coins.map((c) => c.address),
    );
    const out = await provider(rows);
    expect(out.size).toBe(rows.length);
    for (const v of out.values()) expect(Object.keys(v)).toEqual(['parent_candidates']);
    const idx = new ParentIndex(planted.coins);
    for (const r of rows.filter((r) => r.chain === 'solana')) {
      expect(out.get(r.id)!.parent_candidates!.map((c) => c.address)).toEqual(tops(idx, r.address));
    }
    const kid = rows.find((r) => r.address === 'C_BABYPNUT')!;
    expect(out.get(kid.id)!.parent_candidates![0]).toMatchObject({
      address: 'P_PNUT',
      ticker: 'PNUT',
      name: 'Peanut the Squirrel',
    });
    const other = await ids(t, ['OTHER_PNUT']);
    expect(out.get(other[0]!.id)?.parent_candidates ?? []).toEqual([]);
  });

  it('ranks by the backed high from the database column, else the stored ATH', async () => {
    const base = { description: null, launched_at: Date.UTC(2025, 5, 1), ath_at: null };
    await insert(t, [
      {
        ...base,
        address: 'BK_SPIKE',
        ticker: 'QZIGZAG',
        name: 'bk1',
        ath_market_cap_usd: 14_500_000,
        ath_backed_market_cap_usd: 800_000,
      },
      {
        ...base,
        address: 'BK_REAL',
        ticker: 'ZIGZAGQ',
        name: 'bk2',
        ath_market_cap_usd: 3_000_000,
        ath_backed_market_cap_usd: 2_000_000,
      },
      {
        ...base,
        address: 'BK_KID',
        ticker: 'QZIGZAGQ',
        name: 'bk kid',
        launched_at: Date.UTC(2025, 6, 1),
        ath_market_cap_usd: 1_000,
        ath_backed_market_cap_usd: null,
      },
    ]);
    const rows = await ids(t, ['BK_KID']);
    const out = await createParentCandidateProvider(t.db)(rows);
    expect(out.get(rows[0]!.id)!.parent_candidates!.map((c) => c.address)).toEqual([
      'BK_REAL',
      'BK_SPIKE',
    ]);
  });

  it('is deterministic across providers and across calls', async () => {
    const rows = await ids(
      t,
      planted.coins.map((c) => c.address),
    );
    const a = await createParentCandidateProvider(t.db)(rows);
    const p = createParentCandidateProvider(t.db);
    const b = await p(rows);
    const c = await p([...rows].reverse());
    expect([...b]).toEqual([...a]);
    for (const [id, v] of a) expect(c.get(id)).toEqual(v);
  });

  it('loads its index once and keeps it for the life of the provider', async () => {
    const p = createParentCandidateProvider(t.db);
    const rows = await ids(t, ['C_BABYPNUT']);
    const first = await p(rows);
    // A listed coin added after the first use is not seen: the index is not reloaded.
    await insert(t, [
      {
        ...byAddress.get('P_PNUT')!,
        address: 'P_PNUT_LATE',
        ticker: 'BABYPNUTX',
        launched_at: Date.UTC(2025, 1, 1),
      },
    ]);
    const second = await p(rows);
    expect(second.get(rows[0]!.id)).toEqual(first.get(rows[0]!.id));
    await sql`delete from coins where address = 'P_PNUT_LATE'`.execute(t.db);
  });

  it('composes with a provider that fills research', async () => {
    const research: ExtrasProvider = (rows) =>
      Promise.resolve(new Map(rows.map((r) => [r.id, { research: { origin: `o${r.id}` } }])));
    const rows = await ids(t, ['C_BABYPNUT', 'U1']);
    const both = await combineExtras(createParentCandidateProvider(t.db), research)(rows);
    const kid = both.get(rows.find((r) => r.address === 'C_BABYPNUT')!.id)!;
    expect(kid.parent_candidates![0]!.address).toBe('P_PNUT');
    expect(kid.research).toEqual({
      origin: `o${rows.find((r) => r.address === 'C_BABYPNUT')!.id}`,
    });
    // Order does not matter, and an ids-only side still merges.
    const flipped = await combineExtras(research, createParentCandidateProvider(t.db))(rows);
    expect(flipped.get(rows[0]!.id)).toEqual(both.get(rows[0]!.id));
  });

  it('evaluation prints ranks and recall, and writes nothing', async () => {
    const before = await sql<{ n: string }>`select count(*)::text as n from coins`.execute(t.db);
    const pairs = parsePairsCsv(
      [
        'child_address,parent_address',
        'C_BABYPNUT,P_PNUT',
        'C_SONOFBONK,P_BONK',
        'C_BABYDOG,P_DOG', // a stop-word-only link: missing
        'NOT_A_COIN,P_BONK',
        '# comment',
      ].join('\n'),
    );
    const s = await evaluateParentPairs(t.db, pairs);
    expect(s.results.map((r) => r.rank)).toEqual([1, 1, null, null]);
    expect(s.evaluated).toBe(3);
    expect(s.recall[1]).toBeCloseTo(2 / 3);
    expect(s.recall[10]).toBeCloseTo(2 / 3);
    const text = formatEval(s);
    expect(text).toContain('C_BABYDOG -> P_DOG: missing');
    expect(text).toContain('NOT_A_COIN -> P_BONK: child not found');
    expect(text).toContain('recall@1: 66.7%');
    const after = await sql<{ n: string }>`select count(*)::text as n from coins`.execute(t.db);
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it('the evaluation script runs against the database', async () => {
    const run = promisify(execFile);
    const dir = mkdtempSync(join(tmpdir(), 'parent-eval-'));
    try {
      const file = join(dir, 'pairs.csv');
      writeFileSync(file, 'C_BABYPNUT,P_PNUT\nC_GIGACHAD2,P_GIGACHAD\nC_BABYDOG,P_DOG\n');
      const script = fileURLToPath(
        new URL('../scripts/parent-candidates-eval.ts', import.meta.url),
      );
      const tsx = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url));
      const r = await run(tsx, [script, '--pairs', file], {
        env: {
          PATH: process.env['PATH'] ?? '',
          USER: process.env['USER'] ?? '',
          DATABASE_URL: t.url,
        },
        timeout: 60_000,
      });
      expect(r.stdout).toContain('C_BABYPNUT -> P_PNUT: rank 1');
      expect(r.stdout).toContain('C_BABYDOG -> P_DOG: missing');
      expect(r.stdout).toContain('recall@3: 66.7%');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

/** Slow: set PARENT_PERF=1 to run it (it inserts 150,000 rows into a throwaway database). */
const describePerf = process.env['PARENT_PERF'] === '1' ? describeDb : describe.skip;
describePerf('150,000 coins through the database', () => {
  it('loads and answers within the issue limits', async () => {
    const t = await createTestDb();
    try {
      await insert(t, syntheticListedCoins(150_000, 7));
      const kids = syntheticListedCoins(1_000, 99).map((c, i) => ({
        ...c,
        address: `KID${i}`,
        launched_at: c.launched_at! + 200 * 86_400_000,
      }));
      await insert(
        t,
        kids.map((k) => ({ ...k, ath_market_cap_usd: 1_000 })),
      );
      const rows = await t.db
        .selectFrom('coins')
        .select(['id', 'chain', 'address'])
        .where('address', 'like', 'KID%')
        .execute();
      const heap0 = process.memoryUsage().heapUsed;
      const p = createParentCandidateProvider(t.db);
      const t0 = performance.now();
      await p(rows.slice(0, 1));
      const load = performance.now() - t0;
      global.gc?.();
      const heap = process.memoryUsage().heapUsed - heap0;
      const t1 = performance.now();
      await p(rows);
      const query = performance.now() - t1;
      process.stdout.write(
        `parent index via database: first use (query + build) ${load.toFixed(0)} ms, 1000 coins ${query.toFixed(0)} ms, heap +${(heap / 1048576).toFixed(0)} MB\n`,
      );
      expect(load).toBeLessThan(10_000);
      expect(query).toBeLessThan(2_000);
    } finally {
      await t.drop();
    }
  }, 300_000);
});
