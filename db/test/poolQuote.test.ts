import { describe, expect, it } from 'vitest';
import { OTHER_POOL_QUOTE, poolCountsForMetrics } from '../src/poolQuote.js';

describe('poolCountsForMetrics', () => {
  const side = (quoteToken: string | null) =>
    poolCountsForMetrics({ isPrimary: false, quoteToken });

  it('always counts a primary pool, whatever its quote', () => {
    expect(poolCountsForMetrics({ isPrimary: true, quoteToken: null })).toBe(true);
    expect(poolCountsForMetrics({ isPrimary: true, quoteToken: 'BONK' })).toBe(true);
  });

  it('counts a side pool quoted in SOL, USDC or USDT by address or symbol', () => {
    for (const q of [...Object.keys(OTHER_POOL_QUOTE), ...Object.values(OTHER_POOL_QUOTE)]) {
      expect(side(q)).toBe(true);
    }
    expect(side('  SOL\n')).toBe(true);
  });

  it('leaves out other quotes, other cases and a missing quote', () => {
    for (const q of ['BONK', 'sol', 'Usdc', 'SOL2', '', null, 'MemeQuoteToken1111111111']) {
      expect(side(q)).toBe(false);
    }
  });
});
