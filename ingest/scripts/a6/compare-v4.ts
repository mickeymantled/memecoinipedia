/**
 * Compares the metric rules at version 4 (docs/metrics.md) with the version 3 values stored
 * in the per-coin dumps, on the sampled coins. Offline: reads the dumps made by dump-coins.ts
 * and the sample list, runs the real library, writes nothing to any database and calls no provider.
 *
 *   pnpm -C ingest exec node --import tsx scripts/a6/compare-v4.ts --cache DIR --dune SAMPLE.csv \
 *     [--prototype JSON] [--out report.md]
 *
 * --prototype is an optional JSON object keyed by mint whose `fundedWin.ath` is a prototype's
 * ATH for the funded-window rule alone; the script reports the coins where the library's ATH
 * differs from it.
 *
 * Nothing here is tuned to match anything: it prints what the library computes.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { screenedOutResult } from '../../src/candles/metrics.js';
import { DEFAULT_PLAN_LIMITS } from '../../src/candles/plan.js';
import { computeCoinMetrics } from '../../src/metrics/index.js';
import { readDump, readDune, toMetricInput, usd } from './lib.js';

const LISTING_LINE_USD = 100_000;
const REL = 1e-9;

interface Old {
  ath: number | null;
  wick: number | null;
  dd: number | null;
  rug: boolean;
  above100k: number | null;
  screened: boolean;
}

interface Row {
  mint: string;
  old: Old;
  ath: number | null;
  wick: number | null;
  dd: number | null;
  rug: boolean;
  above100k: number | null;
  athLiquidityUsd: number | null;
  athHourVolumeUsd: number | null;
  halfYear: string;
}

const num = (x: unknown): number | null => (x === null || x === undefined ? null : Number(x));
const same = (a: number | null, b: number | null, rel = REL): boolean =>
  a === null || b === null ? a === b : Math.abs(a - b) <= rel * Math.max(Math.abs(a), Math.abs(b));
const sameAbs = (a: number | null, b: number | null, abs = 1e-6): boolean =>
  a === null || b === null ? a === b : Math.abs(a - b) <= abs;

/** Linear-interpolated percentile of an ascending array. */
export function percentile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return (sorted[lo] as number) + ((sorted[hi] as number) - (sorted[lo] as number)) * (pos - lo);
}

const fmt = (n: number | null): string => (n === null ? 'none' : usd(n));
const pct = (n: number | null): string => (n === null ? 'n/a' : n.toFixed(1) + '%');
const ratio = (n: number | null): string => (n === null ? 'n/a' : n.toFixed(4));

