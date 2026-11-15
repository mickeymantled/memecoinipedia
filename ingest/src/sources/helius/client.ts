/**
 * Helius client: DAS `getAssetBatch` for on-chain token metadata, and
 * `getTransactionsForAddress` to find the transaction that created a mint.
 *
 * The API key goes in the `x-api-key` header, never in the URL. (Helius's
 * docs show only `?api-key=`; the header was checked live on 2026-11-15 and
 * works on this key.) Even so, every error that leaves this client has the key,
 * and any `api-key=...` text, scrubbed from its message and body snippet.
 *
 * Credits are metered from a per-method table (costs.ts) through `UnitBudget`,
 * the same way the Codex client does it: reserve before the call, then record
 * one entry per HTTP attempt. Failed attempts are charged in full.
 */
import { UnitBudget, type SpendEntry } from '../budget.js';
import { HttpError, postJson, type FetchLike, type PostJsonOptions } from '../http.js';
import type { RateLimiter } from '../ratelimit.js';
import {
  GET_ASSET_BATCH_CREDITS,
  HELIUS_PROVIDER,
  MAX_ASSETS_PER_REQUEST,
  transactionsForAddressCredits,
  type HeliusMethod,
} from './costs.js';
import {
  assetBatchResultSchema,
  assetSchema,
  rpcEnvelopeSchema,
  transactionsForAddressResultSchema,
} from './schemas.js';
import type { z } from 'zod';

export const HELIUS_ENDPOINT = 'https://mainnet.helius-rpc.com/';

export const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

/** The JSON-RPC server answered with an error object. */
export class HeliusRpcError extends Error {
  readonly method: string;
  readonly code: number | null;

  constructor(method: string, code: number | null, message: string) {
    super(`Helius ${method} error${code === null ? '' : ` ${code}`}: ${message}`);
    this.name = 'HeliusRpcError';
    this.method = method;
    this.code = code;
  }
}

/** The response was not JSON, or did not match the expected shape. */
export class HeliusResponseError extends Error {
  readonly method: string;
  readonly issues: string[];

  constructor(method: string, issues: string[]) {
    super(`Unexpected Helius response for ${method}: ${issues.slice(0, 5).join('; ')}`);
    this.name = 'HeliusResponseError';
    this.method = method;
    this.issues = issues;
  }
}

export type TokenProgramKind = 'spl-token' | 'token-2022' | 'other';
export type MetadataLayout = 'metaplex' | 'token-2022-extension';

export interface AssetInfo {
  mint: string;
  /** False when Helius has no asset for the address (it answers null) or the address is not a token. */
  found: boolean;
  name: string | null;
  symbol: string | null;
  /** The metadata URI written on chain. */
  uri: string | null;
  /** Which on-chain layout the name, symbol and URI came from. */
  layout: MetadataLayout | null;
  tokenProgram: TokenProgramKind | null;
  tokenProgramId: string | null;
  decimals: number | null;
  /** Raw units, as a decimal string. Helius sends a JSON number, so it is exact only below 2^53. */
  supply: string | null;
  /** DAS `interface`, for example `FungibleToken`. */
  assetInterface: string | null;
  /**
   * Null for a good row. When Helius returned a row for this mint that did not match the
   * expected shape, `found` is true, every other field is null, and this lists the issues.
   */
  invalid: string[] | null;
}

export interface CreateEvent {
  status: 'resolved';
  mint: string;
  signature: string;
  slot: number;
  /** Unix seconds, or null when the node has no block time. */
  blockTime: number | null;
  /**
   * The wallet that signed and paid for the create transaction: the first
   * account of the transaction, which is its fee payer and a signer. The mint
   * itself must also be a signer of that transaction (a new mint's keypair
   * signs its own creation); a first transaction without that is not accepted.
   * The fee payer is not always the creator pump.fun records (its create event has its
   * own creator field); where the two differ, that field is the authority. All 20 probe
   * coins agree.
   */
  creator: string;
  requests: number;
  credits: number;
}

export type UnresolvedReason =
  /** The mint address appears in no succeeded transaction. */
  | 'no_transactions'
  /** Transactions were found, but none is a creation inside the request bound. */
  | 'no_create_in_bound';

export interface UnresolvedCreateEvent {
  status: 'unresolved';
  mint: string;
  reason: UnresolvedReason;
  requests: number;
  credits: number;
}

export type CreateEventResult = CreateEvent | UnresolvedCreateEvent | { status: 'dry_run' };

