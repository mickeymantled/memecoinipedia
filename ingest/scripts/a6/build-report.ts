/**
 * Builds the A6a outlier review (CSV and Markdown) from the evidence files in the work directory:
 * features.json (features.ts), features500.json (features.ts over all 500 coins), proposals.json
 * and proposals500.json (proposals.ts), and the third-source files (third-source.ts).
 *
 *   pnpm -C ingest exec node --import tsx scripts/a6/build-report.ts --work DIR --out-csv FILE --out-md FILE
 *
 * The verdict rules are written out in `verdictFor` below, so the review can be repeated; the few
 * coins judged by hand (the flagged group) are listed in `MANUAL`, each with its reason.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { readReviewList } from './lib.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type R = Record<string, any>;
type Verdict = 'ours_right' | 'dune_right' | 'both_wrong' | 'undetermined' | 'ours_wrong'; // ours_wrong: groups 7 and 8 only, where Dune is not compared

interface Row {
  mint: string;
  ticker: string;
  groups: string;
  cell: string;
  ourAth: number | null;
  ourWick: number | null;
  dune: number;
  thirdPeak: number | null;
  thirdSource: string;
  verdict: Verdict;
  cause: string;
  athVol: number | null;
  athTrades: number | null;
  athTraders: number | null;
  athLiq: number | null;
  note: string;
}

const money = (n: number | null | undefined): string => (n == null ? 'n/a' : '$' + Math.round(n).toLocaleString('en-US'));

/** Coins judged by hand, with the reason. Keyed by the first 8 characters of the mint. */
const MANUAL: Record<string, { verdict: Verdict; cause: string; note: string }> = {
  HMAMXzKK: { verdict: 'ours_right', cause: 'wick_not_real', note: 'Wick $19.7B is one of 4 swaps in that minute (prices from $28k to $665M, 3 wallets); the cap dropped a larger bar and raised implausible_market_cap. Dune $248M is a single $263 print in June 2026. ATH $56k stays under the listing line.' },
  Hzqikfgp: { verdict: 'ours_right', cause: 'wick_not_real', note: 'Wick $377M is the top of 112 swaps by 10 wallets whose median price is $22k; implausible_market_cap raised for a larger bar. Dune $576k is a dust print in June 2026. ATH $66k stays under the listing line.' },
  E6okad4d: { verdict: 'both_wrong', cause: 'five_trader_rule', note: 'The 1-minute closes reach $116k with 1 to 3 wallets a minute and hourly closes sit at $97k to $108k for 8 hours of one day; the five-trader rule keeps the ATH at $80k, so a coin that traded above $100k is not listed. Dune $67.8M is a dust print (GeckoTerminal: 4 candles, high under $3k). The flag peak_outside_minute_coverage is a false alarm here: Codex.io 1-minute bars for the day exist and are the ones we hold.' },
  '3s6pEya4': { verdict: 'ours_right', cause: 'wick_not_real', note: 'No ATH is correct. The only high ($67M, daily bar) is a minute with $26 traded by 8 wallets and pool liquidity $0. Dune $86.8M (Feb 2025): Codex.io has no bar in that hour on the pool we hold; unsupported.' },
  xDMs6FRR: { verdict: 'dune_right', cause: 'five_trader_rule', note: 'USDC-quoted pool. Real market at $1.8M to $2.1M: Dune $1.82M, our daily high $2.13M, the minute with the high holds $70k of volume. Only 3 wallets traded in those minutes, so the five-trader rule leaves the ATH empty. Whether 3 wallets is a market is a policy call; the price is corroborated.' },
  DtR4D9Ft: { verdict: 'ours_right', cause: 'hourly_cap_no_ath_effect', note: 'candle_hourly_cap_hit: hourly bars stop at the 24-request cap, so old days are held as daily bars. ATH $240.0M agrees with Dune $230M (max $239M) and the wick $242M. Time above thresholds is approximate for the capped days; the ATH is not affected.' },
  '9BB6NFEc': { verdict: 'ours_right', cause: 'hourly_cap_no_ath_effect', note: 'candle_hourly_cap_hit. ATH $2.616B against CoinGecko public ATH $2.48B (+5.5%); wick $2.73B. Within 10% of the public figure.' },
  CzLSujWB: { verdict: 'ours_right', cause: 'hourly_cap_no_ath_effect', note: 'candle_hourly_cap_hit. ATH $1.3575B against CoinGecko public ATH $1.35B (+0.6%). Dune max $25.7B is a bad print (the unfiltered maximum); p999 $1.46B.' },
};

