/**
 * Which social links a coin keeps, decided in one place for both stages that write them.
 *
 * The coin's own metadata file is the record of what the creator published at launch. Jupiter's
 * token answer carries the same three links as they stand now, possibly edited since. So:
 *   - `socials_source` = `metadata_file` means the file was read (outcome `ok`): the coin keeps
 *     what the file gave, also when that is nothing, and Jupiter never overwrites it;
 *   - a file stage that ends done without reading the file (not found, invalid, too large,
 *     unsupported URI) changes neither the links nor the source;
 *   - Jupiter's links are stored (`socials_source` = `jupiter`) for every coin whose source is
 *     not `metadata_file`;
 *   - a file read later replaces Jupiter's links.
 * Both sources go through the same cleaning (`normalizeSocialUrl`) and the same record of what was
 * dropped (`droppedSocialLinks`).
 */
import { normalizeSocialUrl } from '../../sources/metadata/parse.js';

export const SOCIAL_FIELDS = ['twitter', 'telegram', 'website'] as const;
export type SocialField = (typeof SOCIAL_FIELDS)[number];
export type SocialsSource = 'metadata_file' | 'jupiter';

export interface DroppedLink {
  field: string;
  value: string;
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Social fields the source gave a value for that `normalizeSocialUrl` refused. */
export function droppedSocialLinks(
  raw: Record<string, unknown>,
  kept: Record<SocialField, string | null>,
): DroppedLink[] {
  const out: DroppedLink[] = [];
  for (const field of SOCIAL_FIELDS) {
    const v = raw[field];
    const present = v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '');
    if (present && kept[field] === null) {
      out.push({ field, value: clip(typeof v === 'string' ? v : JSON.stringify(v), 200) });
    }
  }
  return out;
}

export interface SocialsInput {
  /** Who is asking: the file stage (it read the file) or the metadata stage (Jupiter's answer). */
  from: SocialsSource;
  /**
   * The source's links as given, uncleaned. Null: the source had nothing to read (a file that was
   * not found, invalid, too large or not fetchable; a mint Jupiter has no row for).
   */
  links: Record<string, unknown> | null;
  /** What the coin has stored now: `metadata_file` means its file was read. */
  currentSource: SocialsSource | null;
}

export interface SocialsDecision {
  socials: Record<string, string>;
  source: SocialsSource;
  dropped: DroppedLink[];
}

/** The links to store, or null to leave the coin as it is. */
export function decideSocials(i: SocialsInput): SocialsDecision | null {
  // Nothing was read: nothing is learned, so neither the links nor the source change.
  if (i.links === null) return null;
  // `metadata_file` means the file was read: the record of launch, whatever links it held, also
  // none. Jupiter never overwrites it; a file read later replaces Jupiter's links.
  if (i.from === 'jupiter' && i.currentSource === 'metadata_file') return null;
  const links = i.links;
  const kept = {
    twitter: normalizeSocialUrl(links['twitter']),
    telegram: normalizeSocialUrl(links['telegram']),
    website: normalizeSocialUrl(links['website']),
  };
  const socials: Record<string, string> = {};
  for (const f of SOCIAL_FIELDS) {
    const v = kept[f];
    if (v !== null) socials[f] = v;
  }
  return { socials, source: i.from, dropped: droppedSocialLinks(links, kept) };
}