export interface HeliusPlannedCall {
  method: HeliusMethod;
  credits: number;
  detail: string;
}

export interface HeliusDryRunPlan {
  calls: HeliusPlannedCall[];
  byMethod: Record<string, { requests: number; credits: number }>;
  totalRequests: number;
  totalCredits: number;
  /** Methods whose request count is a lower bound: `getCreateEvent` may use up to `maxRequests` per coin. */
  lowerBoundMethods: HeliusMethod[];
}

export interface HeliusClientOptions {
  apiKey: string;
  fetch?: FetchLike;
  limiter?: RateLimiter;
  budget?: UnitBudget;
  endpoint?: string;
  dryRun?: boolean;
  /** Hard bound on HTTP requests (retries included) per `getCreateEvent` call. Default 3. */
  maxCreateEventRequests?: number;
  /** Transactions asked for per page by `getCreateEvent`. Default 3, at most 100 (one 10-credit block). */
  createEventPageSize?: number;
  /** Overrides for timeout, retries, backoff, sleep and jitter. */
  http?: Omit<PostJsonOptions, 'fetch' | 'headers'>;
}

const issueList = (error: z.ZodError): string[] =>
  error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);

function programKind(id: string | null): TokenProgramKind | null {
  if (id === null) return null;
  if (id === SPL_TOKEN_PROGRAM) return 'spl-token';
  if (id === TOKEN_2022_PROGRAM) return 'token-2022';
  return 'other';
}

/** Metadata strings on chain are padded with NUL characters. */
const clean = (s: string | null | undefined): string | null =>
  typeof s === 'string' ? s.replaceAll('\u0000', '') : null;

type RawAsset = z.infer<typeof assetSchema>;

function assetInfoFrom(
  mint: string,
  a: RawAsset | undefined,
  invalid: string[] | null = null,
): AssetInfo {
  if (!a) {
    return {
      mint,
      found: invalid !== null,
      name: null,
      symbol: null,
      uri: null,
      layout: null,
      tokenProgram: null,
      tokenProgramId: null,
      decimals: null,
      supply: null,
      assetInterface: null,
      invalid,
    };
  }
  const ext = a.mint_extensions?.metadata;
  const programId = a.token_info?.token_program ?? null;
  // Token-2022 coins made with create_v2 keep their metadata on the mint itself.
  // Classic coins keep it in the Metaplex metadata account, which DAS exposes as content.
  const useExtension = ext != null && (ext.name != null || ext.symbol != null || ext.uri != null);
  const supply = a.token_info?.supply;
  return {
    mint,
    found: true,
    name: clean(useExtension ? ext.name : a.content?.metadata?.name),
    symbol: clean(
      useExtension ? ext.symbol : (a.content?.metadata?.symbol ?? a.token_info?.symbol),
    ),
    uri: clean(useExtension ? ext.uri : a.content?.json_uri),
    layout: useExtension ? 'token-2022-extension' : a.content?.metadata ? 'metaplex' : null,
    tokenProgram: programKind(programId),
    tokenProgramId: programId,
    decimals: a.token_info?.decimals ?? null,
    supply:
      typeof supply === 'number' && Number.isFinite(supply)
        ? BigInt(Math.trunc(supply)).toString()
        : null,
    assetInterface: a.interface ?? null,
    invalid: null,
  };
}

interface CallSpec {
  method: HeliusMethod;
  params: unknown;
  credits: number;
  detail: string;
  /** Most HTTP attempts this call may make, retries included. */
  maxAttempts?: number;
}

export class HeliusClient {
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly limiter: RateLimiter | undefined;
  readonly budget: UnitBudget;
  private readonly endpoint: string;
  readonly dryRun: boolean;
  private readonly maxCreateEventRequests: number;
  private readonly createEventPageSize: number;
  private readonly httpOptions: Omit<PostJsonOptions, 'fetch' | 'headers'>;
  private readonly planned: HeliusPlannedCall[] = [];
  private readonly lowerBound = new Set<HeliusMethod>();
  private rpcId = 0;