interface Ctx {
  f: R[];
  prop: R;
  gt: R;
  ev: R;
  cxHour: R;
  pairs: R;
  wickDay: R;
  cg: R;
}

function duneHourEvidence(c: Ctx, x: R): { peak: number | null; src: string; dust: boolean; detail: string; n: number; vol: number } {
  let peak: number | null = null;
  const src: string[] = [];
  let n = 0;
  let vol = 0;
  for (const [k, v] of Object.entries<R>(c.gt))
    if (k.startsWith(x['mint'] + '|dune|') && v['status'] === 200) {
      n += v['n'];
      vol += v['vol'] ?? 0;
      if (v['hi'] != null) peak = Math.max(peak ?? 0, v['hi']);
      src.push('GeckoTerminal');
    }
  for (const [k, v] of Object.entries<R>(c.cxHour))
    if (k.startsWith(x['mint'] + '|')) {
      n += v['n'];
      vol += v['vol'] ?? 0;
      if (v['hi'] != null) peak = Math.max(peak ?? 0, v['hi']);
      src.push('Codex.io 1m bars');
    }
  const p = c.pairs[x['mint']];
  if (p)
    for (const k of p['checked'] as R[]) {
      n += k['n'];
      if (k['hi'] != null) peak = Math.max(peak ?? 0, k['hi']);
      src.push('Codex.io other pools');
    }
  // Dust: the hour shows few candles with little money, or nothing, so no tradable price sits behind Dune's figure.
  const dust = n === 0 || vol < 1_000;
  return { peak, n, vol, src: [...new Set(src)].join('+') || 'none reachable', dust, detail: `${n} candle(s) in the Dune hour, $${Math.round(vol)} traded` };
}

function wickClass(c: Ctx, x: R): { cls: 'dust' | 'bad_print' | 'real' | 'none'; detail: string } {
  const day = c.wickDay[x['mint']]?.['best'] as R | undefined;
  const b = day
    ? { liq: day['liq'], vol: day['vol'], tr: day['tr'], u: day['u'] }
    : x['wickBar']
      ? { liq: x['wickBar'].liq, vol: x['wickBar'].vol, tr: x['wickBar'].trades, u: x['wickBar'].traders }
      : null;
  if (!b) return { cls: 'none', detail: 'no wick' };
  const detail = `wick minute: $${Math.round(b.vol)} traded, ${b.tr} trades, ${b.u} wallets, pool liquidity $${Math.round(b.liq ?? 0)}`;
  if ((b.liq ?? 0) < 100) return { cls: 'dust', detail };
  if (b.tr < 5 || b.vol / Math.max(1, b.tr) > b.liq) return { cls: 'bad_print', detail };
  return { cls: 'real', detail };
}

