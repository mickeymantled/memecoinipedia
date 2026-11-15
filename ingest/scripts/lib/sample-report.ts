/**
 * The report on a sample run: reads the database and the sample file and builds
 * Markdown tables (issue 37). `buildReport` is pure so it can be tested on small
 * inputs; `loadReportData` does the reading and makes no write.
 *
 * Definitions, repeated in the report so a reader needs nothing else:
 * - A coin is "done" for candles when its candles stage is `done`.
 * - Path, units and "pool list needed" come from the candles stage `detail`.
 *   "Pool list needed" is `launchInfoNamedPool === false`; coins with no value
 *   (the first fetch happened in an earlier run) are left out of that share.
 * - "ATH of $100,000 or more" is over coins whose metrics stage is `done`.
 * - The ratio is `ath_market_cap_usd / peak_p999_usd` (the Dune hourly peak from
 *   the sample file). A coin with no ATH (screened out, or no qualifying window)
 *   counts as not listed and is left out of the ratio.
 * - Quantiles use linear interpolation between ranks.
 */
import {
  countOpenIssues,
  countStages,
  groupStageFailures,
  type Database,
  type FailureGroup,
  type StageCount,
  type StageName,
} from '@memecoinipedia/db';
import { sql, type Kysely } from 'kysely';
import { estimateCandleUnits } from '../../src/worker/plan.js';
import type { ParsedSample } from '../../src/worker/seed.js';

export const CELLS = ['30k-50k', '50k-100k', '100k-1M', '1M-10M', '10M+'] as const;
export const ATH_LISTING_USD = 100_000;
export const RATIO_LOW = 0.5;
export const RATIO_HIGH = 3;

export interface ReportCoin {
  mint: string;
  halfYear: string;
  cell: string;
  probe: boolean;
  /** `peak_p999_usd` from the sample file. */
  peakP999: number | null;
  inDatabase: boolean;
  candles: string;
  metrics: string;
  detail: {
    path?: string;
    units?: number;
    launchInfoNamedPool?: boolean | null;
  } | null;
  ath: number | null;
  flags: string[];
  coinStatus: string | null;
}

export interface ReportData {
  sampleFile: string;
  coins: ReportCoin[];
  stages: StageCount[];
  failures: FailureGroup[];
  issues: Array<{ kind: string; coins: number; issues: number }>;
  runs: { count: number; seconds: number; codexUnits: number };
  generatedAt: Date;
}

// ----------------------------------------------------------------- statistics

/** The `p` quantile (0..1) of `values` by linear interpolation; null for an empty list. */
export function quantile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const v = [...values].sort((a, b) => a - b);
  const pos = (v.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return v[lo]! + (v[hi]! - v[lo]!) * (pos - lo);
}

const sum = (v: readonly number[]): number => v.reduce((a, b) => a + b, 0);

export interface GroupStats {
  label: string;
  coins: number;
  candlesDone: number;
  screenedOut: number;
  light: number;
  full: number;
  otherPath: number;
  unitsMedian: number | null;
  unitsMean: number | null;
  unitsTotal: number;
  poolListNeeded: number;
  poolListKnown: number;
  metricsDone: number;
  athListed: number;
  /** Coins with an ATH and a Dune peak: the ones the ratio is taken over. */
  compared: number;
  ratioP10: number | null;
  ratioMedian: number | null;
  ratioP90: number | null;
  outside: ReportCoin[];
  namedPool: number;
  namedPoolKnown: number;
}

export const ratioOf = (c: ReportCoin): number | null =>
  c.ath !== null && c.peakP999 !== null && c.peakP999 > 0 ? c.ath / c.peakP999 : null;