  constructor(opts: HeliusClientOptions) {
    if (opts.apiKey === '') throw new Error('Helius apiKey is empty');
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch;
    this.limiter = opts.limiter;
    this.budget = opts.budget ?? new UnitBudget();
    this.endpoint = opts.endpoint ?? HELIUS_ENDPOINT;
    this.dryRun = opts.dryRun ?? false;
    this.maxCreateEventRequests = opts.maxCreateEventRequests ?? 3;
    this.createEventPageSize = opts.createEventPageSize ?? 3;
    if (!Number.isInteger(this.maxCreateEventRequests) || this.maxCreateEventRequests < 1) {
      throw new RangeError('maxCreateEventRequests must be a positive integer');
    }
    if (
      !Number.isInteger(this.createEventPageSize) ||
      this.createEventPageSize < 1 ||
      this.createEventPageSize > 100
    ) {
      throw new RangeError('createEventPageSize must be between 1 and 100');
    }
    this.httpOptions = opts.http ?? {};
  }

  /** Requests, credits and ceiling so far (all estimated: Helius does not report cost). */
  spend() {
    return this.budget.summary(HELIUS_PROVIDER);
  }

  /** What a dry run would have called. Empty when not in dry-run mode. */
  plan(): HeliusDryRunPlan {
    const byMethod: Record<string, { requests: number; credits: number }> = {};
    let totalCredits = 0;
    for (const c of this.planned) {
      const entry = (byMethod[c.method] ??= { requests: 0, credits: 0 });
      entry.requests += 1;
      entry.credits += c.credits;
      totalCredits += c.credits;
    }
    return {
      calls: [...this.planned],
      byMethod,
      totalRequests: this.planned.length,
      totalCredits,
      lowerBoundMethods: [...this.lowerBound],
    };
  }

  /**
   * On-chain metadata for each mint, in input order (duplicates removed).
   * Requests are split at 1,000 mints, 10 credits each. A mint Helius has no
   * asset for is `found: false`. A row that comes back but does not match the expected shape
   * is `found: true` with every other field null and `invalid` listing the issues. A row
   * without a string `id` cannot be matched to a mint, so its mint is `found: false`.
   * Only a response that is not an array at all throws. Returns `[]` in dry-run mode.
   */
  async getAssets(mints: readonly string[]): Promise<AssetInfo[]> {
    const unique = [...new Set(mints)];
    const out: AssetInfo[] = [];
    for (let i = 0; i < unique.length; i += MAX_ASSETS_PER_REQUEST) {
      const batch = unique.slice(i, i + MAX_ASSETS_PER_REQUEST);
      const result = await this.call(
        {
          method: 'getAssetBatch',
          params: { ids: batch },
          credits: GET_ASSET_BATCH_CREDITS,
          detail: `${batch.length} mints`,
        },
        assetBatchResultSchema,
      );
      if (result === null) continue; // dry run
      const byId = new Map<string, RawAsset>();
      const badById = new Map<string, string[]>();
      for (const row of result) {
        const id = (row as { id?: unknown } | null)?.id;
        if (typeof id !== 'string') continue;
        const parsed = assetSchema.safeParse(row);
        if (parsed.success) byId.set(id, parsed.data);
        else badById.set(id, issueList(parsed.error));
      }
      for (const mint of batch) {
        out.push(assetInfoFrom(mint, byId.get(mint), badById.get(mint) ?? null));
      }
    }
    return out;
  }

  /**
   * The transaction that created `mint`, from the chain.
   *
   * Method: `getTransactionsForAddress` on the mint address, oldest first,
   * full transactions, succeeded ones only. The first transaction that has the
   * mint as a signer is the creation (a new mint's keypair signs its own
   * creation; later swaps and transfers only touch the mint as a read-only
   * account). That is one request and 10 credits for up to 100 transactions.
   * If none of the first page qualifies and there is a next page, it asks for
   * it, up to `maxCreateEventRequests` HTTP requests in all, retries included.
   * After that it returns `unresolved`. It never pages further.
   */
  async getCreateEvent(mint: string): Promise<CreateEventResult> {
    const credits = transactionsForAddressCredits(this.createEventPageSize);
    if (this.dryRun) {
      this.lowerBound.add('getTransactionsForAddress');
      this.planned.push({
        method: 'getTransactionsForAddress',
        credits,
        detail: `create event ${mint}`,
      });
      return { status: 'dry_run' };
    }

    let requests = 0;
    let spentCredits = 0;
    let token: string | null = null;
    let sawTransactions = false;
    while (requests < this.maxCreateEventRequests) {
      const filters = { status: 'succeeded' };
      const config: Record<string, unknown> = {
        transactionDetails: 'full',
        sortOrder: 'asc',
        limit: this.createEventPageSize,
        encoding: 'jsonParsed',
        maxSupportedTransactionVersion: 0,
        filters,
      };
      if (token !== null) config['paginationToken'] = token;
      let used = 0;
      const page = await this.call(
        {
          method: 'getTransactionsForAddress',
          params: [mint, config],
          credits,
          detail: `create event ${mint}`,
          maxAttempts: this.maxCreateEventRequests - requests,
        },
        transactionsForAddressResultSchema,
        (attempts) => {
          used = attempts;
        },
      );
      requests += used;
      spentCredits += used * credits;
      if (page === null) break;
      if (page.data.length > 0) sawTransactions = true;

      for (const row of page.data) {
        const keys = row.transaction.message.accountKeys.map((k) =>
          typeof k === 'string' ? { pubkey: k, signer: undefined } : k,
        );
        const payer = keys[0];
        const mintIsSigner = keys.some((k) => k.pubkey === mint && k.signer === true);
        if (mintIsSigner && payer && payer.signer !== false && payer.pubkey !== mint) {
          return {
            status: 'resolved',
            mint,
            signature: row.transaction.signatures[0]!,
            slot: row.slot,
            blockTime: row.blockTime ?? null,
            creator: payer.pubkey,
            requests,
            credits: spentCredits,
          };
        }
      }
      token = page.paginationToken ?? null;
      if (token === null) break;
    }
    return {
      status: 'unresolved',
      mint,
      reason: sawTransactions ? 'no_create_in_bound' : 'no_transactions',
      requests,
      credits: spentCredits,
    };
  }

