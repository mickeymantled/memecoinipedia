/**
 * Classifies coins with the Anthropic Message Batches API.
 *
 *   tsx --env-file=.env pipeline/scripts/classify.ts [options]
 *
 * The default is a dry run: it prints how many coins would be sent and the estimated tokens and
 * dollars for both passes, sends nothing and writes nothing. A real run needs BOTH `--confirm`
 * and `--max-usd <dollars>`; it stops submitting when the estimate for the next batch would pass
 * the ceiling. ANTHROPIC_API_KEY is read from the environment by the SDK and is never printed.
 *
 * Options
 *   --confirm               send for real (with --max-usd)
 *   --max-usd N             spend ceiling in dollars, checked against the no-cache-hit estimate
 *   --pass first|second|both   default both
 *   --force                 re-classify coins already classified under the current prompt version
 *   --limit N               at most N coins per pass
 *   --chain NAME            only coins on this chain (DB mode)
 *   --min-ath-usd N         only coins with ATH market cap at least N (DB mode)
 *   --taxonomy PATH         taxonomy text file (default: the draft copy in pipeline/prompts)
 *   --first-model ID, --second-model ID   (or CLASSIFY_FIRST_MODEL / CLASSIFY_SECOND_MODEL)
 *   --count-tokens          use the free count_tokens endpoint for the system prompt (needs the key)
 *   --cache-hit-rate F, --second-pass-rate F   dry-run assumptions, 0 to 1
 *   --poll-seconds N        batch polling interval (default 60)
 *
 * File mode (for the eval)
 *   --mints FILE --out results.jsonl [--no-db]
 *   FILE has one mint per line or one JSON coin record per line (fields: mint, name, ticker,
 *   description, socials, launched_at, ...). With --no-db the database is never opened and every
 *   line must be a JSON record. Without --no-db, bare mints are looked up in `coins` with a
 *   SELECT; nothing is written to the database in file mode either way. State for resuming is
 *   kept in <out>.state.json.
 *
 * Dry run without any database: --synthetic N prices N made-up coins (dry run only).
 *
 * Environment: DATABASE_URL (DB mode), ANTHROPIC_API_KEY (real run, --count-tokens).
 */
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createDb } from '@memecoinipedia/db';
import { AnthropicClassifierClient } from '../src/classify/anthropic.js';
import { Runner, openBatchCount } from '../src/classify/batch.js';
import type { ClassifierClient } from '../src/classify/client.js';
import { defaultConfig } from '../src/classify/config.js';
import { DbStore, loadCoinsByMint } from '../src/classify/db-store.js';
import {
  FileStore,
  fileRecordToCoin,
  parseMintsFile,
  type FileCoin,
} from '../src/classify/file-store.js';
import {
  estimatedCalibration,
  exactCalibration,
  formatDryRun,
  planRun,
} from '../src/classify/plan.js';
import { loadPromptBuilder } from '../src/classify/prompt.js';
import { DEFAULT_NARRATIVES } from '../src/classify/schema.js';
import type { ClassifyStore, WorkItem } from '../src/classify/store.js';
import { syntheticItems } from '../src/classify/synthetic.js';

function fail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

function num(name: string, v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) fail(`--${name} must be a non-negative number`);
  return n;
}