export function groupStats(label: string, members: readonly ReportCoin[]): GroupStats {
  const done = members.filter((c) => c.candles === 'done');
  const path = (p: string) => done.filter((c) => c.detail?.path === p).length;
  const units = done.flatMap((c) => (typeof c.detail?.units === 'number' ? [c.detail.units] : []));
  const known = done.filter(
    (c) => c.detail?.launchInfoNamedPool !== undefined && c.detail.launchInfoNamedPool !== null,
  );
  const metricsDone = members.filter((c) => c.metrics === 'done');
  const compared = members.flatMap((c) => {
    const r = ratioOf(c);
    return r === null ? [] : [{ c, r }];
  });
  const ratios = compared.map((x) => x.r);
  return {
    label,
    coins: members.length,
    candlesDone: done.length,
    screenedOut: path('screened_out'),
    light: path('light'),
    full: path('full'),
    otherPath: done.length - path('screened_out') - path('light') - path('full'),
    unitsMedian: quantile(units, 0.5),
    unitsMean: units.length === 0 ? null : sum(units) / units.length,
    unitsTotal: sum(units),
    poolListNeeded: known.filter((c) => c.detail!.launchInfoNamedPool === false).length,
    poolListKnown: known.length,
    metricsDone: metricsDone.length,
    athListed: metricsDone.filter((c) => c.ath !== null && c.ath >= ATH_LISTING_USD).length,
    compared: compared.length,
    ratioP10: quantile(ratios, 0.1),
    ratioMedian: quantile(ratios, 0.5),
    ratioP90: quantile(ratios, 0.9),
    outside: compared.filter((x) => x.r < RATIO_LOW || x.r > RATIO_HIGH).map((x) => x.c),
    namedPool: known.filter((c) => c.detail!.launchInfoNamedPool === true).length,
    namedPoolKnown: known.length,
  };
}

/** Overall, then each cell in order, then each half-year in order. */
export function allGroups(coins: readonly ReportCoin[]): {
  overall: GroupStats;
  byCell: GroupStats[];
  byHalf: GroupStats[];
} {
  const cells = [
    ...CELLS,
    ...new Set(coins.map((c) => c.cell).filter((c) => !CELLS.includes(c as never))),
  ];
  const halves = [...new Set(coins.map((c) => c.halfYear))].sort();
  return {
    overall: groupStats('all', coins),
    byCell: cells
      .filter((cell) => coins.some((c) => c.cell === cell))
      .map((cell) =>
        groupStats(
          cell === '' ? '(no cell)' : cell,
          coins.filter((c) => c.cell === cell),
        ),
      ),
    byHalf: halves.map((h) =>
      groupStats(
        h === '' ? '(no half-year)' : h,
        coins.filter((c) => c.halfYear === h),
      ),
    ),
  };
}

// ------------------------------------------------------------------ formatting

const n0 = (x: number): string => Math.round(x).toLocaleString('en-US');
const n1 = (x: number | null): string => (x === null ? 'n/a' : x.toFixed(1));
const n2 = (x: number | null): string => (x === null ? 'n/a' : x.toFixed(2));
const usd = (x: number | null): string => (x === null ? 'n/a' : `$${n0(x)}`);
const share = (a: number, b: number): string =>
  b === 0 ? 'n/a' : `${a}/${b} (${((a / b) * 100).toFixed(1)}%)`;

function table(header: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n');
}

