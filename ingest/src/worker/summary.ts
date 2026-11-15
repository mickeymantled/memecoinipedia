/** The summary printed at the end of a run, read back from the database. */
import {
  countOpenIssues,
  countStages,
  groupStageFailures,
  type Database,
  type FailureGroup,
  type StageCount,
  type StageName,
} from '@memecoinipedia/db';
import { sql, type Kysely } from 'kysely';
import type { Estimate } from './plan.js';
import type { UsageTotals } from './usage.js';

export interface MetadataCoverage {
  coins: number;
  withDescription: number;
  withImageReference: number;
  withSocialLink: number;
  /** Social links the full-URL rule dropped (a handle or a bare domain where a URL belongs). */
  socialLinksDropped: number;
  coinsWithDroppedLinks: number;
}

export interface RunSummary {
  coins: number;
  stages: StageCount[];
  failures: FailureGroup[];
  issues: Array<{ kind: string; coins: number; issues: number }>;
  metadata: MetadataCoverage | null;
  estimate: Estimate;
  actual: Record<string, UsageTotals>;
}

async function coverage(
  db: Kysely<Database>,
  addresses: readonly string[],
): Promise<MetadataCoverage> {
  const list = sql.val([...addresses]);
  const c = await sql<{
    coins: string;
    description: string;
    image: string;
    social: string;
  }>`
    select count(*)::text as coins,
      count(*) filter (where coins.description is not null and btrim(coins.description) <> '')::text as description,
      count(*) filter (where coins.image_url is not null)::text as image,
      count(*) filter (where coins.socials <> '{}'::jsonb)::text as social
    from coins
    inner join coin_stages s on s.coin_id = coins.id and s.stage = 'metadata' and s.status in ('done', 'skipped')
    where coins.address = any(${list}::text[])
  `.execute(db);
  const d = await sql<{ links: string | null; coins: string }>`
    select coalesce(sum(jsonb_array_length(d.detail -> 'links')), 0)::text as links,
      count(distinct d.coin_id)::text as coins
    from data_issues d
    inner join coins on coins.id = d.coin_id
    where d.kind = 'social_links_dropped' and d.resolved_at is null and coins.address = any(${list}::text[])
  `.execute(db);
  const r = c.rows[0]!;
  return {
    coins: Number(r.coins),
    withDescription: Number(r.description),
    withImageReference: Number(r.image),
    withSocialLink: Number(r.social),
    socialLinksDropped: Number(d.rows[0]?.links ?? 0),
    coinsWithDroppedLinks: Number(d.rows[0]?.coins ?? 0),
  };
}

export async function buildSummary(
  db: Kysely<Database>,
  addresses: readonly string[],
  stages: readonly StageName[],
  estimate: Estimate,
  actual: Record<string, UsageTotals>,
): Promise<RunSummary> {
  return {
    coins: addresses.length,
    stages: await countStages(db, stages, addresses),
    failures: await groupStageFailures(db, stages, addresses),
    issues: await countOpenIssues(db, addresses),
    metadata: stages.includes('metadata') ? await coverage(db, addresses) : null,
    estimate,
    actual,
  };
}

const fmt = (n: number) => n.toLocaleString('en-US');

export function formatSummary(s: RunSummary, stageOrder: readonly StageName[]): string {
  const lines: string[] = [];
  lines.push(`Coins in the sample: ${fmt(s.coins)}`);
  lines.push('Coins per stage and status:');
  for (const stage of stageOrder) {
    const rows = s.stages.filter((r) => r.stage === stage);
    const parts = rows.map((r) => `${r.status} ${fmt(r.coins)}`).join(', ');
    lines.push(`  ${stage}: ${parts || 'none'}`);
  }
  if (s.failures.length > 0) {
    lines.push('Failed or skipped, by reason:');
    for (const f of s.failures) lines.push(`  ${f.stage} ${f.status} ${f.reason}: ${fmt(f.coins)}`);
  } else {
    lines.push('Failed or skipped: none');
  }
  if (s.issues.length > 0) {
    lines.push('Data issues recorded:');
    for (const i of s.issues) lines.push(`  ${i.kind}: ${fmt(i.coins)} coins`);
  }
  if (s.metadata) {
    const m = s.metadata;
    lines.push(`Metadata stage results (${fmt(m.coins)} coins through it):`);
    lines.push(`  with a description: ${fmt(m.withDescription)}`);
    lines.push(`  with an image reference: ${fmt(m.withImageReference)}`);
    lines.push(`  with at least one social link: ${fmt(m.withSocialLink)}`);
    lines.push(
      `  social links dropped by the full-URL rule: ${fmt(m.socialLinksDropped)} ` +
        `(on ${fmt(m.coinsWithDroppedLinks)} coins)`,
    );
  }
  lines.push('Estimate against actual:');
  const providers = new Set([...Object.keys(s.estimate), ...Object.keys(s.actual)]);
  for (const p of providers) {
    const e = s.estimate[p as keyof Estimate];
    const a = s.actual[p];
    const est = e
      ? `${fmt(e.requests)} requests${e.credits !== undefined ? `, ${fmt(e.credits)} credits` : ''}`
      : 'no estimate';
    const act = a
      ? `${fmt(a.requests)} requests${p === 'helius' ? `, ${fmt(a.units)} credits` : ''}`
      : '0 requests';
    lines.push(`  ${p}: estimated ${est}; actual ${act}`);
  }
  return lines.join('\n');
}
