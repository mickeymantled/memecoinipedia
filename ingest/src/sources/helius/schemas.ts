import { z } from 'zod';

/** JSON-RPC envelope. `result` is checked per method. */
export const rpcEnvelopeSchema = z.object({
  result: z.unknown().optional(),
  error: z.object({ code: z.number().optional(), message: z.string().optional() }).nullish(),
});

const onChainMetadata = z.object({
  name: z.string().nullish(),
  symbol: z.string().nullish(),
});

/** One DAS asset. Only the fields we read; everything is optional because layouts differ. */
export const assetSchema = z.object({
  id: z.string(),
  interface: z.string().nullish(),
  content: z
    .object({
      json_uri: z.string().nullish(),
      metadata: onChainMetadata.nullish(),
    })
    .nullish(),
  token_info: z
    .object({
      symbol: z.string().nullish(),
      supply: z.number().nullish(),
      decimals: z.number().nullish(),
      token_program: z.string().nullish(),
    })
    .nullish(),
  /** Token-2022 mint extensions. `metadata` is the on-mint metadata. */
  mint_extensions: z
    .object({
      metadata: onChainMetadata.extend({ uri: z.string().nullish() }).nullish(),
    })
    .nullish(),
});

/**
 * Only the array is checked here. Each row is checked on its own with `assetSchema`,
 * so one unreadable row does not fail the batch. A missing or non-token account
 * comes back as null.
 */

export const assetBatchResultSchema = z.array(z.unknown());

const accountKey = z.union([
  z.string(),
  z.object({ pubkey: z.string(), signer: z.boolean().optional() }),
]);

export const transactionRowSchema = z.object({
  slot: z.number(),
  blockTime: z.number().nullish(),
  meta: z.object({ err: z.unknown().nullish() }).nullish(),
  transaction: z.object({
    signatures: z.array(z.string()).min(1),
    message: z.object({ accountKeys: z.array(accountKey) }),
  }),
});

export const transactionsForAddressResultSchema = z.object({
  data: z.array(transactionRowSchema),
  paginationToken: z.string().nullish(),
});
