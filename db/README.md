# /db

Postgres schema, migrations, typed query access (Kysely), and seed data. Owner: Claude (backend-api). Issue #2.

## Commands

Run from the repo root.

```sh
# apply pending migrations (reads DATABASE_URL)
DATABASE_URL=postgres://localhost:5432/memecoinipedia pnpm --filter @memecoinipedia/db migrate

# load the 20 probe coins (idempotent)
DATABASE_URL=... pnpm --filter @memecoinipedia/db seed

# tests; database tests need a server where databases can be created
TEST_DATABASE_ADMIN_URL=postgres://localhost:5432/postgres pnpm test

# candle storage measurement
TEST_DATABASE_ADMIN_URL=... pnpm --filter @memecoinipedia/db measure-storage <path to codex-probe-results.json>
```

Tests and the measurement script create `mcp_test_<random>` databases through
`TEST_DATABASE_ADMIN_URL` and drop them afterwards. The code refuses to create or drop any database whose
name does not match `^mcp_test_[a-z0-9_]+$` (`assertTestDatabaseName` in `src/testing.ts`). Without the
variable the database tests are skipped with a visible warning; with `CI` set and no variable, the run fails.

## Migrations

Plain SQL in `migrations/`, named `0001_name.sql`, forward-only. `src/migrate.ts` keeps
`schema_migrations(version, name, checksum, applied_at)`, takes a Postgres advisory lock, applies pending files
in order (one transaction per file), and throws if an applied file's checksum changed or an applied file is
missing. A second run changes nothing. Never edit an applied file; add a new one.

The `vector` extension and the embedding column are not here; they arrive with task B8.

## Schema

- `narratives`: the 11-value taxonomy (slug, label, sort order), seeded in the migration. Labels equal the
  strings in `AGENTS.md` (a test checks this).
- `coins`: keyed `(chain, address)`. Identity, launch metadata, price metrics (the outputs of
  `docs/metrics.md` section 11), current state, and classification. Indexes on ATH market cap (desc, nulls
  last), primary narrative, launch time.
- `pools`: per coin, unique `(chain, address)`. `coins.ath_pool_id` and `ath_wick_pool_id` point at pools
  (`ON DELETE SET NULL`).
- `candle_chunks`: candles as parallel arrays, one row per `(pool_id, resolution_sec, chunk_start)`. A chunk
  spans `resolution_sec * 1440` seconds (one UTC day of 1-minute bars; 60 days of hourly; about 4 years of
  daily). A CHECK ties every array length to `bar_count`. Arrays use lz4 compression where the server has it.
- `coin_stages`: per-coin pipeline stage state, `(coin_id, stage)`.
- `ingest_runs`, `provider_usage`: run records, estimates and per-provider request counts.
- `eval_labels`, `narrative_research`: mirrors of `labels.csv` and `batch-<issue>.json`.
- `data_issues`: review queue, partial index on open issues by kind.

Conventions: `bigint generated always as identity` ids, `timestamptz`, `double precision` for USD, `text` plus
CHECK instead of enum types.

## Code

- `createDb(url)` returns a `Kysely<Database>` with its own pool. No singleton. `bigint` columns are read as JS
  numbers; `numeric` (`total_supply`) stays a string; `jsonb` is written as a JSON string.
- `putBars(db, poolId, resolutionSec, bars)` merges into chunks in one transaction (per-pool advisory lock),
  de-duplicates by `t` with the new bar winning, keeps arrays sorted, and is idempotent.
  `getBars(db, poolId, resolutionSec, { from?, to? })` returns bars sorted by `t` (`from` inclusive, `to`
  exclusive). `CandleBar` repeats the fields of `Bar` in `ingest/src/metrics/types.ts`; `/db` does not import
  from `/ingest`.
- `types.ts` holds the handwritten `Database` interface and `databaseShape`, a runtime mirror the compiler
  checks against the interface. `test/schema.test.ts` compares it with the live schema.

## Candle storage measurement

Method: `scripts/measure-candle-storage.ts` loads the same bars into `candle_chunks` (through `putBars`) and
into a plain one-row-per-candle table (`pool_id, resolution_sec, t, o, h, l, c, volume_usd, trades, traders,
liquidity_usd`, primary key `(pool_id, resolution_sec, t)`) in a temporary database, runs `VACUUM ANALYZE`,
then reads `pg_total_relation_size` (heap, indexes, TOAST) for each. Postgres 16.14 (Homebrew), lz4 available
and in use.

**The probe file has too few bars.** `codex-probe-results.json` holds 60 real bars in total (a 3-bar sample for
each of the 20 coins); the rest of it is counts and summary figures. Each measured series is therefore built
from those real bars, cycled with shifted timestamps, a random-walk price scale (+-2% per step) and 0.5x to
1.5x jitter on volume and counts, so repetition does not flatter compression. Real bars are not that noisy in
every field, so compression on real data could be somewhat better or worse. The measurement is a reasonable
estimate, not a final number.

Run on the 20 probe coins (a seeded PRNG, so repeatable):

| Scenario | Bars | candle_chunks | bytes/bar | one row per candle | bytes/bar |
|---|---|---|---|---|---|
| (a) 2,880 one-minute + 500 hourly per coin, contiguous | 67,600 | 4.23 MB | 65.7 | 9.72 MB | 150.8 |
| (b) density seen in the probe | 24,739 | 1.64 MB | 69.5 | 3.66 MB | 155.0 |

Scenario (b) uses, per coin, the probe's own counts and dates: a run of 1-minute bars at launch (`first60`,
60 bars), the 1-minute bars of the ATH day (`athDay1m`, up to about 1,437) and daily bars from the first day
(`daily`, up to 758). That is 1,237 bars per coin on average, 77.9% of them at 1-minute resolution.

Projection for 100,000 coins (measured size times 5,000):

| Assumption | chunks | one row per candle |
|---|---|---|
| (a) 3,380 bars per coin | 20.7 GB | 47.5 GB |
| (b) probe density, 1,237 bars per coin | 8.0 GB | 17.9 GB |

Chunking saves about 2.2x to 2.3x. Most of that is the per-row header and per-row index entry of the flat
table. lz4 does little for these arrays: the chunk costs 65.7 bytes per bar against about 64 bytes of raw
values, because price doubles are high-entropy. Compression would matter more for sparse real data.
