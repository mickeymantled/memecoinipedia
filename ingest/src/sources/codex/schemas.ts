import { z } from 'zod';

/**
 * Codex sends some numbers as JSON numbers and some as strings (liquidity,
 * volume, compute units). This accepts either, turns it into a number, and
 * passes null through.
 */
const numLike = z.union([z.number(), z.string(), z.null()]).transform((v, ctx) => {
  if (v === null) return null;
  const n = typeof v === 'number' ? v : v.trim() === '' ? Number.NaN : Number(v);
  if (!Number.isFinite(n)) {
    ctx.addIssue({ code: 'custom', message: `not a finite number: ${String(v).slice(0, 40)}` });
    return z.NEVER;
  }
  return n;
});

const nullableString = z.string().nullable().optional();

export const launchpadSchema = z
  .object({
    launchpadName: nullableString,
    migrated: z.boolean().nullable().optional(),
    migratedAt: z.number().nullable().optional(),
    migratedPoolAddress: nullableString,
    completed: z.boolean().nullable().optional(),
    completedAt: z.number().nullable().optional(),
    poolAddress: nullableString,
  })
  .nullable()
  .optional();

export const tokenSchema = z.object({
  address: z.string(),
  symbol: nullableString,
  name: nullableString,
  createdAt: z.number().nullable().optional(),
  creatorAddress: nullableString,
  launchpad: launchpadSchema,
});

export const usageSchema = z
  .object({
    total: z.object({ computeUnits: numLike.optional() }).nullable().optional(),
  })
  .nullable()
  .optional();

export const filterTokensDataSchema = z.object({
  filterTokens: z
    .object({
      count: z.number().nullable().optional(),
      page: z.number().nullable().optional(),
      results: z
        .array(
          z.object({
            token: tokenSchema,
            pair: z.object({ address: z.string() }).nullable().optional(),
            liquidity: numLike.optional(),
          }),
        )
        .nullable(),
    })
    .nullable(),
  usageData: usageSchema,
});

export const tokenDataSchema = z.object({
  token: tokenSchema.nullable(),
  usageData: usageSchema,
});

export const pairsDataSchema = z.object({
  listPairsWithMetadataForToken: z
    .object({
      results: z
        .array(
          z.object({
            liquidity: numLike.optional(),
            volume: numLike.optional(),
            quoteToken: nullableString,
            backingToken: z
              .object({ address: nullableString, symbol: nullableString })
              .nullable()
              .optional(),
            exchange: z.object({ name: nullableString }).nullable().optional(),
            pair: z.object({
              address: z.string(),
              createdAt: z.number().nullable().optional(),
              protocol: nullableString,
              exchangeHash: nullableString,
              token0: nullableString,
              token1: nullableString,
            }),
          }),
        )
        .nullable(),
    })
    .nullable(),
  usageData: usageSchema,
});

/**
 * Bar columns are lenient: the strings "NaN", "Infinity" and "" (the live API sent
 * "NaN" in a liquidity column, found while fetching candles for FARTCOIN and
 * GOAT) become null instead of failing the whole response; any other text that
 * is not a number still fails it. A null
 * price drops that bar (`barsFromColumns`), a null liquidity means unknown.
 */
const barNum = z.union([z.number(), z.string(), z.null()]).transform((v, ctx): number | null => {
  if (v === null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const text = v.trim();
  // The strings the API is known to send for "no value". Anything else must be a number.
  if (/^(|nan|[+-]?infinity)$/i.test(text)) return null;
  const n = Number(text);
  if (!Number.isFinite(n)) {
    ctx.addIssue({ code: 'custom', message: `not a number: ${text.slice(0, 40)}` });
    return z.NEVER;
  }
  return n;
});
const numColumn = z.array(barNum).optional();

/** getBars returns parallel columns, one entry per bucket. */
export const barsColumnsSchema = z.object({
  t: z.array(z.number().nullable()),
  o: z.array(barNum),
  h: z.array(barNum),
  l: z.array(barNum),
  c: z.array(barNum),
  volume: numColumn,
  buyers: numColumn,
  sellers: numColumn,
  buys: numColumn,
  sells: numColumn,
  traders: numColumn,
  transactions: numColumn,
  liquidity: numColumn,
  s: z.unknown().optional(),
});
export type BarsColumns = z.infer<typeof barsColumnsSchema>;

export const barsDataSchema = z.object({
  getBars: barsColumnsSchema.nullable(),
  usageData: usageSchema,
});

export const graphqlEnvelopeSchema = z.object({
  data: z.unknown().nullable().optional(),
  errors: z
    .array(
      z.object({
        message: z.string(),
        extensions: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .optional(),
});
