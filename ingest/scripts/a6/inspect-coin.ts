/**
 * Prints what the stored bars say about one coin: pools, stage detail, the stored metrics
 * against a recompute, the ATH window, and the highest bars per pool and resolution.
 *
 *   pnpm -C ingest exec node --import tsx scripts/a6/inspect-coin.ts --cache DIR MINT [MINT...]
 */
import { parseArgs } from 'node:util';
import { computeCoinMetrics } from '../../src/metrics/index.js';
import { iso, readDump, toMetricInput, usd, SUPPLY } from './lib.js';

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: { cache: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  });
  for (const mint of positionals) {
    const d = await readDump(values.cache!, mint);
    const c = d.coin;
    console.log(`\n=== ${mint} ${c['ticker'] ?? ''} status=${c['status']} flags=${JSON.stringify(c['metric_flags'])}`);
    console.log(
      `launched ${iso(new Date(c['launched_at']).getTime() / 1000)} graduated ${c['graduated_at'] ? iso(new Date(c['graduated_at']).getTime() / 1000) : 'n/a'}; asOf ${c['metrics_as_of']}`,
    );
    console.log(
      `stored ATH ${usd(Number(c['ath_market_cap_usd']))} at ${c['ath_at'] ? iso(new Date(c['ath_at']).getTime() / 1000) : 'n/a'}; wick ${usd(Number(c['ath_wick_market_cap_usd']))} at ${c['ath_wick_at'] ? iso(new Date(c['ath_wick_at']).getTime() / 1000) : 'n/a'}; rug=${c['rug_pattern']} dd=${c['max_drawdown_pct']}`,
    );
    for (const s of d.stages)
      if (s['stage'] === 'candles') console.log('candles stage:', JSON.stringify(s['detail']));
    for (const i of d.issues) console.log('issue:', i['kind'], JSON.stringify(i['detail']));
    const input = toMetricInput(d);
    for (const p of d.pools) {
      const n = (r: '60' | '3600' | '86400') => p.bars[r].length;
      const all = [...p.bars['60'], ...p.bars['3600'], ...p.bars['86400']];
      const first = Math.min(...all.map((b) => b.t));
      const last = Math.max(...all.map((b) => b.t));
      console.log(
        `pool ${p.pool['address']} ${p.pool['dex']} primary=${p.pool['is_primary']} grad=${p.pool['is_graduation_pool']} bars 1m/1h/1d=${n('60')}/${n('3600')}/${n('86400')} ${all.length ? iso(first) + ' .. ' + iso(last) : ''} peakLiq=${p.pool['peak_liquidity_usd']}`,
      );
      for (const cv of p.coverage)
        console.log(`   coverage ${cv['resolution_sec']} ${iso(new Date(cv['from_t']).getTime() / 1000)} .. ${iso(new Date(cv['to_t']).getTime() / 1000)} ${cv['reason']}`);
      for (const res of ['60', '3600', '86400'] as const) {
        const top = [...p.bars[res]]
          .sort((a, b) => Math.max(b.o, b.h, b.l, b.c) - Math.max(a.o, a.h, a.l, a.c))
          .slice(0, 4);
        for (const b of top)
          console.log(
            `   top ${res}s ${iso(b.t)} high ${usd(Math.max(b.o, b.h, b.l, b.c) * SUPPLY)} close ${usd(b.c * SUPPLY)} vol ${usd(b.volumeUsd)} trades ${b.trades} traders ${b.traders} liq ${usd(b.liquidityUsd)}`,
          );
      }
    }
    const r = computeCoinMetrics(input);
    console.log(
      `recompute: ATH ${usd(r.athMarketCapUsd)} at ${r.athAt ? iso(r.athAt) : 'n/a'} wick ${usd(r.athWickMarketCapUsd)} rug=${r.rugPattern} dd=${r.maxDrawdownPct?.toFixed(1)} flags=${r.flags}`,
    );
    if (r.athAt !== null) {
      for (const p of d.pools)
        for (const b of p.bars['60'])
          if (b.t >= r.athAt - 180 && b.t <= r.athAt + 120)
            console.log(
              `   ATH window bar ${p.pool['address'].slice(0, 6)} ${iso(b.t)} o/h/l/c ${usd(b.o * SUPPLY)}/${usd(b.h * SUPPLY)}/${usd(b.l * SUPPLY)}/${usd(b.c * SUPPLY)} vol ${usd(b.volumeUsd)} trades ${b.trades} traders ${b.traders}`,
            );
    }
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
