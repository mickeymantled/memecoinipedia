import { describe, expect, it } from 'vitest';
import {
  buildReport,
  groupStats,
  quantile,
  type ReportCoin,
  type ReportData,
} from '../../scripts/lib/sample-report.js';

const coin = (mint: string, extra: Partial<ReportCoin> = {}): ReportCoin => ({
  mint,
  halfYear: '2024-H1',
  cell: '100k-1M',
  probe: false,
  peakP999: 100_000,
  inDatabase: true,
  candles: 'done',
  metrics: 'done',
  detail: { path: 'light', units: 20, launchInfoNamedPool: true },
  ath: 100_000,
  flags: [],
  coinStatus: 'dead',
  ...extra,
});

describe('quantile', () => {
  it('interpolates between ranks and returns null for no values', () => {
    expect(quantile([], 0.5)).toBeNull();
    expect(quantile([7], 0.9)).toBe(7);
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([4, 1, 3, 2], 0.1)).toBeCloseTo(1.3);
    expect(quantile([1, 2, 3, 4, 5], 0.9)).toBeCloseTo(4.6);
  });
});

describe('group statistics', () => {
  it('leaves a coin with no ATH out of the ratio, and lists every coin outside 0.5 to 3', () => {
    const members = [
      coin('A', { ath: 100_000 }), // 1.0
      coin('B', { ath: 40_000 }), // 0.4: outside
      coin('C', { ath: 350_000 }), // 3.5: outside
      coin('D', {
        ath: null,
        detail: { path: 'screened_out', units: 8, launchInfoNamedPool: false },
      }),
      coin('E', { ath: 300_000 }), // 3.0: inside
      coin('F', { candles: 'failed', metrics: 'missing', detail: null, ath: null }),
    ];
    const s = groupStats('x', members);
    expect(s.coins).toBe(6);
    expect(s.candlesDone).toBe(5);
    expect(s.screenedOut).toBe(1);
    expect(s.light).toBe(4);
    expect(s.compared).toBe(4);
    expect(s.outside.map((c) => c.mint)).toEqual(['B', 'C']);
    expect(s.ratioMedian).toBeCloseTo(2);
    expect(s.unitsTotal).toBe(88);
    expect(s.poolListNeeded).toBe(1);
    expect(s.poolListKnown).toBe(5);
    expect(s.metricsDone).toBe(5);
    expect(s.athListed).toBe(3); // B is under $100k and D has no ATH
  });

  it('leaves a coin whose first fetch is not recorded out of the pool-list share', () => {
    const s = groupStats('x', [
      coin('A'),
      coin('B', { detail: { path: 'full', units: 30, launchInfoNamedPool: null } }),
    ]);
    expect(s.poolListKnown).toBe(1);
    expect(s.namedPool).toBe(1);
  });
});

describe('buildReport', () => {
  it('prints the sections for an empty database without failing', () => {
    const data: ReportData = {
      sampleFile: 's.csv',
      coins: [
        coin('A', {
          inDatabase: false,
          candles: 'missing',
          metrics: 'missing',
          detail: null,
          ath: null,
        }),
      ],
      stages: [],
      failures: [],
      issues: [],
      runs: { count: 0, seconds: 0, codexUnits: 0 },
      generatedAt: new Date('2026-11-15T00:00:00Z'),
    };
    const text = buildReport(data);
    for (const h of [
      '## Stage status',
      '## Failures by reason',
      '## Candles: path, units and pool-list lookup',
      '## ATH against the Dune hourly peak',
      '## Launch info named the graduation pool, by half-year',
      '## Speed and cost',
    ]) {
      expect(text).toContain(h);
    }
  });
});
