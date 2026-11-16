import { afterEach, beforeEach, expect, it } from 'vitest';
import { upsertCoin } from '@memecoinipedia/db';
import { createTestDatabase, type TestDatabase } from '@memecoinipedia/db/testing';
import {
  EXHAUSTIVE_PLAN_LIMITS,
  computeMetricsForCoin,
  fetchCandlesForCoin,
  type CandleDeps,
} from '../../src/candles/index.js';
import { UnitBudget } from '../../src/sources/budget.js';
import { CodexClient } from '../../src/sources/codex/index.js';
import { adminUrl, describeDb } from './helpers.js';
import { minute, simProvider, type SimCoin, type SimMinute } from './sim.js';

const DAY = 86_400;
const T0 = 1_767_225_600;
const LAUNCH = T0 + 3 * 3_600;
const GRAD = LAUNCH + 2 * 3_600;
const NOW = GRAD + 6 * DAY;
const mcap = (usd: number): number => usd / 1e9;

let t: TestDatabase;
beforeEach(async () => {
  if (adminUrl) t = await createTestDatabase(adminUrl);
});
afterEach(async () => {
  if (adminUrl) await t.drop();
});

function coinWith(minutes: SimMinute[]): SimCoin {
  const grad = 'C'.repeat(43) + '9';
  return {
    mint: 'D'.repeat(43) + '9',
    createdAt: LAUNCH,
    migratedAt: GRAD,
    migratedPoolAddress: grad,
    pools: [
      {
        address: grad,
        exchange: 'PumpSwap',
        protocol: 'PumpAmm',
        createdAt: GRAD,
        liquidity: 30_000,
        minutes,
      },
    ],
  };
}

async function run(coin: SimCoin, limits?: Parameters<typeof fetchCandlesForCoin>[2]) {
  const id = await upsertCoin(t.db, { chain: 'solana', address: coin.mint, launchpad: 'pump.fun' });
  const sim = simProvider(coin);
  const deps: CandleDeps = {
    db: t.db,
    codex: new CodexClient({
      apiKey: 'test-key-not-real',
      fetch: sim.fetch,
      budget: new UnitBudget(),
      http: { maxRetries: 0, sleep: async () => {} },
    }),
    clock: () => new Date(NOW * 1000),
  };
  const r = await fetchCandlesForCoin(deps, { id, address: coin.mint }, limits);
  const m = await computeMetricsForCoin(deps, { id });
  const row = await t.db
    .selectFrom('coins')
    .select(['ath_market_cap_usd', 'metric_flags'])
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
  // The fetcher returns its issues and writes none; the candles stage records them.
  return { r, m, row, sim, issues: r.summary.issues };
}

/** The USOF shape: a peak inside one hour more than 1,500 minutes after graduation, then a collapse. */
const rug = (): SimMinute[] => [
  // First 100 minutes: $60,000 up to $150,000.
  ...Array.from({ length: 100 }, (_, i) => minute(GRAD + i * 60, mcap(60_000 + i * 900), 3_000)),
  // Hour of day 2 (26 hours in): up to $600,000 in 30 minutes, then $3,000 for 10.
  ...Array.from({ length: 40 }, (_, k) =>
    minute(GRAD + 26 * 3_600 + k * 60, mcap(k < 30 ? 150_000 + k * 15_000 : 3_000), 3_000),
  ),
];

describeDb('refinement by bar highs', () => {
  it('finds a rug peak inside one hour after the first 1,500 minutes, as the exhaustive plan does', async () => {
    const staged = await run(coinWith(rug()));
    expect(staged.r.summary.path).toBe('light');
    expect(staged.r.summary.refinementRounds).toBeGreaterThanOrEqual(1);
    expect(staged.row.metric_flags).not.toContain('peak_outside_minute_coverage');
    // The true ATH: 150,000 + 29 * 15,000 = 585,000 (the 3-minute median of the closes of the last
    // three minutes before the collapse is a little lower).
    expect(staged.row.ath_market_cap_usd).toBeGreaterThan(540_000);
    expect(staged.r.summary.issues).not.toContain('peak_refinement_incomplete');

    const other = await createTestDatabase(adminUrl!);
    try {
      const id = await upsertCoin(other.db, {
        chain: 'solana',
        address: coinWith([]).mint,
        launchpad: 'pump.fun',
      });
      const sim = simProvider(coinWith(rug()));
      const deps: CandleDeps = {
        db: other.db,
        codex: new CodexClient({
          apiKey: 'test-key-not-real',
          fetch: sim.fetch,
          budget: new UnitBudget(),
          http: { maxRetries: 0, sleep: async () => {} },
        }),
        clock: () => new Date(NOW * 1000),
      };
      await fetchCandlesForCoin(
        deps,
        { id, address: coinWith([]).mint },
        { limits: EXHAUSTIVE_PLAN_LIMITS },
      );
      await computeMetricsForCoin(deps, { id });
      const row = await other.db
        .selectFrom('coins')
        .select('ath_market_cap_usd')
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      expect(row.ath_market_cap_usd).toBe(staged.row.ath_market_cap_usd);
    } finally {
      await other.drop();
    }
  });

  it('skips a target whose high is under $90,000: no request, no issue, and the flag stays', async () => {
    const minutes = [
      ...Array.from({ length: 100 }, (_, i) =>
        minute(GRAD + i * 60, mcap(i === 50 ? 95_000 : 60_000), 3_000),
      ),
      // Day 3: an hour at $85,000, above the ATH of $60,000 but under the refine line.
      ...Array.from({ length: 30 }, (_, k) => minute(GRAD + 3 * DAY + k * 60, mcap(85_000), 3_000)),
    ];
    const r = await run(coinWith(minutes));
    expect(r.r.summary.path).toBe('light');
    expect(r.r.summary.refinementRounds).toBe(0);
    expect(r.r.summary.requests).toBe(3); // screen, 1,500 minutes, one hourly window
    expect(r.row.metric_flags).toContain('peak_outside_minute_coverage');
    expect(r.issues).toEqual([]);
  });

  it('records the issue when the cap is hit', async () => {
    const r = await run(coinWith(rug()), { limits: { maxRefinementRequests: 0 } });
    expect(r.r.summary.refinementRounds).toBe(0);
    expect(r.issues).toContain('peak_refinement_incomplete');
    expect(r.row.metric_flags).toContain('peak_outside_minute_coverage');
  });
});
