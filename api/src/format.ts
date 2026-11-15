/** ISO 8601 in UTC with a Z, truncated to the second: 2024-11-03T14:07:00Z. */
export function isoSecond(d: Date | null | undefined): string | null {
  if (!d) return null;
  return new Date(Math.floor(d.getTime() / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

/**
 * Creator-written text is returned unchanged apart from trimming. A value that
 * is empty after trimming is unknown, so it becomes null.
 */
export function creatorText(s: string | null | undefined): string | null {
  if (s === null || s === undefined) return null;
  const t = s.trim();
  return t === '' ? null : t;
}

/** Whole address: 32 to 44 base58 characters. */
export const ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
