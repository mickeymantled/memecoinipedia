/**
 * Recomputes every coin of the review list from its stored bars under candidate rule changes
 * and prints, per variant, how many coins change. Nothing is applied to ingest/src: each
 * variant is built here from the library's own pieces (clean, points, ATH, rug, drawdown).
 *
 *   pnpm -C ingest exec node --import tsx scripts/a6/proposals.ts --cache DIR --list CSV [--out JSON]
 *
 * Variants:
 *   base      the rules as documented (must reproduce the stored ATH and rug flag)
 *   traders3  minWindowTraders 5 -> 3
 *   single    a 1-bar window is strict when it holds >= $5,000 and >= 25 traders (first-minute spikes)
 *   liq5k     a 1-minute window can set the ATH only when its last bar shows liquidity >= $5,000
 *   twoPoint  the level falls to a price only after two consecutive points at or below it (section 13 candidate)
 *   rug6h     rugWithinSec 1,800 -> 21,600
 */
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { computeAth } from '../../src/metrics/ath.js';
import { cleanPools } from '../../src/metrics/clean.js';
import { maxDrawdownPct } from '../../src/metrics/drawdown.js';
import { atLeast, SECONDS, type CleanPool, type LevelPoint, type Window } from '../../src/metrics/internal.js';
import { mergeParams } from '../../src/metrics/index.js';
import { buildLevelSeries } from '../../src/metrics/level.js';
import { buildCoinPoints } from '../../src/metrics/points.js';
import { rugPattern } from '../../src/metrics/rug.js';
import { secondsAbove } from '../../src/metrics/timeAbove.js';
import { buildWindows, lowerMedian } from '../../src/metrics/windows.js';
import type { Bar, MetricParams } from '../../src/metrics/types.js';
import { readDump, readDune, readReviewList, toMetricInput, SUPPLY } from './lib.js';

type Variant = 'base' | 'traders3' | 'single' | 'liq5k' | 'twoPoint' | 'rug6h';
const VARIANTS: Variant[] = ['base', 'traders3', 'single', 'liq5k', 'twoPoint', 'rug6h'];

function minuteWindowsV(bars: readonly Bar[], pool: CleanPool, p: MetricParams, v: Variant): (Window & { liq: number | null })[] {
  const span = (p.windowMinutes - 1) * SECONDS['1m'];
  return bars.map((bar, i) => {
    const inWindow: Bar[] = [];
    for (let j = i; j >= 0; j--) {
      const e = bars[j] as Bar;
      if (e.t < bar.t - span) break;
      inWindow.push(e);
    }
    const volume = inWindow.reduce((s, b) => s + b.volumeUsd, 0);
    const traders = Math.max(...inWindow.map((b) => b.traders));
    const minTraders = v === 'traders3' ? 3 : p.minWindowTraders;
    let strict = inWindow.length >= 2 && atLeast(volume, p.minWindowVolumeUsd) && atLeast(traders, minTraders);
    if (v === 'single' && inWindow.length === 1 && volume >= 5_000 && traders >= 25) strict = true;
    return {
      t: bar.t,
      price: lowerMedian(inWindow.map((b) => b.c)),
      high: lowerMedian(inWindow.map((b) => b.c)),
      volume,
      traders,
      strict,
      poolAddress: pool.address,
      isPrimary: pool.isPrimary,
      resolution: '1m' as const,
      liquidity: bar.liquidityUsd,
      liq: bar.liquidityUsd,
    };
  });
}

