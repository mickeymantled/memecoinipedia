import { sql, type Kysely } from 'kysely';
import type { Database } from '@memecoinipedia/db';
import { LISTED_MIN_ATH_USD } from './coins.js';
import { notFound } from './errors.js';

export interface Distribution {
  n: number;
  median: number | null;
  p75: number | null;
  p90: number | null;
  max: number | null;
  population: 'ath_100k_plus';
}

export interface NarrativeStats {
  slug: string;
  label: string;
  coin_count: number;
  secondary_coin_count: number;
  ath_distribution: Distribution;
}

/**
 * A `Distribution` from the figures of a group. With n = 0 the four figures are
 * null. Percentiles are Postgres `percentile_cont` (linear interpolation).
 */
export function distribution(n: number, pct: number[] | null, max: number | null): Distribution {
  const has = n > 0 && pct !== null;
  return {
    n,
    median: has ? (pct[0] ?? null) : null,
    p75: has ? (pct[1] ?? null) : null,
    p90: has ? (pct[2] ?? null) : null,
    max: n > 0 ? max : null,
    population: 'ath_100k_plus',
  };
}

interface Row {
  slug: string;
  label: string;
  coin_count: number;
  secondary_coin_count: number;
  pct: number[] | null;
  max: number | null;
}

/** One row per narrative, in `sort_order`; `slug` restricts it to one. */
async function stats(db: Kysely<Database>, slug: string | null): Promise<NarrativeStats[]> {
  const only = slug === null ? sql`` : sql`where n.slug = ${slug}`;
  const { rows } = await sql<Row>`
    select n.slug, n.label,
           coalesce(p.n, 0)::int as coin_count,
           coalesce(s.n, 0)::int as secondary_coin_count,
           p.pct, p.max
    from narratives n
    left join (
      select primary_narrative as slug,
             count(*) as n,
             percentile_cont(array[0.5, 0.75, 0.9]::double precision[])
               within group (order by ath_market_cap_usd) as pct,
             max(ath_market_cap_usd) as max
      from coins
      where ath_market_cap_usd >= ${LISTED_MIN_ATH_USD} and primary_narrative is not null
      group by primary_narrative
    ) p on p.slug = n.slug
    left join (
      select sec as slug, count(*) as n
      from coins, unnest(secondary_narratives) as sec
      where ath_market_cap_usd >= ${LISTED_MIN_ATH_USD}
      group by sec
    ) s on s.slug = n.slug
    ${only}
    order by n.sort_order`.execute(db);
  return rows.map((r) => ({
    slug: r.slug,
    label: r.label,
    coin_count: r.coin_count,
    secondary_coin_count: r.secondary_coin_count,
    ath_distribution: distribution(r.coin_count, r.pct, r.max),
  }));
}

export const listNarratives = (db: Kysely<Database>) => stats(db, null);

export async function getNarrative(db: Kysely<Database>, slug: string): Promise<NarrativeStats> {
  const [row] = await stats(db, slug);
  if (!row) throw notFound('unknown_narrative', 'no narrative has this slug');
  return row;
}
