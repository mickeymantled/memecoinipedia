/**
 * Figures for the A6a report that are not per-coin verdicts: how many of the 500 coins change under
 * each rule variant, the section 13 counters, the probe coins against CoinGecko's public ATH, and the
 * quote token of the 2026-H2 coins. Reads the evidence files that features.ts, proposals.ts and
 * third-source.ts write into the work directory.
 *
 *   pnpm -C ingest exec node --import tsx scripts/a6/stats.ts --work DIR --cache DIR --list CSV
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { readDump, readReviewList } from './lib.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type R = Record<string, any>;
const LINE = 100_000;
const k = (n: number | null | undefined): string => (n == null ? 'n/a' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : Math.round(n / 1e3) + 'k');

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { work: { type: 'string' }, cache: { type: 'string' }, list: { type: 'string' } }, strict: true });
  const work = values.work!;
  const j = async (n: string): Promise<R> => (existsSync(join(work, n)) ? (JSON.parse(await readFile(join(work, n), 'utf8')) as R) : {});
  const prop = await j('proposals500.json');
  const f500 = (await j('features500.json')) as unknown as R[];
  const f = (await j('features.json')) as unknown as R[];
  const cg = await j('cg-results.json');
  const gt = await j('gt-results.json');
  const rows = await readReviewList(values.list!);

  // A. Rule variants over all 500 coins.
  const mints = Object.keys(prop);
  console.log('--- A. variants over', mints.length, 'coins (ATH change over 15% either way; listed = ATH >= $100k)');
  const union = { high: new Set<string>(), low: new Set<string>() };
  const unionFlip = new Set<string>();
  for (const v of ['traders3', 'single', 'liq5k', 'twoPoint', 'rug6h']) {
    let up = 0;
    let down = 0;
    let flip = 0;
    let rugFlip = 0;
    let gone = 0;
    const flipList: string[] = [];
    for (const m of mints) {
      const b = prop[m].base;
      const x = prop[m][v];
      if (b.ath != null && x.ath != null) {
        if (x.ath > 1.15 * b.ath) {
          up++;
          union.low.add(m);
        }
        if (x.ath < 0.85 * b.ath) {
          down++;
          union.high.add(m);
        }
      } else if (b.ath != null && x.ath == null) gone++;
      const bl = (b.ath ?? 0) >= LINE;
      const xl = (x.ath ?? 0) >= LINE;
      if (bl !== xl) {
        flip++;
        unionFlip.add(m);
        flipList.push(`${m.slice(0, 6)} ${k(b.ath)}->${k(x.ath)}`);
      }
      if (b.rug !== x.rug) rugFlip++;
    }
    console.log(v.padEnd(9), 'ATH up', up, 'ATH down', down, 'ath lost', gone, 'listed flips', flip, 'rug flips', rugFlip, flipList.join('; '));
  }
  console.log('union ATH too low (traders3|single):', [...union.low].length, 'too high (liq5k|twoPoint):', [...union.high].length, 'listed flips any variant:', unionFlip.size);
  // Exclusive definitions: "too low" from single or traders3, "too high" from liq5k only.
  const low = new Set<string>();
  const high = new Set<string>();
  const flip = new Set<string>();
  for (const m of mints) {
    const b = prop[m].base;
    for (const v of ['traders3', 'single']) if (b.ath != null && prop[m][v].ath != null && prop[m][v].ath > 1.15 * b.ath) low.add(m);
    if (b.ath != null && prop[m].liq5k.ath != null && prop[m].liq5k.ath < 0.85 * b.ath) high.add(m);
    const bl = (b.ath ?? 0) >= LINE;
    for (const v of ['traders3', 'single', 'liq5k']) if (bl !== ((prop[m][v].ath ?? 0) >= LINE)) flip.add(m);
  }
  const wrong = new Set([...low, ...high]);
  console.log('ESTIMATE (traders3|single => too low; liq5k => too high):', 'low', low.size, 'high', high.size, 'either', wrong.size, 'both', [...low].filter((m) => high.has(m)).length, 'listed flips', flip.size);

  // A2. Coins whose review verdict says our ATH is wrong, and how many of them the variants already catch.
  const verdicts = (await j('verdict-rows.json')) as unknown as R[];
  const oursWrong = verdicts.filter((r) => r['verdict'] === 'both_wrong' || r['verdict'] === 'dune_right');
  const caught = oursWrong.filter((r) => wrong.has(r['mint']));
  console.log(`--- A2. review verdicts with our ATH wrong: ${oursWrong.length}; also found by the variants: ${caught.length}; only by review: ${oursWrong.filter((r) => !wrong.has(r['mint'])).map((r) => String(r['ticker']) + ' ' + r['cause']).join(', ')}`);
  console.log('    variant-found coins that are in no review group 1 to 6:', [...wrong].filter((m) => !verdicts.some((r) => r['mint'] === m && /(^|\|)[1-6]_/.test(r['groups']))).length);
  // A3. The rugged sample under the liquidity floor.
  console.log('--- A3. rugged sample (group 7): ATH base vs liq5k');
  for (const x of f.filter((y) => (y['groups'] as string[]).includes('7_rugged_sample'))) {
    const p = prop[x['mint']] as R | undefined;
    if (p) console.log(String(x['mint']).slice(0, 8), String(x['ticker']).padEnd(10), 'ath', k(p.base.ath), 'liq5k', k(p.liq5k.ath), 'rug', p.base.rug, p.liq5k.rug, 'rug6h', p.rug6h.rug, 'liq at ATH', Math.round(x['athWin']?.liq ?? 0));
  }

  // B. Section 13 counters, over the reviewed coins and over all 500.
  for (const [name, set] of [['reviewed (groups 1 to 8)', f], ['all 500', f500]] as const) {
    let lower = 0;
    let lowerCoins = 0;
    let hidden = 0;
    let hiddenCoins = 0;
    let t3 = 0;
    let t1 = 0;
    for (const x of set) {
      const s = x['sec13'];
      if (s.lowerings > 0) {
        lowerCoins++;
        lower += s.lowerings;
      }
      if (s.hiddenStrictAboveAth > 0) {
        hiddenCoins++;
        hidden += s.hiddenStrictAboveAth;
      }
      const a = x['stored'].ath as number | null;
      if (a != null && s.relaxedAth.t3 != null && s.relaxedAth.t3 > 1.15 * a) t3++;
      if (a != null && s.relaxedAth.t1 != null && s.relaxedAth.t1 > 1.15 * a) t1++;
    }
    console.log(`--- B. section 13, ${name}: ${set.length} coins; level lowered by a non-strict point to under half: ${lowerCoins} coins (${lower} events); strict 1m window above the ATH hidden by a busier non-strict one at the peak: ${hiddenCoins} coins (${hidden}); ATH over 15% higher with 3 traders: ${t3}; with 1 trader: ${t1}`);
  }
  // Rug flag that came from a level lowering (set of rugged coins whose crash point is non-strict is in rug-review.ts).

  // C. Probe coins (group 8) against CoinGecko's public ATH.
  console.log('--- C. probes (group 8): our ATH, CoinGecko public ATH x 1e9 supply, ratio');
  for (const x of f.filter((y) => (y['groups'] as string[]).includes('8_probe'))) {
    const c = cg[x['mint']] as R | undefined;
    const ours = x['stored'].ath as number | null;
    const pub = c?.['athUsd'] != null ? c['athUsd'] * 1e9 : null;
    console.log(String(x['mint']).slice(0, 8), String(x['ticker']).padEnd(12), 'ours', k(ours), 'wick', k(x['stored'].wick), 'public', k(pub), pub && ours ? (ours / pub).toFixed(2) : c?.['status'] === 404 ? 'not on CoinGecko' : 'n/a', 'dune', k(x['dune'].peak_p999_usd));
  }

  // D. Quote token of the 2026-H2 coins on the list.
  console.log('--- D. 2026-H2 coins: main pool quote token, dex, our ATH vs ATH-window high from GeckoTerminal');
  let n = 0;
  const tally: Record<string, number> = {};
  for (const r of rows.filter((y) => y.half_year === '2026-H2')) {
    const d = await readDump(values.cache!, r.mint);
    const main = d.pools.find((p) => p.pool['is_graduation_pool']) ?? d.pools.find((p) => p.pool['is_primary']) ?? d.pools[0];
    const q = (main?.pool['quote_token'] as string | null) ?? '(not fetched)';
    tally[q] = (tally[q] ?? 0) + 1;
    n++;
    const x = f.find((y) => y['mint'] === r.mint);
    const g = Object.entries<R>(gt).find(([key, v]) => key.startsWith(r.mint + '|ath|') && v['status'] === 200);
    console.log(r.mint.slice(0, 8), String(d.coin['ticker']).padEnd(10), q.padEnd(14), String(main?.pool['dex']).padEnd(10), 'ours', k(x?.['stored'].ath), 'GT', k(g?.[1]['hi']));
  }
  console.log('H2-2026 coins', n, JSON.stringify(tally));
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
