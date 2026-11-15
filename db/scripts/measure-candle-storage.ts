/**
 * Measures candle storage: chunked arrays (candle_chunks) against one row per
 * candle, using real Codex.io bars from a probe results file, then projects the
 * size for 100,000 coins.
 *
 *   TEST_DATABASE_ADMIN_URL=postgres://localhost:5432/postgres \
 *     pnpm --filter @memecoinipedia/db measure-storage <probe-results.json>
 *
 * Only creates and drops databases named mcp_test_*. Reads the probe file; never copies it.
 */
import { readFile } from 'node:fs/promises';
import { sql, type Kysely } from 'kysely';
import { putBars, type CandleBar, type Resolution } from '../src/candles.js';
import { createTestDatabase } from '../src/testing.js';
import type { Database } from '../src/types.js';

const TARGET_COINS = 100_000;

interface RawBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  volume: number;
  tx: number;
  traders: number;
  liq: number | null;
}

interface ProbeCoin {
  mint: string;
  first60?: { barsReturned?: number; firstBarsSample?: RawBar[] };
  daily?: { n?: number };
  athFromDaily?: { highDay?: string };
  athDay1m?: { n?: number };
  tokenDaily?: { firstDay?: string };
}

/** Deterministic PRNG (mulberry32) so runs are repeatable. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function toBar(r: RawBar): CandleBar {
  return {
    t: r.t,
    o: r.o,
    h: r.h,
    l: r.l,
    c: r.c,
    volumeUsd: r.volume,
    trades: r.tx,
    traders: r.traders,
    liquidityUsd: r.liq ?? null,
  };
}

/**
 * `count` consecutive buckets from `start`, built from real bars. The real bars
 * are cycled, with a random-walk price scale and jittered volume and counts so
 * that repetition does not make the data unrealistically easy to compress.
 */
function extend(real: CandleBar[], start: number, res: number, count: number, rand: () => number) {
  const out: CandleBar[] = [];
  let scale = 1;
  for (let i = 0; i < count; i++) {
    const src = real[i % real.length]!;
    scale *= 1 + (rand() - 0.5) * 0.04;
    const jitter = 0.5 + rand();
    out.push({
      t: start + i * res,
      o: src.o * scale,
      h: src.h * scale,
      l: src.l * scale,
      c: src.c * scale,
      volumeUsd: src.volumeUsd * jitter,
      trades: Math.max(1, Math.round(src.trades * jitter)),
      traders: Math.max(1, Math.round(src.traders * jitter)),
      liquidityUsd: src.liquidityUsd === null ? null : src.liquidityUsd * scale,
    });
  }
  return out;
}

interface Layout {
  res: Resolution;
  start: number;
  count: number;
}

interface Scenario {
  name: string;
  layouts: (coin: ProbeCoin, firstT: number) => Layout[];
}

const floorTo = (t: number, res: number) => Math.floor(t / res) * res;
const dayStart = (iso: string | undefined) =>
  iso ? Math.floor(new Date(iso).getTime() / 1000) : undefined;

const scenarios: Scenario[] = [
  {
    name: '(a) 2,880 one-minute + 500 hourly bars per coin, contiguous',
    layouts: (_c, firstT) => [
      { res: 60, start: floorTo(firstT, 60), count: 2880 },
      { res: 3600, start: floorTo(firstT, 3600), count: 500 },
    ],
  },
  {
    name: '(b) bar density seen in the probe (run of 1m bars at launch, the 1m ATH day, daily bars)',
    layouts: (c, firstT) => {
      const l: Layout[] = [];
      const first = c.first60?.barsReturned ?? 0;
      if (first > 0) l.push({ res: 60, start: floorTo(firstT, 60), count: first });
      const athDay = dayStart(c.athFromDaily?.highDay);
      const dayN = c.athDay1m?.n ?? 0;
      if (athDay !== undefined && dayN > 0) l.push({ res: 60, start: athDay, count: dayN });
      const dailyN = c.daily?.n ?? 0;
      const firstDay = dayStart(c.tokenDaily?.firstDay) ?? floorTo(firstT, 86400);
      if (dailyN > 0) l.push({ res: 86400, start: firstDay, count: dailyN });
      return l;
    },
  },
];

async function insertFlat(db: Kysely<Database>, poolId: number, res: number, bars: CandleBar[]) {
  for (let i = 0; i < bars.length; i += 5000) {
    const b = bars.slice(i, i + 5000);
    await sql`
      insert into candles_flat
      select ${poolId}::bigint, ${res}::int, * from unnest(
        ${b.map((x) => x.t)}::bigint[], ${b.map((x) => x.o)}::float8[],
        ${b.map((x) => x.h)}::float8[], ${b.map((x) => x.l)}::float8[],
        ${b.map((x) => x.c)}::float8[], ${b.map((x) => x.volumeUsd)}::float8[],
        ${b.map((x) => x.trades)}::int[], ${b.map((x) => x.traders)}::int[],
        ${b.map((x) => x.liquidityUsd)}::float8[])
      on conflict do nothing`.execute(db);
  }
}