  // Plumbing ------------------------------------------------------------

  private redact(text: string): string {
    return text
      .replaceAll(this.apiKey, '[redacted]')
      .replace(/api-key=[^&\s"'<>]+/gi, 'api-key=[redacted]');
  }

  /** Runs one JSON-RPC request. Returns null in dry-run mode (after recording the plan). */
  private async call<S extends z.ZodType>(
    spec: CallSpec,
    schema: S,
    onAttempts?: (attempts: number) => void,
  ): Promise<z.infer<S> | null> {
    if (this.dryRun) {
      this.planned.push({ method: spec.method, credits: spec.credits, detail: spec.detail });
      return null;
    }

    // Held until the request settles, so concurrent calls cannot overshoot the ceiling.
    const reservation = this.budget.reserve(HELIUS_PROVIDER, spec.credits);
    let attempts = 1;
    // Cost if the call fails: every attempt is assumed charged (the docs do not say otherwise).
    const charged = (n: number): SpendEntry[] =>
      Array.from({ length: n }, () => ({ units: spec.credits, estimated: true }));

    try {
      const base: FetchLike = this.fetchImpl ?? ((url, init) => fetch(url, init));
      const limiter = this.limiter;
      const limited: FetchLike = limiter ? (url, init) => limiter.run(() => base(url, init)) : base;

      const http = { ...this.httpOptions };
      if (spec.maxAttempts !== undefined) {
        http.maxRetries = Math.min(http.maxRetries ?? 4, spec.maxAttempts - 1);
      }

      let response;
      try {
        response = await postJson(
          this.endpoint,
          { jsonrpc: '2.0', id: ++this.rpcId, method: spec.method, params: spec.params },
          {
            ...http,
            fetch: limited,
            headers: { 'x-api-key': this.apiKey, 'user-agent': 'ingest-client/0.1' },
          },
        );
      } catch (err) {
        if (err instanceof HttpError) {
          attempts = err.attempts;
          throw new HttpError(
            this.redact(err.message),
            err.status,
            err.attempts,
            this.redact(err.bodySnippet),
          );
        }
        throw err;
      }
      attempts = response.attempts;

      let json: unknown;
      try {
        json = JSON.parse(response.body);
      } catch {
        throw new HeliusResponseError(spec.method, ['response was not JSON']);
      }
      const envelope = rpcEnvelopeSchema.safeParse(json);
      if (!envelope.success) throw new HeliusResponseError(spec.method, issueList(envelope.error));
      if (envelope.data.error) {
        throw new HeliusRpcError(
          spec.method,
          envelope.data.error.code ?? null,
          this.redact(envelope.data.error.message ?? 'unknown error'),
        );
      }
      const parsed = schema.safeParse(envelope.data.result);
      if (!parsed.success) throw new HeliusResponseError(spec.method, issueList(parsed.error));

      this.budget.settle(reservation, charged(attempts));
      onAttempts?.(attempts);
      return parsed.data as z.infer<S>;
    } catch (err) {
      this.budget.settle(reservation, charged(attempts));
      onAttempts?.(attempts);
      throw err;
    }
  }
}
