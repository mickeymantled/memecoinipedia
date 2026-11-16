import type { Selectable } from 'kysely';
import type { CoinsTable } from '@memecoinipedia/db';

/**
 * The per-coin input to the classifier: a compact record rendered as JSON inside
 * a delimited block. This is the only part of a request that varies.
 *
 * Creator-written text (name, ticker, description, socials) and research notes
 * are untrusted. They only ever appear inside the `<coin_record>` block, with
 * `<`, `>` and `&` written as JSON unicode escapes, so no text in the record can
 * close the block or open a tag. The system prompt says the block holds data,
 * not instructions.
 */

export const RECORD_OPEN = '<coin_record>';
export const RECORD_CLOSE = '</coin_record>';

const MAX_DESCRIPTION_CHARS = 1500;
const MAX_SHORT_CHARS = 300;
const MAX_SOCIALS = 12;
const MAX_CANDIDATES = 10;

/** An earlier, larger coin that may be the parent. Filled by task B5. */
export interface ParentCandidate {
  address: string;
  name?: string | null;
  ticker?: string | null;
  launched_at?: string | null;
  ath_market_cap_usd?: number | null;
}

/** A Grok research entry for the coin (/research/narratives schema in AGENTS.md). Optional. */
export interface ResearchEntry {
  origin?: string;
  origin_date?: string;
  trigger_event?: string;
  key_accounts?: string[];
  notes?: string;
  confidence?: number;
}

/** What the builder needs for one coin. Dates are ISO strings or Date. */
export interface CoinInput {
  chain: string;
  address: string;
  name: string | null;
  ticker: string | null;
  description: string | null;
  socials: Record<string, unknown>;
  launched_at: Date | string | null;
  graduated_at: Date | string | null;
  ath_market_cap_usd: number | null;
  ath_at: Date | string | null;
  seconds_to_ath: number | null;
  status: string;
  /** Slot for task B5. */
  parent_candidates?: ParentCandidate[];
  /** Slot for a Grok batch entry. */
  research?: ResearchEntry;
}

export type CoinRow = Pick<
  Selectable<CoinsTable>,
  | 'chain'
  | 'address'
  | 'name'
  | 'ticker'
  | 'description'
  | 'socials'
  | 'launched_at'
  | 'graduated_at'
  | 'ath_market_cap_usd'
  | 'ath_at'
  | 'seconds_to_ath'
  | 'status'
>;

/** The columns `coinRowToInput` reads. */
export const COIN_INPUT_COLUMNS = [
  'chain',
  'address',
  'name',
  'ticker',
  'description',
  'socials',
  'launched_at',
  'graduated_at',
  'ath_market_cap_usd',
  'ath_at',
  'seconds_to_ath',
  'status',
] as const;

export function coinRowToInput(
  row: CoinRow,
  extras: Pick<CoinInput, 'parent_candidates' | 'research'> = {},
): CoinInput {
  const input: CoinInput = {
    chain: row.chain,
    address: row.address,
    name: row.name,
    ticker: row.ticker,
    description: row.description,
    socials: row.socials,
    launched_at: row.launched_at,
    graduated_at: row.graduated_at,
    ath_market_cap_usd: row.ath_market_cap_usd,
    ath_at: row.ath_at,
    seconds_to_ath: row.seconds_to_ath,
    status: row.status,
  };
  if (extras.parent_candidates) input.parent_candidates = extras.parent_candidates;
  if (extras.research) input.research = extras.research;
  return input;
}

function iso(d: Date | string | null): string | null {
  if (d === null) return null;
  return d instanceof Date ? d.toISOString() : d;
}

function clip(s: string | null | undefined, max: number): string | null {
  if (s === null || s === undefined) return null;
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

/** The addresses the model may name as parent. Empty when there are no candidates. */
export function candidateAddresses(input: CoinInput): string[] {
  return (input.parent_candidates ?? []).slice(0, MAX_CANDIDATES).map((c) => c.address);
}

/** The compact record as a plain object, nulls dropped. */
export function buildRecord(input: CoinInput): Record<string, unknown> {
  const socials = Object.entries(input.socials ?? {})
    .filter(([, v]) => typeof v === 'string' && v !== '')
    .slice(0, MAX_SOCIALS)
    .map(([k, v]) => [k, clip(v as string, MAX_SHORT_CHARS)] as const);
  const rec: Record<string, unknown> = {
    name: clip(input.name, MAX_SHORT_CHARS),
    ticker: clip(input.ticker, MAX_SHORT_CHARS),
    description: clip(input.description, MAX_DESCRIPTION_CHARS),
    socials: socials.length > 0 ? Object.fromEntries(socials) : null,
    launched_at: iso(input.launched_at),
    graduated_at: iso(input.graduated_at),
    ath_market_cap_usd:
      input.ath_market_cap_usd === null ? null : Math.round(input.ath_market_cap_usd),
    ath_at: iso(input.ath_at),
    seconds_to_ath: input.seconds_to_ath,
    status: input.status,
  };
  if (input.parent_candidates && input.parent_candidates.length > 0) {
    rec['parent_candidates'] = input.parent_candidates.slice(0, MAX_CANDIDATES).map((c) =>
      dropNulls({
        address: c.address,
        name: clip(c.name, MAX_SHORT_CHARS),
        ticker: clip(c.ticker, MAX_SHORT_CHARS),
        launched_at: c.launched_at ?? null,
        ath_market_cap_usd:
          c.ath_market_cap_usd === null || c.ath_market_cap_usd === undefined
            ? null
            : Math.round(c.ath_market_cap_usd),
      }),
    );
  }
  if (input.research) {
    const r = input.research;
    rec['research'] = dropNulls({
      origin: clip(r.origin, 600),
      origin_date: r.origin_date ?? null,
      trigger_event: clip(r.trigger_event, 400),
      key_accounts: r.key_accounts?.slice(0, 10) ?? null,
      notes: clip(r.notes, 600),
      confidence: r.confidence ?? null,
    });
  }
  return dropNulls(rec);
}

function dropNulls(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));
}

/** JSON text that cannot contain `<`, `>`, `&` or line separators. */
export function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/[\u2028]/g, '\\u2028')
    .replace(/[\u2029]/g, '\\u2029');
}

/** The user message for one coin: the delimited data block and nothing else. */
export function buildUserContent(input: CoinInput): string {
  return `${RECORD_OPEN}\n${safeJson(buildRecord(input))}\n${RECORD_CLOSE}\nClassify the coin in the record above.`;
}