async function size(db: Kysely<Database>, rel: string): Promise<number> {
  const { rows } = await sql<{
    s: string;
  }>`select pg_total_relation_size(${rel}::regclass)::text as s`.execute(db);
  return Number(rows[0]!.s);
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(2)} MB`;
const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`;

async function main() {
  const file = process.argv[2];
  const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
  if (!file || !adminUrl) {
    console.error(
      'usage: TEST_DATABASE_ADMIN_URL=... measure-candle-storage.ts <probe-results.json>',
    );
    process.exit(1);
  }
  const probe = JSON.parse(await readFile(file, 'utf8')) as { results: ProbeCoin[] };
  const coins = probe.results;
  const realBars = coins.flatMap((c) => (c.first60?.firstBarsSample ?? []).map(toBar));
  console.log(`probe coins: ${coins.length}; real bars in the file: ${realBars.length}`);
  console.log(
    'The file holds only a 3-bar sample per coin, so each series is extended by cycling ' +
      'the real bars with shifted timestamps, a random-walk price scale and jittered volume/counts.\n',
  );

  for (const sc of scenarios) {
    const t = await createTestDatabase(adminUrl);
    try {
      await sql`create table candles_flat (
        pool_id bigint not null, resolution_sec int not null, t bigint not null,
        o float8 not null, h float8 not null, l float8 not null, c float8 not null,
        volume_usd float8 not null, trades int not null, traders int not null,
        liquidity_usd float8, primary key (pool_id, resolution_sec, t))`.execute(t.db);
      const rand = rng(42);
      let total = 0;
      const perRes = new Map<number, number>();
      for (const [i, c] of coins.entries()) {
        const sample = c.first60?.firstBarsSample ?? [];
        const firstT = sample[0]?.t ?? 1_730_000_000;
        const coinId = (
          await t.db
            .insertInto('coins')
            .values({ chain: 'solana', address: `m${i}` })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
        const poolId = (
          await t.db
            .insertInto('pools')
            .values({ chain: 'solana', address: `mp${i}`, coin_id: coinId, dex: 'Pump' })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
        // Per-coin source bars: own sample first, then everyone's, so the series is not one repeated triple.
        const source = [...sample.map(toBar), ...realBars];
        for (const l of sc.layouts(c, firstT)) {
          const bars = extend(source, l.start, l.res, l.count, rand);
          await putBars(t.db, poolId, l.res, bars);
          await insertFlat(t.db, poolId, l.res, bars);
          total += bars.length;
          perRes.set(l.res, (perRes.get(l.res) ?? 0) + bars.length);
        }
      }
      await sql`vacuum analyze candle_chunks`.execute(t.db);
      await sql`vacuum analyze candles_flat`.execute(t.db);
      const chunkBytes = await size(t.db, 'candle_chunks');
      const flatBytes = await size(t.db, 'candles_flat');
      const { rows: comp } = await sql<{ c: string | null; n: string }>`
        select pg_column_compression(t)::text as c, count(*)::text as n
        from candle_chunks group by 1 order by 2 desc`.execute(t.db);
      const { rows: chunks } = await sql<{
        n: string;
      }>`select count(*)::text as n from candle_chunks`.execute(t.db);

      const scale = TARGET_COINS / coins.length;
      console.log(`## Scenario ${sc.name}`);
      console.log(
        `bars loaded: ${total} (` +
          [...perRes].map(([r, n]) => `${n} at ${r}s`).join(', ') +
          `); chunk rows: ${chunks[0]!.n}; bars per coin: ${(total / coins.length).toFixed(0)}`,
      );
      console.log(
        `array compression of the t column (pg_column_compression): ` +
          comp.map((r) => `${r.c ?? 'not compressed (inline)'}=${r.n}`).join(', '),
      );
      console.log(
        `candle_chunks (incl. indexes + TOAST): ${mb(chunkBytes)}, ${(chunkBytes / total).toFixed(1)} bytes/bar`,
      );
      console.log(
        `candles_flat  (incl. indexes + TOAST): ${mb(flatBytes)}, ${(flatBytes / total).toFixed(1)} bytes/bar`,
      );
      console.log(
        `projected for ${TARGET_COINS} coins: chunks ${gb(chunkBytes * scale)}, flat ${gb(flatBytes * scale)}; ` +
          `flat/chunks = ${(flatBytes / chunkBytes).toFixed(2)}x\n`,
      );
    } finally {
      await t.drop();
    }
  }
}

await main();
