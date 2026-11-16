import { z } from 'zod';
import { ApiError } from './errors.js';
import type { Sort } from './params.js';

/**
 * Cursors are opaque to clients: base64url of a small JSON object
 * `{ v, h, k }`. `h` is a hash of the other parameters (see `paramsHash`), so a
 * cursor sent with different parameters is rejected. `k` is the position:
 *
 * - `ath_*`:       `[ath, id]`, the last row's key (keyset)
 * - `launched_*`:  `[0, launchedAtMicros, id]` while in the rows that have a
 *                  launch time, `[1, null, id]` once in the rows that do not
 * - `relevance`:   `[offset]`; relevance pages by offset, capped (below)
 */
export const RELEVANCE_OFFSET_CAP = 2000;

const MAX_CURSOR_LENGTH = 400;
const ID = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const MICROS = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);

export type CursorPosition =
  | { kind: 'offset'; offset: number }
  | { kind: 'ath'; ath: number; id: number }
  | { kind: 'launched'; phase: 0; at: string; id: number }
  | { kind: 'launched'; phase: 1; id: number };

const envelope = z.object({ v: z.literal(1), h: z.string(), k: z.array(z.unknown()).max(3) });

const positionSchema = {
  relevance: z
    .tuple([
      z
        .number()
        .int()
        .min(1)
        .max(RELEVANCE_OFFSET_CAP - 1),
    ])
    .transform(([offset]): CursorPosition => ({ kind: 'offset', offset })),
  ath: z
    .tuple([z.number().finite().min(0), ID])
    .transform(([ath, id]): CursorPosition => ({ kind: 'ath', ath, id })),
  launched: z.union([
    z
      .tuple([z.literal(0), MICROS, ID])
      .transform(([, at, id]): CursorPosition => ({ kind: 'launched', phase: 0, at, id })),
    z
      .tuple([z.literal(1), z.null(), ID])
      .transform(([, , id]): CursorPosition => ({ kind: 'launched', phase: 1, id })),
  ]),
};

const invalid = () =>
  new ApiError('invalid_cursor', 'cursor is not valid for these parameters', { param: 'cursor' });

export function encodeCursor(hash: string, k: unknown[]): string {
  return Buffer.from(JSON.stringify({ v: 1, h: hash, k })).toString('base64url');
}

/** Decodes a cursor for `sort` and `hash`; throws `invalid_cursor` for anything else. */
export function decodeCursor(cursor: string, hash: string, sort: Sort): CursorPosition {
  if (cursor.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalid();
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  const env = envelope.safeParse(json);
  if (!env.success || env.data.h !== hash) throw invalid();
  const schema =
    sort === 'relevance'
      ? positionSchema.relevance
      : sort.startsWith('ath')
        ? positionSchema.ath
        : positionSchema.launched;
  const pos = schema.safeParse(env.data.k);
  if (!pos.success) throw invalid();
  return pos.data;
}