function verdictFor(c: Ctx, x: R): Pick<Row, 'verdict' | 'cause' | 'note' | 'thirdPeak' | 'thirdSource'> {
  const m = String(x['mint']);
  const groups = x['groups'] as string[];
  const prop = c.prop[m] as R | undefined;
  const ath = x['stored'].ath as number | null;
  // Drained: the $5,000 liquidity floor cuts the ATH by more than 15% (or removes it) and the pool held under $2,500 at the ATH.
  // A small pool that never held $5,000 is a small market, not a drained one, so the second condition keeps those out.
  const drained =
    prop != null &&
    ath != null &&
    (prop['liq5k'].ath == null || prop['liq5k'].ath < 0.85 * ath) &&
    (x['athWin']?.liq ?? Infinity) < 2_500;
  const single = prop != null && ath != null && prop['single'].ath != null && prop['single'].ath > 1.15 * ath;
  const manual = MANUAL[m.slice(0, 8)];
  const dh = duneHourEvidence(c, x);
  const wc = wickClass(c, x);
  const gtAth = Object.entries<R>(c.gt).find(([k, v]) => k.startsWith(m + '|ath|') && v['status'] === 200);
  const ev = c.ev[m + '|ath'] as R | undefined;
  const athPeak = gtAth ? (gtAth[1]['hi'] as number | null) : ev?.['pxMax'] ?? null;
  const athSrc = gtAth ? 'GeckoTerminal 1m, ATH window (high)' : ev ? `Codex.io raw swaps, ATH minute (${ev['n']} swaps, ${ev['makers']} wallets, highest)` : 'none';
  if (manual) {
    const peak = manual.cause === 'wick_not_real' || manual.cause === 'five_trader_rule' ? dh.peak ?? athPeak : athPeak;
    return { ...manual, thirdPeak: peak, thirdSource: peak != null ? dh.src : athSrc };
  }
  let out: Pick<Row, 'verdict' | 'cause' | 'note'>;
  const inReview = groups.some((g) => /^[1-6]_/.test(g));
  const cgAth = c.cg[m]?.['athUsd'] != null ? (c.cg[m]['athUsd'] as number) * 1e9 : null;
  if (!inReview && groups.includes('7_rugged_sample')) {
    const rugHigh = drained;
    out = rugHigh
      ? { verdict: 'ours_wrong', cause: 'drained_pool_ath', note: `Rug outcome stands (price at 0% to 2% of the ATH 30 minutes later) but the ATH was set while the pool held ${money(x['athWin']?.liq)}; with a $5,000 liquidity floor the ATH is ${money(prop!['liq5k'].ath)} and the rug flag is ${prop!['liq5k'].rug ? 'still set' : 'not set'}.` }
      : { verdict: 'ours_right', cause: 'rug_confirmed', note: `Crash within 30 minutes by ${x['rugFacts']?.rug ? 'the rug rule' : 'n/a'}; pool liquidity at the ATH ${money(x['athWin']?.liq)}.` };
    return { ...out, thirdPeak: null, thirdSource: 'stored bars only' };
  }
  if (!inReview && groups.includes('8_probe')) {
    const dune = x['dune'].peak_p999_usd as number;
    if (['DRwRNuXG', 'DwpnoX1Y', '7LsX88bh'].includes(m.slice(0, 8)))
      return { verdict: 'ours_right', cause: 'codex_summary_field_wrong', note: `Item 9. Raw swaps in the ATH minute agree with our bars; the figure in the first Codex.io summary is not reached by any bar we hold (highest ${money(x['stored'].wick)}).`, thirdPeak: ev?.['pxMax'] ?? null, thirdSource: ev ? `Codex.io raw swaps, ATH minute (${ev['n']} swaps, ${ev['makers']} wallets)` : 'none' };
    if (cgAth != null) {
      const r = ath! / cgAth;
      return { verdict: r >= 0.9 && r <= 1.1 ? 'ours_right' : 'undetermined', cause: 'public_ath_compare', note: `Ours ${money(ath)} against CoinGecko public ATH ${money(cgAth)} (price x 1e9): ratio ${r.toFixed(2)}.`, thirdPeak: cgAth, thirdSource: 'CoinGecko public ATH' };
    }
    const r = ath! / dune;
    return { verdict: r >= 0.85 && r <= 2.5 ? 'ours_right' : 'undetermined', cause: 'no_public_figure', note: `No public figure; ours ${money(ath)} is ${r.toFixed(2)} times Dune's hourly ${money(dune)} (hourly figures sit under 3-minute peaks) and the wick is ${money(x['stored'].wick)}.`, thirdPeak: null, thirdSource: 'none (Dune hourly only)' };
  }
  if (groups.includes('5_low_cell_listed') || groups.includes('3_above_3x')) {
    const confirmed = athPeak != null && athPeak >= 0.7 * (ath ?? Infinity) && (gtAth ? true : (ev?.['makers'] ?? 0) >= 10);
    if (confirmed)
      out = { verdict: 'ours_right', cause: 'dune_hourly_flatten', note: `Third source prices the ATH minute at the level we hold (${money(athPeak)}); Dune's hourly figure is ${(ath! / x['dune'].peak_p999_usd).toFixed(1)} times lower than a spike that the stored 1-minute bars show ${x['athWin']?.spike.minutes ?? '?'} minutes at or above half the ATH.` };
    else out = { verdict: 'undetermined', cause: 'no_third_source', note: 'The third source did not confirm the ATH minute.' };
  } else if (groups.includes('1_dune_far_above') || groups.includes('2_below_half') || groups.includes('4_wick_over_3x')) {
    const dune = x['dune'].peak_p999_usd as number;
    const only4 = !groups.includes('1_dune_far_above') && !groups.includes('2_below_half');
    // Dune's figure is a traded price only if the hour holds real volume and a candle reaches near it.
    const duneReal = dh.peak != null && dh.vol >= 1_000 && dh.peak >= 0.7 * dune && dh.peak <= 1.5 * dune;
    const duneNear = ath != null && dune <= 1.15 * ath && dune >= ath / 1.15;
    if (drained)
      out = { verdict: 'both_wrong', cause: 'drained_pool_ath', note: `Our ATH was set while the pool held ${money(x['athWin']?.liq)} of liquidity (window volume ${money(x['athWin']?.volume)}, ${x['athWin']?.trades} trades). Restricting ATH windows to $5,000 of liquidity gives ${money(prop!['liq5k'].ath)}. Dune hour: ${dh.detail}${duneReal ? '; a candle in that hour reaches the Dune figure, in the same drained pool' : '; not a tradable price'}.` };
    else if (single)
      out = { verdict: 'both_wrong', cause: 'one_minute_spike', note: `A one-minute peak (${wc.detail}) is not an ATH under the 3-minute rule. Allowing one bar with $5,000 and 25 wallets gives ${money(prop!['single'].ath)} against our ${money(ath)}. Dune hour: ${dh.detail}.` };
    else if (duneReal && !duneNear)
      out = { verdict: 'dune_right', cause: 'ours_missing_peak', note: `Dune hour confirms ${money(dh.peak)} with ${dh.detail}; our rules do not reach it.` };
    else if (duneNear)
      out = { verdict: 'ours_right', cause: wc.cls === 'real' ? 'wick_excluded_by_rule' : 'wick_not_real', note: `Dune ${money(dune)} is within 15% of our ATH ${money(ath)}. ${wc.cls === 'none' ? '' : 'Wick: ' + wc.cls.replace('_', ' ') + ' (' + wc.detail + ').'}` };
    else if (wc.cls === 'real' && only4)
      out = { verdict: 'ours_right', cause: 'wick_excluded_by_rule', note: `The wick is a traded minute (${wc.detail}) that the 3-minute rule leaves out of the ATH on purpose; a single-bar rule does not raise the ATH either.` };
    else if (dh.n === 0 && dh.peak == null && !gtAth && !ev)
      out = { verdict: 'undetermined', cause: 'no_third_source', note: `Dune's ${money(dune)} could not be checked: ${dh.detail}; the hour is older than GeckoTerminal serves.` };
    else out = { verdict: 'ours_right', cause: 'dune_dust_print', note: `Dune's ${money(dune)} is not a tradable price: ${dh.detail}. ${wc.cls !== 'real' && wc.cls !== 'none' ? 'Our wick is also a ' + wc.cls.replace('_', ' ') + ' (' + wc.detail + ').' : ''}` };
  } else {
    out = { verdict: 'ours_right', cause: 'within_band', note: 'Not an outlier in groups 1 to 6.' };
  }
  const useDune = groups.includes('1_dune_far_above') || groups.includes('2_below_half');
  const peak = useDune && dh.peak != null ? dh.peak : athPeak ?? dh.peak;
  return { ...out, thirdPeak: peak, thirdSource: useDune && dh.peak != null ? dh.src + ' (Dune hour)' : athPeak != null ? athSrc : dh.src };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { work: { type: 'string' }, list: { type: 'string' }, template: { type: 'string' }, 'out-csv': { type: 'string' }, 'out-md': { type: 'string' } },
    strict: true,
  });
  const work = values.work!;
  const j = async (n: string, fb: R = {}): Promise<R> => (existsSync(join(work, n)) ? (JSON.parse(await readFile(join(work, n), 'utf8')) as R) : fb);
  const f = (await j('features.json', [])) as unknown as R[];
  const ctx: Ctx = {
    f,
    prop: await j('proposals.json'),
    gt: await j('gt-results.json'),
    ev: await j('ev-results.json'),
    cxHour: await j('cx-dune-hour.json'),
    pairs: await j('cx-pairs.json'),
    wickDay: await j('cx-wick-day.json'),
    cg: await j('cg-results.json'),
  };
  const list = new Map((await readReviewList(values.list!)).map((r) => [r.mint, r]));
  const rows: Row[] = [];
  for (const x of f) {
    const v = verdictFor(ctx, x);
    rows.push({
      mint: x['mint'],
      ticker: String(x['ticker'] ?? '').replace(/[,"\n]/g, ' '),
      groups: (x['groups'] as string[]).join('|'),
      cell: list.get(x['mint'])?.cell ?? '',
      ourAth: x['stored'].ath,
      ourWick: x['stored'].wick,
      dune: x['dune'].peak_p999_usd,
      thirdPeak: v.thirdPeak,
      thirdSource: v.thirdSource,
      verdict: v.verdict,
      cause: v.cause,
      athVol: x['athWin']?.volume ?? null,
      athTrades: x['athWin']?.trades ?? null,
      athTraders: x['athWin']?.traders ?? null,
      athLiq: x['athWin']?.liq ?? null,
      note: v.note.replace(/\s*\n\s*/g, ' '),
    });
  }
  const q = (s: string | number): string => (/[",\n]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s));
  const head = 'mint,ticker,groups,cell,our_ath_usd,our_wick_usd,dune_hourly_p999_usd,third_source_peak_usd,third_source,verdict,cause,ath_window_volume_usd,ath_window_trades,ath_window_traders,ath_pool_liquidity_usd,note';
  const csv =
    [head, ...rows.map((r) => [r.mint, r.ticker, r.groups, r.cell, r.ourAth ?? '', r.ourWick ?? '', r.dune, r.thirdPeak == null ? '' : Math.round(r.thirdPeak), r.thirdSource, r.verdict, r.cause, r.athVol == null ? '' : Math.round(r.athVol), r.athTrades ?? '', r.athTraders ?? '', r.athLiq == null ? '' : Math.round(r.athLiq), r.note].map(q).join(','))].join('\n') + '\n';
  if (values['out-csv']) await writeFile(values['out-csv'], csv);
  await writeFile(join(work, 'verdict-rows.json'), JSON.stringify(rows));

  // Totals for groups 1 to 6.
  const in16 = rows.filter((r) => r.groups.split('|').some((g) => /^[1-6]_/.test(g)));
  const tally = (rs: Row[], key: 'verdict' | 'cause'): string =>
    Object.entries(rs.reduce<Record<string, number>>((m, r) => ((m[r[key]] = (m[r[key]] ?? 0) + 1), m), {}))
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k} ${n}`)
      .join(', ');
  const lines: string[] = [];
  lines.push(`Coins in groups 1 to 6: ${in16.length}. By verdict: ${tally(in16, 'verdict')}.`);
  lines.push(`By cause: ${tally(in16, 'cause')}.`);
  for (const g of ['1_dune_far_above', '2_below_half', '3_above_3x', '4_wick_over_3x', '5_low_cell_listed', '6_flagged']) {
    const rs = rows.filter((r) => r.groups.split('|').includes(g));
    lines.push(`- ${g} (${rs.length}): verdict ${tally(rs, 'verdict')}; cause ${tally(rs, 'cause')}`);
  }
  if (values['out-md']) {
    const table = `| mint | ticker | groups | cell | our ATH | Dune hourly | third-source peak | verdict | cause |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n${rows
      .map((r) => `| ${r.mint} | ${r.ticker.replace(/\|/g, '/')} | ${r.groups.replace(/_[a-z_0-9]+/g, '').replace(/\|/g, ',')} | ${r.cell} | ${money(r.ourAth)} | ${money(r.dune)} | ${money(r.thirdPeak)} | ${r.verdict} | ${r.cause} |`)
      .join('\n')}`;
    const template = values.template ? await readFile(values.template, 'utf8') : '{{TOTALS}}\n\n{{TABLE}}\n';
    await writeFile(values['out-md'], template.replace('{{TOTALS}}', lines.join('\n')).replace('{{TABLE}}', table));
  }
  console.log(lines.join('\n'));
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
