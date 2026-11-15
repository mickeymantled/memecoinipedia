/**
 * For each coin whose Dune peak hour lies inside the span of our 1-minute bars, compares
 * Dune's hourly figure with statistics of our own 1-minute bars in that hour (volume-weighted
 * close, median close, open, last close, highest high). Shows what Dune's hourly price is
 * most like. Offline.
 *
 *   pnpm -C ingest exec node --import tsx scripts/a6/dune-hour.ts --cache DIR --list CSV --dune CSV
 */
import { parseArgs } from 'node:util';
import { readDump, readDune, readReviewList, SUPPLY } from './lib.js';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { cache: { type: 'string' }, list: { type: 'string' }, dune: { type: 'string' } },
    strict: true,
  });
  const list = await readReviewList(values.list!);
  const dune = await readDune(values.dune!);
  const rows: string[] = [];
  const ratios: Record<string, number[]> = { vwap: [], median: [], open: [], last: [], high: [] };
  for (const r of list) {
    const d = await readDump(values.cache!, r.mint);
    const du = dune.get(r.mint)!;
    const h = Math.floor(new Date(du.peak_at).getTime() / 1000);
    // Busiest pool's 1-minute bars in the hour.
    let best: { addr: string; bars: { t: number; o: number; h: number; c: number; v: number }[] } | null = null;
    for (const p of d.pools) {
      const bars = p.bars['60']
        .filter((b) => b.t >= h && b.t < h + 3600)
        .map((b) => ({ t: b.t, o: b.o, h: Math.max(b.o, b.h, b.l, b.c), c: b.c, v: b.volumeUsd }));
      const vol = bars.reduce((s, b) => s + b.v, 0);
      if (bars.length > 0 && (best === null || vol > best.bars.reduce((s, b) => s + b.v, 0)))
        best = { addr: p.pool['address'], bars };
    }
    if (best === null) continue;
    const bars = best.bars;
    const vol = bars.reduce((s, b) => s + b.v, 0);
    const vwap = vol > 0 ? bars.reduce((s, b) => s + b.v * b.c, 0) / vol : NaN;
    const sorted = bars.map((b) => b.c).sort((a, b) => a - b);
    const median = sorted[Math.floor((sorted.length - 1) / 2)]!;
    const high = Math.max(...bars.map((b) => b.h));
    const f = (x: number) => Math.round(x * SUPPLY);
    const target = du.peak_p999_usd;
    for (const [k, v] of Object.entries({ vwap, median, open: bars[0]!.o, last: bars[bars.length - 1]!.c, high }))
      if (Number.isFinite(v) && v > 0) ratios[k]!.push(Math.log(target / (v * SUPPLY)));
    rows.push(
      `${r.mint.slice(0, 8)} dune ${Math.round(target)} | 1m bars in hour ${bars.length} vol ${Math.round(vol)} | vwap ${f(vwap)} median ${f(median)} open ${f(bars[0]!.o)} last ${f(bars[bars.length - 1]!.c)} high ${f(high)}`,
    );
  }
  console.log(rows.join('\n'));
  for (const [k, arr] of Object.entries(ratios)) {
    if (!arr.length) continue;
    const abs = arr.map((x) => Math.abs(x)).sort((a, b) => a - b);
    console.log(`${k}: n=${arr.length} median |ln(dune/ours)|=${abs[Math.floor(abs.length / 2)]!.toFixed(3)} within 25%: ${abs.filter((x) => x < 0.223).length}`);
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
