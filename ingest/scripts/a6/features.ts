/**
 * Computes review features for every coin of the list from the stored bars (offline):
 * the ATH window, the wick bar, what the stored bars hold in the hour Dune names, the
 * hourly-cap / pool facts, and the three weak-point counters of docs/metrics.md section 13.
 *
 *   pnpm -C ingest exec node --import tsx scripts/a6/features.ts --cache DIR \
 *     --list ../ingest/reports/a6-review-list-2026-11-15.csv --dune DUNE.csv --out features.json
 */
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { computeCoinMetrics, mergeParams } from '../../src/metrics/index.js';
import { cleanPools } from '../../src/metrics/clean.js';
import { buildWindows } from '../../src/metrics/windows.js';
import { buildCoinPoints } from '../../src/metrics/points.js';
import type { Bar } from '../../src/metrics/types.js';
import { readDump, readDune, readReviewList, toMetricInput, SUPPLY } from './lib.js';

const peak = (b: Bar): number => Math.max(b.o, b.h, b.l, b.c) * SUPPLY;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      cache: { type: 'string' },
      list: { type: 'string' },
      dune: { type: 'string' },
      out: { type: 'string' },
    },
    strict: true,
  });
  const list = await readReviewList(values.list!);
  const dune = await readDune(values.dune!);
  const out: Record<string, unknown>[] = [];
  for (const row of list) {
    const d = await readDump(values.cache!, row.mint);
    const input = toMetricInput(d);
    const params = mergeParams();
    const res = computeCoinMetrics(input);
    const cleaned = cleanPools(input.pools, input, params);
    const windows = buildWindows(cleaned.pools, params);
    const points = buildCoinPoints(windows);
    const du = dune.get(row.mint)!;
    const duneT = Math.floor(new Date(du.peak_at).getTime() / 1000);

    // ATH window facts.
    let athWin: Record<string, unknown> | null = null;
    if (res.athAt !== null) {
      const w = windows.find((x) => x.t === res.athAt && x.poolAddress === res.athPoolAddress && x.resolution === '1m')!;
      const pool = d.pools.find((p) => p.pool['address'] === res.athPoolAddress)!;
      const bars = pool.bars['60'].filter((b) => b.t >= res.athAt! - 120 && b.t <= res.athAt!);
      athWin = {
        volume: w.volume,
        traders: w.traders,
        nBars: bars.length,
        trades: bars.reduce((s, b) => s + b.trades, 0),
        maxTradesOneMin: Math.max(...bars.map((b) => b.trades)),
        liq: bars[bars.length - 1]?.liquidityUsd ?? null,
        pool: res.athPoolAddress,
        closes: bars.map((b) => Math.round(b.c * SUPPLY)),
        barVols: bars.map((b) => Math.round(b.volumeUsd)),
        barTraders: bars.map((b) => b.traders),
        // Minutes of this pool, anywhere in its stored 1-minute bars, closing at 50% of the ATH or more.
        spike: (() => {
          const hi = pool.bars['60'].filter((b) => b.c >= 0.5 * res.athMarketCapUsd! / SUPPLY);
          return {
            minutes: hi.length,
            volume: Math.round(hi.reduce((s, b) => s + b.volumeUsd, 0)),
            trades: hi.reduce((s, b) => s + b.trades, 0),
            maxTraders: Math.max(0, ...hi.map((b) => b.traders)),
            first: hi[0]?.t ?? null,
            last: hi[hi.length - 1]?.t ?? null,
          };
        })(),
      };
    }
    // Wick bar facts.
    let wickBar: Record<string, unknown> | null = null;
    let wickRes: string | null = null;
    if (res.athWickAt !== null) {
      for (const p of d.pools)
        for (const r of ['60', '3600', '86400'] as const)
          for (const b of p.bars[r])
            if (b.t === res.athWickAt && Math.abs(peak(b) - res.athWickMarketCapUsd!) < 1e-6 * res.athWickMarketCapUsd!) {
              wickRes = r;
              wickBar = {
                res: r,
                pool: p.pool['address'],
                dex: p.pool['dex'],
                high: peak(b),
                close: b.c * SUPPLY,
                vol: b.volumeUsd,
                trades: b.trades,
                traders: b.traders,
                liq: b.liquidityUsd,
              };
            }
    }
    // Stored bars in the Dune peak hour.
    const hourBars: Record<string, unknown>[] = [];
    for (const p of d.pools)
      for (const r of ['60', '3600', '86400'] as const)
        for (const b of p.bars[r]) {
          const len = Number(r);
          if (b.t < duneT + 3600 && b.t + len > duneT)
            hourBars.push({ r, pool: p.pool['address'].slice(0, 6), t: b.t, high: peak(b), vol: b.volumeUsd, trades: b.trades, traders: b.traders });
        }
    const hourMaxHigh = Math.max(0, ...hourBars.map((x) => x['high'] as number));
    const hour1m = hourBars.filter((x) => x['r'] === '60');
    const hour1mMax = Math.max(0, ...hour1m.map((x) => x['high'] as number));
    const hasBarsInHour = hourBars.length > 0;
    // Highest bar close in the whole stored set (any pool, 1m): an easy check of price ladder.
    const stage = d.stages.find((s) => s['stage'] === 'candles');

    // Section 13 counters.
    // (a) a non-strict point lowering the level by more than half.
    let level: number | undefined;
    let lowerings = 0;
    const lowerAt: number[] = [];
    for (const p of points) {
      if (p.strict) level = p.price;
      else if (level !== undefined && p.price < level) {
        if (p.price < level / 2) {
          lowerings++;
          lowerAt.push(p.t);
        }
        level = p.price;
      }
    }
    // (b) a strict window that is higher than the ATH price was hidden by a busier non-strict window.
    const athPrice = res.athMarketCapUsd === null ? 0 : res.athMarketCapUsd / SUPPLY;
    const hidden = windows.filter((w) => w.strict && w.resolution === '1m' && w.price > athPrice);
    const hiddenAtPeak = hidden.filter((w) => {
      const pt = points.find((p) => p.t === w.t);
      return pt !== undefined && !(pt.strict && pt.poolAddress === w.poolAddress);
    });
    // (c) relaxed trader rule.
    const relaxed = (n: number) => computeCoinMetrics(input, { minWindowTraders: n }).athMarketCapUsd;
    const relaxedAth = { t3: relaxed(3), t1: relaxed(1) };
    // Rug facts.
    const noRugRes = computeCoinMetrics(input, { rugDropPct: 100 });

    out.push({
      mint: row.mint,
      groups: row.groups,
      ticker: d.coin['ticker'],
      stored: {
        ath: res.athMarketCapUsd,
        athAt: res.athAt,
        wick: res.athWickMarketCapUsd,
        wickAt: res.athWickAt,
        rug: res.rugPattern,
        dd: res.maxDrawdownPct,
        flags: res.flags,
        secondsAbove: res.secondsAbove,
        storedAth: Number(d.coin['ath_market_cap_usd']),
        status: d.coin['status'],
      },
      dune: du,
      stage: stage?.['detail'],
      pools: d.pools.map((p) => ({
        addr: p.pool['address'],
        dex: p.pool['dex'],
        primary: p.pool['is_primary'],
        grad: p.pool['is_graduation_pool'],
        n: [p.bars['60'].length, p.bars['3600'].length, p.bars['86400'].length],
      })),
      athWin,
      wickBar,
      wickRes,
      hasBarsInHour,
      hourMaxHigh,
      hour1mMax,
      hourBars: hourBars.slice(0, 12),
      sec13: {
        lowerings,
        lowerAt: lowerAt.slice(0, 5),
        hiddenStrictAboveAth: hiddenAtPeak.length,
        hiddenMax: Math.max(0, ...hiddenAtPeak.map((w) => w.price * SUPPLY)),
        relaxedAth,
      },
      rugFacts: { rug: res.rugPattern, athOnlyRug100: noRugRes.rugPattern },
    });
  }
  await writeFile(values.out!, JSON.stringify(out, null, 1));
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