function levelTwoPoint(points: readonly { t: number; price: number; strict: boolean }[]): LevelPoint[] {
  const out: LevelPoint[] = [];
  let level: number | undefined;
  let prev: { price: number; strict: boolean } | undefined;
  for (const p of points) {
    if (p.strict) level = p.price;
    else if (level !== undefined && p.price < level) {
      // Drop only when the previous point is also below the level: the level falls to the higher of the two.
      if (prev !== undefined && prev.price < level) level = Math.max(p.price, prev.price);
    }
    if (level !== undefined) out.push({ t: p.t, level });
    prev = p;
  }
  return out;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { cache: { type: 'string' }, list: { type: 'string' }, dune: { type: 'string' }, out: { type: 'string' } },
    strict: true,
  });
  // --dune FILE runs all coins of the sample file (the 500), --list FILE the review list.
  const list: { mint: string; ath_usd: number; status: string }[] = values.dune
    ? [...(await readDune(values.dune)).keys()].map((mint) => ({ mint, ath_usd: 0, status: '' }))
    : await readReviewList(values.list!);
  const params = mergeParams();
  const results: Record<string, Record<Variant, { ath: number | null; rug: boolean; dd: number | null; above100k: number }>> = {};
  for (const r of list) {
    const d = await readDump(values.cache!, r.mint);
    const input = toMetricInput(d);
    const clean = cleanPools(input.pools, input, params);
    const per = {} as Record<Variant, { ath: number | null; rug: boolean; dd: number | null; above100k: number }>;
    for (const v of VARIANTS) {
      const windows: (Window & { liq?: number | null })[] = [];
      // Coarse windows: "finer data wins" depends on the 1-minute bars, so build them from the full pool set.
      const full = buildWindows(clean.pools, params).filter((w) => w.resolution !== '1m');
      windows.push(...full);
      for (const pool of clean.pools) windows.push(...minuteWindowsV(pool.bars1m, pool, params, v));
      let points = buildCoinPoints(windows);
      let athPoints = points;
      if (v === 'liq5k') {
        const liqAt = new Map<string, number | null>();
        for (const w of windows) liqAt.set(`${w.poolAddress}|${w.t}`, (w as { liq?: number | null }).liq ?? null);
        athPoints = points.map((p) =>
          p.resolution === '1m' && !((liqAt.get(`${p.poolAddress}|${p.t}`) ?? 0) >= 5_000) ? { ...p, strict: false } : p,
        );
      }
      const ath = computeAth(athPoints, input.launchedAt, input.totalSupply);
      points = v === 'liq5k' ? points : points;
      const series = v === 'twoPoint' ? levelTwoPoint(points) : buildLevelSeries(points);
      const rugParams = v === 'rug6h' ? { ...params, rugWithinSec: 21_600 } : params;
      per[v] = {
        ath: ath.fields.athMarketCapUsd,
        rug: rugPattern({ athAt: ath.fields.athAt, athPrice: ath.athPrice }, series, points, rugParams),
        dd: maxDrawdownPct(series),
        above100k: secondsAbove(series, params.thresholdsUsd, input.totalSupply, input.asOf, params.carryForwardMaxSec)[0] ?? 0,
      };
    }
    results[r.mint] = per;
    if (r.status !== '' && Math.abs((per.base.ath ?? 0) - r.ath_usd) > 1 && r.ath_usd > 0)
      console.error(`base mismatch ${r.mint}: ${per.base.ath} vs list ${r.ath_usd}`);
    if (r.status !== '' && per.base.rug !== (r.status === 'rugged')) console.error(`rug mismatch ${r.mint}: ${per.base.rug} vs ${r.status}`);
  }
  // Summaries.
  const n = list.length;
  console.log(`coins: ${n}`);
  for (const v of VARIANTS.slice(1)) {
    let athUp15 = 0, athDown15 = 0, listFlip = 0, rugOn = 0, rugOff = 0, ddChange = 0, aboveChange = 0;
    const flips: string[] = [];
    for (const r of list) {
      const b = results[r.mint]!.base;
      const x = results[r.mint]![v];
      const bb = b.ath ?? 0;
      const xx = x.ath ?? 0;
      if (xx > bb * 1.15) athUp15++;
      if (xx < bb * 0.85) athDown15++;
      if ((bb >= 100_000) !== (xx >= 100_000)) {
        listFlip++;
        flips.push(`${r.mint.slice(0, 6)} ${Math.round(bb)}->${Math.round(xx)}`);
      }
      if (!b.rug && x.rug) rugOn++;
      if (b.rug && !x.rug) rugOff++;
      if (Math.abs((x.dd ?? 0) - (b.dd ?? 0)) > 5) ddChange++;
      if (Math.abs(x.above100k - b.above100k) > 3600) aboveChange++;
    }
    console.log(`${v}: ATH up>15% ${athUp15}, down>15% ${athDown15}, listed(>=100k) flips ${listFlip} [${flips.join('; ')}], rug off->on ${rugOn}, on->off ${rugOff}, maxDD moves >5pt ${ddChange}, time above 100k moves >1h ${aboveChange}`);
  }
  if (values.out) await writeFile(values.out, JSON.stringify(results));
  void SUPPLY;
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