function summary(values: number[]): string {
  const s = [...values].sort((a, b) => a - b);
  return `${s.length} | ${fmtNum(percentile(s, 0.5))} | ${fmtNum(percentile(s, 0.1))} | ${fmtNum(percentile(s, 0.9))}`;
}
const fmtNum = (n: number | null): string =>
  n === null ? 'n/a' : n >= 100 ? '$' + Math.round(n).toLocaleString('en-US') : n.toFixed(3);

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      cache: { type: 'string' },
      dune: { type: 'string' },
      prototype: { type: 'string' },
      out: { type: 'string' },
    },
    strict: true,
  });
  if (!values.cache || !values.dune) throw new Error('--cache and --dune are required');
  const sample = [...(await readDune(values.dune)).keys()];
  const halfYears = new Map<string, string>();
  for (const line of (await readFile(values.dune, 'utf8')).trim().split(/\r?\n/).slice(1)) {
    const c = line.split(',');
    halfYears.set(c[0] as string, c[1] as string);
  }
  const prototype = values.prototype
    ? (JSON.parse(await readFile(values.prototype, 'utf8')) as Record<
        string,
        { fundedWin?: { ath: number | null } }
      >)
    : null;

  const rows: Row[] = [];
  for (const mint of sample) {
    const d = await readDump(values.cache, mint);
    const flags = (d.coin['metric_flags'] ?? []) as string[];
    const old: Old = {
      ath: num(d.coin['ath_market_cap_usd']),
      wick: num(d.coin['ath_wick_market_cap_usd']),
      dd: num(d.coin['max_drawdown_pct']),
      rug: d.coin['rug_pattern'] === true,
      above100k: num(d.coin['seconds_above_100k']),
      screened: flags.includes('screened_out'),
    };
    // The metrics stage stores a screened-out coin with the screen's own result (no ATH, no
    // wick, no time above, no drawdown); every other coin gets the library's result.
    const input = toMetricInput(d);
    const screenedResult = screenedOutResult(input, DEFAULT_PLAN_LIMITS.screenBelowUsd);
    const r = screenedResult ?? computeCoinMetrics(input);
    rows.push({
      mint,
      old,
      ath: r.athMarketCapUsd,
      wick: r.athWickMarketCapUsd,
      dd: r.maxDrawdownPct,
      rug: r.rugPattern,
      above100k: r.secondsAbove[0] ?? null,
      athLiquidityUsd: r.athLiquidityUsd,
      athHourVolumeUsd: r.athHourVolumeUsd,
      halfYear: halfYears.get(mint) ?? '',
    });
  }

  const out: string[] = [];
  const log = (s = ''): void => {
    out.push(s);
  };
  const short = (m: string): string => m.slice(0, 8);

  const athChanged = rows.filter((r) => !same(r.old.ath, r.ath));
  const dropUnder = athChanged.filter(
    (r) => (r.old.ath ?? 0) >= LISTING_LINE_USD && (r.ath ?? 0) < LISTING_LINE_USD,
  );
  const lostRug = rows.filter((r) => r.old.rug && !r.rug);
  const gainedRug = rows.filter((r) => !r.old.rug && r.rug);
  const others = rows.filter((r) => !athChanged.includes(r));
  const otherMoves = {
    drawdown: others.filter((r) => !sameAbs(r.old.dd, r.dd)),
    rug: others.filter((r) => r.old.rug !== r.rug),
    above100k: others.filter((r) => r.old.above100k !== r.above100k),
  };
  const ddMovesAmongChanged = athChanged.filter((r) => !sameAbs(r.old.dd, r.dd));

  log('# Metric rules version 4 on the 500 sampled coins');
  log();
  log(
    '<!-- Generated by ingest/scripts/a6/compare-v4.ts from the stored candles of the sample (offline: no database written, no provider called). Version 3 values are the ones stored in the dumps. -->',
  );
  log();
  log(
    'Each coin is recomputed with the real library at the rules of docs/metrics.md version 4 and compared with the version 3 values stored for it. A screened-out coin is stored by the metrics stage with the screen\'s own result, so it is compared with that. "Listed" means an ATH of $100,000 or more at version 4. Market caps are in USD.',
  );
  log();
  log('## Counts');
  log();
  log(`- Coins compared: ${rows.length}`);
  log(`- Coins whose ATH changes: ${athChanged.length}`);
  log(`- Of those, dropping under ${usd(LISTING_LINE_USD)}: ${dropUnder.length}`);
  log(`- Coins losing the rug pattern: ${lostRug.length}; gaining it: ${gainedRug.length}`);
  log(
    `- Coins whose ATH did not change but whose drawdown moves: ${otherMoves.drawdown.length}, rug pattern: ${otherMoves.rug.length}, seconds above $100,000: ${otherMoves.above100k.length}`,
  );
  log();
  log('## The coins whose ATH changes');
  log();
  log(
    '| Mint | ATH v3 | ATH v4 | Rug v3 | Rug v4 | Drawdown v3 | Drawdown v4 | Above $100k v3 (s) | v4 (s) | athLiquidityUsd v4 |',
  );
  log('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of [...athChanged].sort((a, b) => (b.old.ath ?? 0) - (a.old.ath ?? 0))) {
    log(
      `| ${short(r.mint)} | ${fmt(r.old.ath)} | ${fmt(r.ath)} | ${r.old.rug} | ${r.rug} | ${pct(r.old.dd)} | ${pct(r.dd)} | ${r.old.above100k ?? 'n/a'} | ${r.above100k} | ${fmt(r.athLiquidityUsd)} |`,
    );
  }
  if (ddMovesAmongChanged.length === 0) log('\n(No drawdown moves among them.)');
  if (gainedRug.length > 0) {
    log();
    log(`Coins gaining the rug pattern: ${gainedRug.map((r) => short(r.mint)).join(', ')}`);
  }
  log();
  log(`Losing the rug pattern: ${lostRug.map((r) => short(r.mint)).join(', ') || 'none'}`);
  log(
    `Dropping under ${usd(LISTING_LINE_USD)}: ${dropUnder.map((r) => short(r.mint)).join(', ') || 'none'}`,
  );
  for (const [name, list] of Object.entries(otherMoves)) {
    if (list.length > 0)
      log(`Other coins whose ${name} moves: ${list.map((r) => short(r.mint)).join(', ')}`);
  }

  if (prototype) {
    const diff = rows.filter((r) => {
      const p = prototype[r.mint]?.fundedWin?.ath;
      if (p === undefined) return false;
      return !same(p, r.ath, 1e-3);
    });
    log();
    log(`ATH differing from the prototype's funded-window result (1e-3 relative): ${diff.length}`);
    for (const r of diff)
      log(
        `- ${short(r.mint)}: prototype ${fmt(prototype[r.mint]?.fundedWin?.ath ?? null)}, library ${fmt(r.ath)}`,
      );
  }

  // Wick.
  const screened = rows.filter((r) => r.old.screened);
  const rest = rows.filter((r) => !r.old.screened);
  const over = (
    k: number,
    wick: (r: Row) => number | null,
    ath: (r: Row) => number | null,
  ): number =>
    rows.filter((r) => {
      const w = wick(r);
      const a = ath(r);
      return w !== null && a !== null && w > k * a;
    }).length;
  log();
  log('## Wick');
  log();
  log('| | more than 2x the ATH | more than 3x the ATH |');
  log('|---|---|---|');
  log(
    `| version 3 (stored wick, stored ATH) | ${over(
      2,
      (r) => r.old.wick,
      (r) => r.old.ath,
    )} | ${over(
      3,
      (r) => r.old.wick,
      (r) => r.old.ath,
    )} |`,
  );
  log(
    `| version 4 | ${over(
      2,
      (r) => r.wick,
      (r) => r.ath,
    )} | ${over(
      3,
      (r) => r.wick,
      (r) => r.ath,
    )} |`,
  );
  const wickNull = rows.filter((r) => r.wick === null);
  log();
  log(
    `Screened-out coins in the sample (stored with a daily-high wick at version 3): ${screened.length}. Coins with no wick at version 4: ${wickNull.length} (${wickNull.filter((r) => r.old.screened).length} of them screened out).`,
  );
  log(
    `Coins with the version 4 wick under the version 4 ATH (must be 0): ${rows.filter((r) => r.wick !== null && r.ath !== null && r.wick < r.ath).length}.`,
  );
  log();
  log('### Old wick and new wick where they differ by more than a factor of 3');
  log();
  log('| Mint | Old wick | New wick | Factor | ATH v3 | ATH v4 |');
  log('|---|---|---|---|---|---|');
  const wide = rest
    .filter((r) => r.old.wick !== null && r.wick !== null)
    .map((r) => ({
      r,
      f:
        Math.max(r.old.wick as number, r.wick as number) /
        Math.min(r.old.wick as number, r.wick as number),
    }))
    .filter((x) => x.f > 3)
    .sort((a, b) => b.f - a.f);
  for (const { r, f } of wide) {
    log(
      `| ${short(r.mint)} | ${fmt(r.old.wick)} | ${fmt(r.wick)} | ${f.toFixed(1)}x | ${fmt(r.old.ath)} | ${fmt(r.ath)} |`,
    );
  }
  const oneSided = rest.filter((r) => (r.old.wick === null) !== (r.wick === null));
  log();
  log(`Coins with a wick on one side only (not in the table): ${oneSided.length}`);
  log(`Coins where the wick differs by more than a factor of 3: ${wide.length}`);

  // New outputs, listed coins (ATH at version 4 of $100,000 or more).
  const listed = rows.filter((r) => (r.ath ?? 0) >= LISTING_LINE_USD);
  const liq = listed.map((r) => r.athLiquidityUsd).filter((x): x is number => x !== null);
  const rel = listed
    .filter((r) => r.athHourVolumeUsd !== null && r.ath !== null)
    .map((r) => (r.athHourVolumeUsd as number) / (r.ath as number));
  const thin = listed.filter((r) => r.athHourVolumeUsd !== null && r.athHourVolumeUsd < 10_000);
  log();
  log(
    `## New outputs, ${listed.length} listed coins (ATH at version 4 of ${usd(LISTING_LINE_USD)} or more)`,
  );
  log();
  log('| Output | Coins with a value | Median | 10th percentile | 90th percentile |');
  log('|---|---|---|---|---|');
  log(`| athLiquidityUsd | ${summary(liq)} |`);
  log(`| athHourVolumeUsd / athMarketCapUsd | ${summary(rel).replace(/\$/g, '')} |`);
  log();
  log(
    `- athLiquidityUsd is null for ${listed.length - liq.length} listed coins (no bar of the ATH window reports it).`,
  );
  log(`- Listed coins with athHourVolumeUsd under $10,000: ${thin.length} of ${listed.length}`);
  log(
    `- Ratio values are fractions (0.01 is 1%); percentiles are linearly interpolated. Median ratio ${ratio(
      percentile(
        [...rel].sort((a, b) => a - b),
        0.5,
      ),
    )}.`,
  );

  const text = out.join('\n') + '\n';
  if (values.out) await writeFile(values.out, text);
  else process.stdout.write(text);
  // Short echo even when the report goes to a file.
  if (values.out) {
    process.stdout.write(
      `ath changed ${athChanged.length}, under line ${dropUnder.length}, rug lost ${lostRug.length}, other moves dd ${otherMoves.drawdown.length} rug ${otherMoves.rug.length} above ${otherMoves.above100k.length}\n`,
    );
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
