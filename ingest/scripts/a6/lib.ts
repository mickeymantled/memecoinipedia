/**
 * Shared helpers for the A6a outlier review: read the per-coin JSON files made by
 * dump-coins.ts, read the review list and the Dune sample, and rebuild a metric input.
 * Nothing here touches the database or the network.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Bar, MetricInput, PoolSeries } from '../../src/metrics/types.js';

export const SUPPLY = 1_000_000_000;

export interface ReviewRow {
  mint: string;
  groups: string[];
  cell: string;
  half_year: string;
  probe: boolean;
  path: string;
  ath_usd: number;
  wick_usd: number;
  dune_p999_usd: number;
  dune_hours: number;
  ratio: number;
  status: string;
  flags: string;
  issues: string;
  pools: number;
}

export interface DuneRow {
  mint: string;
  hours: number;
  peak_max_usd: number;
  peak_p999_usd: number;
  peak_at: string;
}

export interface CoinDump {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  coin: Record<string, any>;
  pools: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    pool: Record<string, any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    coverage: Record<string, any>[];
    bars: Record<'60' | '3600' | '86400', Bar[]>;
  }[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stages: Record<string, any>[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  issues: Record<string, any>[];
}

export function parseCsv(text: string): Record<string, string>[] {
  const [head, ...rows] = text.trim().split(/\r?\n/);
  const cols = head!.split(',');
  return rows.map((r) => {
    const cells = r.split(',');
    return Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? '']));
  });
}

export async function readReviewList(path: string): Promise<ReviewRow[]> {
  return parseCsv(await readFile(path, 'utf8')).map((r) => ({
    mint: r['mint']!,
    groups: r['groups']!.split('|'),
    cell: r['cell']!,
    half_year: r['half_year']!,
    probe: r['probe'] === 'true',
    path: r['path']!,
    ath_usd: Number(r['ath_usd']),
    wick_usd: Number(r['wick_usd']),
    dune_p999_usd: Number(r['dune_p999_usd']),
    dune_hours: Number(r['dune_hours']),
    ratio: Number(r['ratio']),
    status: r['status']!,
    flags: r['flags']!,
    issues: r['issues']!,
    pools: Number(r['pools']),
  }));
}

export async function readDune(path: string): Promise<Map<string, DuneRow>> {
  const m = new Map<string, DuneRow>();
  for (const r of parseCsv(await readFile(path, 'utf8'))) {
    m.set(r['mint']!, {
      mint: r['mint']!,
      hours: Number(r['hours']),
      peak_max_usd: Number(r['peak_max_usd']),
      peak_p999_usd: Number(r['peak_p999_usd']),
      peak_at: r['peak_at']!,
    });
  }
  return m;
}

export async function readDump(cacheDir: string, mint: string): Promise<CoinDump> {
  return JSON.parse(await readFile(join(cacheDir, `${mint}.json`), 'utf8')) as CoinDump;
}

/** The input the metrics stage builds: every stored bar up to asOf (the stored metrics_as_of). */
export function toMetricInput(d: CoinDump): MetricInput {
  const asOf = Math.floor(new Date(d.coin['metrics_as_of'] as string).getTime() / 1000);
  const pools: PoolSeries[] = d.pools.map((p) => ({
    address: p.pool['address'] as string,
    dex: p.pool['dex'] as string,
    isPrimary: p.pool['is_primary'] as boolean,
    bars1m: p.bars['60'].filter((b) => b.t <= asOf),
    bars1h: p.bars['3600'].filter((b) => b.t <= asOf),
    bars1d: p.bars['86400'].filter((b) => b.t <= asOf),
  }));
  return {
    totalSupply: Number(d.coin['total_supply']),
    launchedAt: new Date(d.coin['launched_at'] as string).getTime() / 1000,
    asOf,
    pools,
  };
}

export const iso = (t: number): string => new Date(t * 1000).toISOString().slice(0, 16) + 'Z';
export const usd = (n: number | null | undefined): string =>
  n === null || n === undefined ? 'n/a' : '$' + Math.round(n).toLocaleString('en-US');
