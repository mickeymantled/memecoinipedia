import { DEFAULT_NARRATIVES, type Narrative } from '../classify/schema.js';

/** A problem found in an input file. `line` is 1-based; 0 means the whole file. */
export interface Problem {
  line: number;
  message: string;
}

/**
 * Maps a narrative written as a taxonomy label (`culture/meme`, `news event`, `AI`) or as a slug
 * (`culture_meme`) to its slug. Case and surrounding spaces do not matter. Returns null when the
 * text is neither.
 */
export function toSlug(
  text: string,
  narratives: readonly Narrative[] = DEFAULT_NARRATIVES,
): string | null {
  const t = text.trim().toLowerCase();
  if (t === '') return null;
  for (const n of narratives) {
    if (n.slug.toLowerCase() === t || n.label.toLowerCase() === t) return n.slug;
  }
  return null;
}