async function main(): Promise<void> {
  const { values: a } = parseArgs({
    options: {
      confirm: { type: 'boolean', default: false },
      'max-usd': { type: 'string' },
      pass: { type: 'string', default: 'both' },
      force: { type: 'boolean', default: false },
      limit: { type: 'string' },
      chain: { type: 'string' },
      'min-ath-usd': { type: 'string' },
      taxonomy: { type: 'string' },
      'first-model': { type: 'string' },
      'second-model': { type: 'string' },
      'count-tokens': { type: 'boolean', default: false },
      'cache-hit-rate': { type: 'string' },
      'second-pass-rate': { type: 'string' },
      'poll-seconds': { type: 'string' },
      mints: { type: 'string' },
      out: { type: 'string' },
      'no-db': { type: 'boolean', default: false },
      synthetic: { type: 'string' },
    },
    strict: true,
  });

  if (a.pass !== 'first' && a.pass !== 'second' && a.pass !== 'both') {
    fail('--pass must be first, second or both');
  }
  const passes = a.pass;
  const maxUsd = num('max-usd', a['max-usd']);
  const synthetic = num('synthetic', a.synthetic);
  if (a.confirm && maxUsd === undefined)
    fail('--confirm needs --max-usd <dollars>. Nothing was sent.');
  if (a.confirm && !(maxUsd! > 0)) fail('--max-usd must be above zero. Nothing was sent.');
  if (a.confirm && synthetic !== undefined) fail('--synthetic is for dry runs only.');
  if (a.mints && !a.out) fail('--mints needs --out');
  if (a['no-db'] && !a.mints) fail('--no-db is for file mode: give --mints and --out');
  if (synthetic !== undefined && a.mints) fail('--synthetic and --mints cannot be combined');

  const config = defaultConfig(process.env);
  if (a['first-model']) config.firstModel = a['first-model'];
  if (a['second-model']) config.secondModel = a['second-model'];
  if (a.taxonomy) config.taxonomyPath = a.taxonomy;
  const hit = num('cache-hit-rate', a['cache-hit-rate']);
  if (hit !== undefined) config.cacheHitRate = Math.min(1, hit);
  const rate = num('second-pass-rate', a['second-pass-rate']);
  if (rate !== undefined) config.secondPassRate = Math.min(1, rate);
  const poll = num('poll-seconds', a['poll-seconds']);
  if (poll !== undefined) config.pollIntervalMs = poll * 1000;
  const limit = num('limit', a.limit);
  const minAthUsd = num('min-ath-usd', a['min-ath-usd']);

  // Storage: DB state, file state, or none (synthetic dry run).
  let store: ClassifyStore | null = null;
  let syntheticList: WorkItem[] | null = null;
  if (synthetic !== undefined) {
    syntheticList = syntheticItems(synthetic);
  } else if (a.mints) {
    const entries = parseMintsFile(await readFile(a.mints, 'utf8'));
    const coins: FileCoin[] = [];
    const bare: string[] = [];
    for (const e of entries) {
      if (typeof e === 'string') bare.push(e);
      else coins.push(fileRecordToCoin(e));
    }
    if (bare.length > 0) {
      if (a['no-db']) fail('--no-db needs JSON coin records in the mints file; found bare mints.');
      const url = process.env['DATABASE_URL'];
      if (!url) fail('DATABASE_URL is not set (needed to look up bare mints).');
      const db = createDb(url);
      try {
        const found = await loadCoinsByMint(db, bare, a.chain ?? 'solana');
        if (found.missing.length > 0) {
          fail(`${found.missing.length} mints are not in coins, first: ${found.missing[0]}`);
        }
        coins.push(...found.coins);
      } finally {
        await db.destroy();
      }
    }
    store = FileStore.open(a.out!, coins);
  } else {
    const url = process.env['DATABASE_URL'];
    if (!url) fail('DATABASE_URL is not set.');
    store = new DbStore(createDb(url));
  }

  try {
    const narratives = (store ? await store.narratives() : null) ?? [...DEFAULT_NARRATIVES];
    const builder = await loadPromptBuilder(config, narratives);

    let client: ClassifierClient | null = null;
    const getClient = (): ClassifierClient => (client ??= new AnthropicClassifierClient());
    const calibration = a['count-tokens']
      ? await exactCalibration(getClient(), builder, config.firstModel)
      : estimatedCalibration(builder, config);

    if (!a.confirm) {
      const firstItems =
        syntheticList ??
        (await store!.selectFirstPass({
          force: a.force,
          maxAttempts: config.maxAttempts,
          promptVersion: builder.version,
          limit,
          chain: a.chain,
          minAthUsd,
        }));
      const secondNow =
        passes === 'first' || syntheticList
          ? 0
          : (
              await store!.selectSecondPass({
                firstModel: config.firstModel,
                threshold: config.secondPassThreshold,
                promptVersion: builder.version,
                limit,
              })
            ).length;
      const est = planRun(
        { firstItems, secondEligibleNow: secondNow },
        config,
        calibration,
        passes !== 'second',
        passes !== 'first',
      );
      const open = store ? await store.openRuns() : [];
      console.log(
        formatDryRun(est, {
          config,
          cal: calibration,
          promptVersion: builder.version,
          openRuns: open.length,
          openBatches: openBatchCount(open),
          ...(syntheticList
            ? { note: `Synthetic input: ${syntheticList.length} made-up coins, no database.` }
            : {}),
        }),
      );
      if (maxUsd !== undefined) {
        console.log(
          `\n--max-usd ${maxUsd} was given without --confirm, so this was still a dry run. ` +
            `Ceiling basis total: $${est.totalUsd.noCacheHits.toFixed(2)}.`,
        );
      }
      return;
    }

    const runner = new Runner({
      client: getClient(),
      store: store!,
      builder,
      config,
      calibration,
      log: (l) => console.log(l),
    });
    const summary = await runner.run({
      maxUsd: maxUsd!,
      passes,
      force: a.force,
      limit,
      chain: a.chain,
      minAthUsd,
    });
    console.log(JSON.stringify(summary, null, 2));
    if (summary.stoppedByCeiling) process.exitCode = 3;
  } finally {
    await store?.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
