/**
 * The `metadata_file` stage: what the creator wrote in the coin's metadata file.
 *
 * It needs the `metadata` stage done first (that is what stores the URI). For one coin it
 *   1. fetches the JSON at `coins.metadata_uri` through the gateways (`fetchTokenMetadata`),
 *   2. stores the raw JSON and the social links,
 *   3. where the file has a description or an image, replaces the value `metadata` took from
 *      Helius: the file is the record of what the creator wrote at launch. Where it has none, the
 *      Helius value stays.
 *
 * A coin with no metadata URI skips the stage (`skipped`, final); the `metadata` stage has already
 * recorded `metadata_no_uri` for it.
 *
 * Outcomes of the fetch:
 *   ok                                  stored.
 *   not_found, invalid, too_large,
 *   unsupported_uri                     the stage is `done`; the reason is a data issue
 *                                       (`metadata_<outcome>`), and the coin keeps what it has
 *                                       (including the Helius description and image).
 *   unreachable                         the stage `failed`, retryable; the coin keeps its Helius values.
 *
 * Socials. A link is kept only when it is a full http(s) URL without credentials (the rule in
 * `normalizeSocialUrl`). A handle or a bare domain is dropped, and each drop is recorded in the
 * `social_links_dropped` issue so the count can be read back from the database.
 *
 * Text goes through `cleanText`, the same function the `metadata` stage uses for Helius's text.
 */
import { replaceCoinIssues, type NewIssue } from '@memecoinipedia/db';
import type { MetadataResult } from '../../sources/metadata/fetch.js';
import { cleanText } from '../../sources/metadata/parse.js';
import { done, failed, skipped, type Stage, type StageContext, type StageCoin } from '../stage.js';
import type { UsageMeter } from '../usage.js';
import { imageReference } from './image.js';
import { decideSocials } from './socials.js';

export const METADATA_FILE_STAGE_VERSION = 1;
export { SOCIAL_FIELDS, droppedSocialLinks, type DroppedLink } from './socials.js';

/** Issue kinds this stage owns: it replaces them on every run. */
export const METADATA_FILE_ISSUE_KINDS = [
  'metadata_not_found',
  'metadata_invalid',
  'metadata_too_large',
  'metadata_unsupported_uri',
  'social_links_dropped',
] as const;

export interface MetadataFileStageDeps {
  fetchMetadata(uri: string): Promise<MetadataResult>;
  usage?: UsageMeter;
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const errorText = (err: unknown): string =>
  clip(err instanceof Error ? err.message : String(err), 300);

export function createMetadataFileStage(deps: MetadataFileStageDeps): Stage {
  return {
    name: 'metadata_file',
    version: METADATA_FILE_STAGE_VERSION,
    async run(ctx: StageContext, coin: StageCoin) {
      const uri = cleanText(coin.metadata_uri);
      if (uri === null) {
        await replaceCoinIssues(ctx.db, coin.id, METADATA_FILE_ISSUE_KINDS, []);
        return skipped('no_metadata_uri');
      }

      let result: MetadataResult;
      try {
        result = await deps.fetchMetadata(uri);
      } catch (err) {
        return failed(`metadata_error: ${errorText(err)}`, true);
      }
      deps.usage?.add(
        'metadata-fetch',
        result.attempts.reduce((n, a) => n + a.requests, 0),
      );
      if (result.outcome === 'unreachable') {
        const why = result.attempts.map((a) => `${a.gateway} ${a.result}`).join(', ');
        return failed(`metadata_unreachable: ${clip(why, 300)}`, true);
      }

      const issues: NewIssue[] = [];
      // The file is the record of launch: whatever links it gave, including none, replace
      // Jupiter's (`decideSocials`, shared with the metadata stage).
      const stored = await ctx.db
        .selectFrom('coins')
        .select('socials_source')
        .where('id', '=', coin.id)
        .executeTakeFirst();
      const decide = (links: Record<string, unknown> | null) =>
        decideSocials({
          from: 'metadata_file',
          links,
          // This stage is finishing now.
          fileStageDone: true,
          currentSource: stored?.socials_source ?? null,
        });
      if (result.outcome !== 'ok') {
        issues.push({
          kind: `metadata_${result.outcome}`,
          detail: {
            uri: clip(uri, 300),
            gateway: result.gateway,
            reason: result.detail,
            attempts: result.attempts.map((a) => ({
              gateway: a.gateway,
              result: a.result,
              status: a.status,
            })),
          },
        });
        const none = decide(null);
        if (none)
          await ctx.db
            .updateTable('coins')
            .set({
              socials: JSON.stringify(none.socials),
              socials_source: none.source,
              updated_at: ctx.now(),
            })
            .where('id', '=', coin.id)
            .execute();
      } else {
        const meta = result.metadata!;
        const raw = result.raw;
        const links = decide(raw ?? {})!;
        if (links.dropped.length > 0)
          issues.push({
            kind: 'social_links_dropped',
            detail: { links: links.dropped, source: 'metadata_file' },
          });

        const set: Record<string, unknown> = {
          updated_at: ctx.now(),
          socials: JSON.stringify(links.socials),
          socials_source: links.source,
          metadata_raw: JSON.stringify(raw),
        };
        // The chain's name and symbol win; the file fills in only what the chain lacks.
        if (coin.ticker === null && cleanText(meta.symbol) !== null)
          set['ticker'] = cleanText(meta.symbol);
        if (coin.name === null && cleanText(meta.name) !== null) set['name'] = cleanText(meta.name);
        // The file's description and image replace Helius's, where the file has them.
        const description = cleanText(meta.description);
        if (description !== null) set['description'] = description;
        const image = imageReference(meta.image);
        if (image !== null) set['image_url'] = image;
        await ctx.db
          .updateTable('coins')
          .set(set as never)
          .where('id', '=', coin.id)
          .execute();
      }
      await replaceCoinIssues(ctx.db, coin.id, METADATA_FILE_ISSUE_KINDS, issues);
      return done();
    },
  };
}
