import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { ResearchEntry } from '../classify/input.js';
import { DEFAULT_NARRATIVES, MAX_SECONDARIES, type Narrative } from '../classify/schema.js';
import { toSlug } from './narratives.js';

/** One entry of `/research/narratives/batch-<issue>.json` (AGENTS.md). */
const entrySchema = z
  .object({
    mint: z.string().min(1),
    ticker: z.string(),
    primary_narrative: z.string(),
    secondary_narratives: z.array(z.string()),
    origin: z.string(),
    origin_date: z.string(),
    trigger_event: z.string(),
    parent_mint: z.string().min(1).nullable(),
    key_accounts: z.array(z.string()),
    sources: z.array(z.string()),
    confidence: z.number().min(0).max(1),
    notes: z.string(),
  })
  .strict();

export interface ResearchProblem {
  file: string;
  /** 0-based position in the batch array, or null for the file as a whole. */
  index: number | null;
  mint: string | null;
  message: string;
}

export interface ResearchLoad {
  /** The `research` slot of the classifier input, by mint. */
  byMint: Map<string, ResearchEntry>;
  /** Entries and files that were left out, each with the reason. */
  problems: ResearchProblem[];
}

/** Drops empty strings and empty lists, so the slot carries only what the research says. */
function toSlot(e: z.infer<typeof entrySchema>): ResearchEntry {
  const slot: ResearchEntry = {};
  if (e.origin !== '') slot.origin = e.origin;
  if (e.origin_date !== '') slot.origin_date = e.origin_date;
  if (e.trigger_event !== '') slot.trigger_event = e.trigger_event;
  if (e.key_accounts.length > 0) slot.key_accounts = e.key_accounts;
  if (e.notes !== '') slot.notes = e.notes;
  slot.confidence = e.confidence;
  return slot;
}

/**
 * Validates one batch file's text and adds its good entries to `into`. A bad entry is reported and
 * skipped; the others still load. A mint already loaded from an earlier file is reported and the
 * earlier entry is kept.
 *
 * The slot has no primary narrative, parent or sources: the classifier is not shown Grok's
 * answer, only the evidence behind it. The entry's narratives are still checked against the
 * taxonomy, so a batch that does not follow it is caught here.
 */
export function parseResearchBatch(
  text: string,
  file: string,
  into: ResearchLoad = { byMint: new Map(), problems: [] },
  narratives: readonly Narrative[] = DEFAULT_NARRATIVES,
): ResearchLoad {
  const fail = (index: number | null, mint: string | null, message: string) =>
    into.problems.push({ file, index, mint, message });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    fail(null, null, 'not valid JSON');
    return into;
  }
  if (!Array.isArray(raw)) {
    fail(null, null, 'the file must hold a JSON array of entries');
    return into;
  }
  raw.forEach((item: unknown, index) => {
    const guess = (item as { mint?: unknown } | null)?.mint;
    const mintGuess = typeof guess === 'string' ? guess : null;
    const parsed = entrySchema.safeParse(item);
    if (!parsed.success) {
      const msg = parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.') || '(entry)'}: ${i.message}`)
        .join('; ');
      fail(index, mintGuess, msg);
      return;
    }
    const e = parsed.data;
    const primary = toSlug(e.primary_narrative, narratives);
    if (primary === null) {
      fail(index, e.mint, `unknown primary narrative "${e.primary_narrative}"`);
      return;
    }
    const secs = e.secondary_narratives.map((s) => toSlug(s, narratives));
    const badSec = e.secondary_narratives.find((_, i) => secs[i] === null);
    if (badSec !== undefined) {
      fail(index, e.mint, `unknown secondary narrative "${badSec}"`);
      return;
    }
    if (secs.length > MAX_SECONDARIES) {
      fail(index, e.mint, `${secs.length} secondary narratives (at most ${MAX_SECONDARIES})`);
      return;
    }
    if (secs.includes(primary)) {
      fail(index, e.mint, 'a secondary narrative equals the primary');
      return;
    }
    if (into.byMint.has(e.mint)) {
      fail(index, e.mint, 'mint already loaded from an earlier entry or file');
      return;
    }
    into.byMint.set(e.mint, toSlot(e));
  });
  return into;
}

/** Reads every `batch-*.json` in `dir`, in name order. */
export async function loadResearchDir(
  dir: string,
  narratives: readonly Narrative[] = DEFAULT_NARRATIVES,
): Promise<ResearchLoad> {
  const out: ResearchLoad = { byMint: new Map(), problems: [] };
  const names = (await readdir(dir)).filter((n) => /^batch-.+\.json$/.test(n)).sort();
  for (const name of names) {
    parseResearchBatch(await readFile(join(dir, name), 'utf8'), name, out, narratives);
  }
  return out;
}