export function buildReport(d: ReportData): string {
  const g = allGroups(d.coins);
  const all = [g.overall, ...g.byCell, ...g.byHalf];
  const out: string[] = [];
  out.push('# Sample run report');
  out.push(
    `Sample file: \`${d.sampleFile}\`. ${d.coins.length} coins; ${d.coins.filter((c) => c.inDatabase).length} in the database. ` +
      `Read ${d.generatedAt.toISOString()}.`,
  );

  out.push('## Stage status');
  const statuses = ['done', 'skipped', 'failed', 'running', 'pending', 'missing'] as const;
  const stageNames: StageName[] = ['discovered', 'metadata', 'metadata_file', 'candles', 'metrics'];
  out.push(
    table(
      ['stage', ...statuses],
      stageNames.map((s) => [
        s,
        ...statuses.map((st) =>
          String(d.stages.find((r) => r.stage === s && r.status === st)?.coins ?? 0),
        ),
      ]),
    ),
  );
  const candlesDone = g.overall.candlesDone;
  const metricsDone = g.overall.metricsDone;
  const total = d.coins.length;
  const pct = (a: number) => (total === 0 ? 'n/a' : `${((a / total) * 100).toFixed(1)}%`);
  out.push(
    `Candles done for ${candlesDone} of ${total} coins (${pct(candlesDone)}); metrics done for ${metricsDone} (${pct(metricsDone)}). ` +
      'The acceptance line is 98% for both, with a reason recorded for each of the rest.',
  );

  out.push('## Failures by reason');
  out.push(
    d.failures.length === 0
      ? 'None.'
      : table(
          ['stage', 'status', 'reason', 'coins'],
          d.failures.map((f) => [f.stage, f.status, f.reason, String(f.coins)]),
        ),
  );

  out.push('## Candles: path, units and pool-list lookup');
  out.push(
    'Overall, by cell and by half-year. Path and units are from the candles stage detail, over coins whose candles are done. ' +
      '"Pool list needed" is the share of coins whose launch info did not name the graduation pool at stage 0.',
  );
  out.push(
    table(
      [
        'group',
        'coins',
        'candles done',
        'screened out',
        'light',
        'full',
        'units median',
        'units mean',
        'units total',
        'pool list needed',
        'ATH >= $100k',
      ],
      all.map((s) => [
        s.label,
        String(s.coins),
        String(s.candlesDone),
        String(s.screenedOut),
        String(s.light),
        String(s.full),
        n1(s.unitsMedian),
        n1(s.unitsMean),
        n0(s.unitsTotal),
        share(s.poolListNeeded, s.poolListKnown),
        share(s.athListed, s.metricsDone),
      ]),
    ),
  );
  out.push(
    '"ATH >= $100k" is over coins whose metrics are done. A coin with no ATH (screened out, or no qualifying window) is below it.',
  );

  out.push('## ATH against the Dune hourly peak');
  out.push(
    'Ratio = our ATH market cap / `peak_p999_usd`. Coins with no ATH are not listed and are left out. ' +
      `"Outside" is a ratio under ${RATIO_LOW} or over ${RATIO_HIGH}.`,
  );
  out.push(
    table(
      ['group', 'compared', 'p10', 'median', 'p90', 'outside 0.5 to 3'],
      all.map((s) => [
        s.label,
        String(s.compared),
        n2(s.ratioP10),
        n2(s.ratioMedian),
        n2(s.ratioP90),
        String(s.outside.length),
      ]),
    ),
  );
  const outside = g.overall.outside.map((c) => ({ c, r: ratioOf(c)! })).sort((a, b) => a.r - b.r);
  out.push('### Every coin outside 0.5 to 3');
  out.push(
    outside.length === 0
      ? 'None.'
      : table(
          ['mint', 'cell', 'half-year', 'ATH', 'Dune peak', 'ratio'],
          outside.map(({ c, r }) => [
            `\`${c.mint}\``,
            c.cell,
            c.halfYear,
            usd(c.ath),
            usd(c.peakP999),
            n2(r),
          ]),
        ),
  );

  out.push('## Launch info named the graduation pool, by half-year');
  out.push(
    'Share of coins (candles done, first fetch in a recorded run) where launch info named the graduation pool, so the pool list was not needed at stage 0.',
  );
  out.push(
    table(
      ['half-year', 'named', 'known', 'share'],
      g.byHalf.map((s) => [
        s.label,
        String(s.namedPool),
        String(s.namedPoolKnown),
        s.namedPoolKnown === 0 ? 'n/a' : `${((s.namedPool / s.namedPoolKnown) * 100).toFixed(1)}%`,
      ]),
    ),
  );

  out.push('## Metric flags (coins)');
  const flagCounts = new Map<string, number>();
  for (const c of d.coins)
    for (const f of new Set(c.flags)) flagCounts.set(f, (flagCounts.get(f) ?? 0) + 1);
  out.push(
    flagCounts.size === 0
      ? 'None.'
      : table(
          ['flag', 'coins'],
          [...flagCounts]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .map(([f, c]) => [f, String(c)]),
        ),
  );

  out.push('## Open data issues');
  out.push(
    d.issues.length === 0
      ? 'None.'
      : table(
          ['kind', 'coins', 'issues'],
          d.issues.map((i) => [i.kind, String(i.coins), String(i.issues)]),
        ),
  );

  out.push('## Coin status');
  const statusCounts = new Map<string, number>();
  for (const c of d.coins.filter((x) => x.inDatabase)) {
    const s = c.coinStatus ?? 'unknown';
    statusCounts.set(s, (statusCounts.get(s) ?? 0) + 1);
  }
  out.push(
    table(
      ['status', 'coins'],
      ['alive', 'dead', 'rugged', 'unknown'].map((s) => [s, String(statusCounts.get(s) ?? 0)]),
    ),
  );

  out.push('## Speed and cost');
  const estimate = estimateCandleUnits(
    d.coins.map((c) => ({ halfYear: c.halfYear, cell: c.cell, probe: c.probe })),
  );
  const minutes = d.runs.seconds / 60;
  out.push(
    table(
      ['measure', 'value'],
      [
        ['runs with the candles stage', String(d.runs.count)],
        ['run time, all those runs', `${minutes.toFixed(1)} minutes`],
        [
          'coins a minute (candles done / run time)',
          minutes > 0 ? (candlesDone / minutes).toFixed(1) : 'n/a',
        ],
        ['units, summed from coin details', n0(g.overall.unitsTotal)],
        ['units, provider usage (all those runs)', n0(d.runs.codexUnits)],
        ['units, estimate for the whole sample', n0(estimate.totalUnits)],
        [
          'actual (details) against estimate',
          estimate.totalUnits > 0
            ? `${((g.overall.unitsTotal / estimate.totalUnits) * 100).toFixed(1)}%`
            : 'n/a',
        ],
      ],
    ),
  );
  out.push(
    'The detail total leaves out coins stopped part-way and units spent before a restart; provider usage counts every request of the runs.',
  );
  return `${out.join('\n\n')}\n`;
}

