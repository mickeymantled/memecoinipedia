/**
 * For each coin of the review list in group 7_rugged_sample: which part of the rug rule fired
 * (docs/metrics.md section 10) and what the stored bars say about the fall. Offline.
 *
 *   pnpm -C ingest exec node --import tsx scripts/a6/rug-review.ts --cache DIR --list CSV
 *
 * Per coin: ATH and its time; the crash point (first level point within 30 minutes at or below
 * 20% of the ATH) and whether it came from a strict point or from a point that was not strict
 * (a thin window lowering the level); the highest strict price after the crash as a share of
 * the ATH; the 1-minute close 30 minutes, 6 hours and 24 hours after the ATH; the pool liquidity
 * at the ATH and one hour later.
 */
import { parseArgs } from 'node:util';
import { cleanPools } from '../../src/metrics/clean.js';
import { mergeParams } from '../../src/metrics/index.js';
import { buildCoinPoints } from '../../src/metrics/points.js';
import { buildLevelSeries } from '../../src/metrics/level.js';
import { buildWindows } from '../../src/metrics/windows.js';
import { iso, readDump, readReviewList, toMetricInput, SUPPLY } from './lib.js';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { cache: { type: 'string' }, list: { type: 'string' }, group: { type: 'string', default: '7_rugged_sample' } },
    strict: true,
  });
  const list = (await readReviewList(values.list!)).filter((r) => r.groups.includes(values.group!));
  const params = mergeParams();
  for (const r of list) {
    const d = await readDump(values.cache!, r.mint);
    const input = toMetricInput(d);
    const clean = cleanPools(input.pools, input, params);
    const points = buildCoinPoints(buildWindows(clean.pools, params));
    const series = buildLevelSeries(points);
    let ath: (typeof points)[number] | null = null;
    for (const p of points)
      if (p.strict && p.resolution === '1m' && (ath === null || p.price > ath.price)) ath = p;
    if (!ath) {
      console.log(`${r.mint.slice(0, 8)} no ATH`);
      continue;
    }
    const limit = 0.2 * ath.price;
    const crash = series.find((s) => s.t > ath!.t && s.t <= ath!.t + 1800 && s.level <= limit);
    const crashPoint = crash ? points.find((p) => p.t === crash.t) : undefined;
    const after = points.filter((p) => crash && p.t > crash.t && p.strict);
    const maxAfter = Math.max(0, ...after.map((p) => p.price));
    const closeAt = (sec: number): string => {
      const pool = d.pools.find((p) => p.pool['address'] === ath!.poolAddress)!;
      const b = pool.bars['60'].find((x) => x.t >= ath!.t + sec);
      return b ? `${Math.round((b.c / ath!.price) * 100)}%` : 'n/a';
    };
    const liqAt = (sec: number): string => {
      const pool = d.pools.find((p) => p.pool['address'] === ath!.poolAddress)!;
      const b = pool.bars['60'].find((x) => x.t >= ath!.t + sec);
      return b?.liquidityUsd == null ? 'n/a' : String(Math.round(b.liquidityUsd));
    };
    // How the level fell: points between the ATH and the crash that were not strict.
    const between = points.filter((p) => crash && p.t > ath!.t && p.t <= crash.t);
    const firstStrictLow = points.find((p) => p.t > ath!.t && p.strict && p.price <= limit);
    console.log(
      [
        r.mint.slice(0, 8),
        d.coin['ticker'],
        `ATH $${Math.round(ath.price * SUPPLY)} @${iso(ath.t)}`,
        crash
          ? `crash@${iso(crash.t)} +${Math.round((crash.t - ath.t) / 60)}min by ${crashPoint?.strict ? 'STRICT' : 'NON-STRICT'} point, ${between.filter((p) => !p.strict).length}/${between.length} points before it not strict; first strict point <=20% ${firstStrictLow ? '+' + Math.round((firstStrictLow.t - ath.t) / 60) + 'min' : 'none'}`
          : 'NO crash point',
        `best strict after crash ${Math.round((maxAfter / ath.price) * 100)}% of ATH`,
        `close +30m ${closeAt(1800)} +6h ${closeAt(21600)} +24h ${closeAt(86400)}`,
        `liq at ATH ${liqAt(0)} +1h ${liqAt(3600)}`,
        `stored rug=${d.coin['rug_pattern']} status=${d.coin['status']} lastBar ${iso(Math.max(...d.pools.flatMap((p) => [...p.bars['60'], ...p.bars['3600'], ...p.bars['86400']].map((b) => b.t))))}`,
      ].join(' | '),
    );
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
