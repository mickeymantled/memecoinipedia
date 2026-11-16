import { sql, type Kysely } from 'kysely';
import { Hono, type Context } from 'hono';
import type { Database } from '@memecoinipedia/db';
import { getCoin, searchCoins } from './coins.js';
import { ApiError, invalidParameter } from './errors.js';
import { ADDRESS_PATTERN } from './format.js';
import { getNarrative, listNarratives } from './narratives.js';
import { parseListParams } from './params.js';

export interface Deps {
  db: Kysely<Database>;
  /** Milliseconds the health check waits for the database. */
  healthTimeoutMs?: number;
}

/** `cache-control` max-age in seconds (contract section 1). */
const MAX_AGE = { list: 60, coin: 300, comparables: 300, narratives: 3600 } as const;

/** JSON with the content type the contract names (Hono's `c.json` omits the charset). */
const json = (c: Context, body: unknown, status: 200 | 400 | 404 | 429 | 500 | 503 = 200) => {
  c.header('content-type', 'application/json; charset=utf-8');
  return c.body(JSON.stringify(body), status);
};

const ok = (c: Context, body: unknown, maxAge: number) => {
  c.header('cache-control', `public, max-age=${maxAge}`);
  return json(c, body);
};

const fail = (c: Context, err: ApiError) => {
  c.header('cache-control', 'no-store');
  for (const [k, v] of Object.entries(err.headers)) c.header(k, v);
  return json(c, err.body(), err.status);
};

function checkAddress(address: string): void {
  if (!ADDRESS_PATTERN.test(address)) {
    throw invalidParameter('address', 'address must be 32 to 44 base58 characters');
  }
}

/** Builds the API. Tests call `app.request(...)`; `server.ts` listens on a port. */
export function createApp({ db, healthTimeoutMs = 2000 }: Deps): Hono {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof ApiError) return fail(c, err);
    console.error(err);
    return fail(c, new ApiError('internal', 'internal error'));
  });
  app.notFound((c) =>
    fail(c, new ApiError('not_found', 'no such endpoint', { reason: 'unknown_route' })),
  );

  const v1 = new Hono();

  v1.get('/health', async (c) => {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        sql`select 1`.execute(db),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), healthTimeoutMs);
        }),
      ]);
    } catch {
      // The contract fixes the status (503) and the shape; it names no code for this case.
      return fail(
        c,
        new ApiError('upstream_unavailable', 'the database cannot be reached', {
          headers: { 'retry-after': '5' },
        }),
      );
    } finally {
      clearTimeout(timer);
    }
    c.header('cache-control', 'no-store');
    return json(c, { ok: true });
  });

  v1.get('/coins', async (c) => {
    const p = parseListParams((name) => c.req.query(name));
    if (p.mode === 'semantic') {
      throw new ApiError('not_ready', 'semantic search needs embeddings, which are not built yet');
    }
    return ok(c, await searchCoins(db, p), MAX_AGE.list);
  });

  v1.get('/coins/:chain/:address/comparables', (c) => {
    checkAddress(c.req.param('address'));
    const k = c.req.query('k');
    if (k !== undefined && !(/^\d+$/.test(k) && Number(k) >= 10 && Number(k) <= 200)) {
      throw invalidParameter('k', 'k must be a whole number from 10 to 200');
    }
    const only = c.req.query('only_earlier');
    if (only !== undefined && only !== 'true' && only !== 'false') {
      throw invalidParameter('only_earlier', 'only_earlier must be true or false');
    }
    throw new ApiError('not_ready', 'comparables need embeddings, which are not built yet');
  });

  v1.get('/coins/:chain/:address', async (c) => {
    const address = c.req.param('address');
    checkAddress(address);
    return ok(c, await getCoin(db, c.req.param('chain'), address), MAX_AGE.coin);
  });

  v1.get('/narratives', async (c) => ok(c, { data: await listNarratives(db) }, MAX_AGE.narratives));

  v1.get('/narratives/:slug', async (c) =>
    ok(c, await getNarrative(db, c.req.param('slug')), MAX_AGE.narratives),
  );

  app.route('/api/v1', v1);
  return app;
}
