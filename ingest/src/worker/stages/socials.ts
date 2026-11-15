/**
 * Which social links a coin keeps, decided in one place for both stages that write them.
 *
 * The coin's own metadata file is the record of what the creator published at launch. Jupiter's
 * token answer carries the same three links as they stand now, possibly edited since. So:
 *   - a coin whose `metadata_file` stage is done keeps what the file gave, also when that is
 *     nothing (`socials_source` = `metadata_file`); Jupiter never overwrites it;
 *   - otherwise Jupiter's links are stored (`socials_source` = `jupiter`);
 *   - a file that arrives later replaces Jupiter's links.
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
  /** Who is asking: the file stage (its fetch finished) or the metadata stage (Jupiter's answer). */
  from: SocialsSource;
  /** The source's links as given, uncleaned. Null: the source gave nothing (a file that could not be read). */
  links: Record<string, unknown> | null;
  /** True when the coin's `metadata_file` stage is done, as the asker saw it. */
  fileStageDone: boolean;
  /** What the coin has stored now. */
  currentSource: SocialsSource | null;
}

export interface SocialsDecision {
  socials: Record<string, string>;
  source: SocialsSource;
  dropped: DroppedLink[];
}

/** The links to store, or null to leave the coin as it is. */
export function decideSocials(i: SocialsInput): SocialsDecision | null {
  if (i.links === null) {
    // Jupiter had no row to read: nothing to add. A file that gave nothing (not found, invalid):
    // the coin has no links from it, unless the file already gave some.
    if (i.from === 'jupiter') return null;
    return i.currentSource === 'metadata_file'
      ? null
      : { socials: {}, source: 'metadata_file', dropped: [] };
  }
  // The file is the record: once its stage is done, Jupiter is not asked to add to it.
  if (i.from === 'jupiter' && i.fileStageDone) return null;
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