// ------------------------------------------------------------------ database

interface StageInfo {
  status: string;
  detail: unknown;
}

export async function loadReportData(
  db: Kysely<Database>,
  sample: ParsedSample,
  sampleFile: string,
  now: Date = new Date(),
): Promise<ReportData> {
  const addresses = sample.coins.map((c) => c.address);
  const byAddress = new Map<
    string,
    { ath: number | null; flags: string[]; status: string; id: number }
  >();
  const candles = new Map<string, StageInfo>();
  const metrics = new Map<string, StageInfo>();
  for (let i = 0; i < addresses.length; i += 5000) {
    const chunk = addresses.slice(i, i + 5000);
    const coins = await db
      .selectFrom('coins')
      .select(['id', 'address', 'ath_market_cap_usd', 'metric_flags', 'status'])
      .where('chain', '=', 'solana')
      .where('address', 'in', chunk)
      .execute();
    for (const c of coins) {
      byAddress.set(c.address, {
        id: c.id,
        ath: c.ath_market_cap_usd === null ? null : Number(c.ath_market_cap_usd),
        flags: c.metric_flags,
        status: c.status,
      });
    }
    const stages = await db
      .selectFrom('coin_stages as s')
      .innerJoin('coins', 'coins.id', 's.coin_id')
      .select(['coins.address', 's.stage', 's.status', 's.detail'])
      .where('s.stage', 'in', ['candles', 'metrics'])
      .where('coins.chain', '=', 'solana')
      .where('coins.address', 'in', chunk)
      .execute();
    for (const s of stages) {
      (s.stage === 'candles' ? candles : metrics).set(s.address, {
        status: s.status,
        detail: s.detail,
      });
    }
  }

  const coins: ReportCoin[] = sample.coins.map((c) => {
    const info = sample.info.get(c.address);
    const row = byAddress.get(c.address);
    const detail = candles.get(c.address)?.detail;
    return {
      mint: c.address,
      halfYear: info?.halfYear ?? '',
      cell: info?.cell ?? '',
      probe: info?.probe ?? false,
      peakP999: c.roughAthMarketCapUsd,
      inDatabase: row !== undefined,
      candles: candles.get(c.address)?.status ?? 'missing',
      metrics: metrics.get(c.address)?.status ?? 'missing',
      detail: detail && typeof detail === 'object' ? (detail as ReportCoin['detail']) : null,
      ath: row?.ath ?? null,
      flags: row?.flags ?? [],
      coinStatus: row?.status ?? null,
    };
  });

  const stageNames: StageName[] = ['discovered', 'metadata', 'metadata_file', 'candles', 'metrics'];
  const runs = await sql<{ n: string; seconds: string | null; units: string | null }>`
    select count(*)::text as n,
      sum(extract(epoch from (r.finished_at - r.started_at)))::text as seconds,
      (select coalesce(sum(u.units), 0)::text from provider_usage u
         where u.provider = 'codex' and u.run_id in (select id from ingest_runs where kind = 'ingest-sample'
           and params -> 'stages' ? 'candles' and started_at is not null and finished_at is not null)) as units
    from ingest_runs r
    where r.kind = 'ingest-sample' and r.params -> 'stages' ? 'candles'
      and r.started_at is not null and r.finished_at is not null
  `.execute(db);
  const r = runs.rows[0];
  return {
    sampleFile,
    coins,
    stages: await countStages(db, stageNames, addresses),
    failures: await groupStageFailures(db, stageNames, addresses),
    issues: await countOpenIssues(db, addresses),
    runs: {
      count: Number(r?.n ?? 0),
      seconds: Number(r?.seconds ?? 0),
      codexUnits: Number(r?.units ?? 0),
    },
    generatedAt: now,
  };
}
