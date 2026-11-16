# /pipeline

The classification pipeline (task B4): Anthropic Message Batches with a cached system prompt and
structured output, Haiku first, Sonnet for coins under 0.7 confidence. Issue #29.

No live API call has been made. There is no key yet. Every test uses a fake client.

## Run it

```
# dry run (the default): estimates tokens and dollars, sends nothing, writes nothing
pnpm --filter @memecoinipedia/pipeline classify -- --synthetic 1000      # made-up coins, no database
node --env-file=.env --import tsx pipeline/scripts/classify.ts           # coins in DATABASE_URL

# real run: needs BOTH flags. Stops submitting when the next batch would pass the ceiling.
node --env-file=.env --import tsx pipeline/scripts/classify.ts --confirm --max-usd 5 --limit 200

# file mode, for the eval: no writes to coins, coin_stages or ingest_runs
... classify.ts --mints eval.jsonl --out results.jsonl --no-db
```

Options are listed at the top of `scripts/classify.ts`. `ANTHROPIC_API_KEY` is read from the
environment by the SDK and never printed. `--count-tokens` uses the free count_tokens endpoint to
measure the system prompt instead of estimating it.

## What is where

| File | Part of the issue |
|---|---|
| `src/classify/input.ts` | 1. input builder: compact record in a delimited data block, empty `parent_candidates` and `research` slots |
| `prompts/classify-v0.md`, `prompts/taxonomy-draft.md`, `src/classify/prompt.ts` | 2. prompt and builder; the taxonomy file path is config (`--taxonomy`) |
| `src/classify/schema.ts` | 3. JSON schema sent to the API, zod validation of every result |
| `src/classify/batch.ts`, `db-store.ts` | 4 and 5. batch runner, resume, second pass |
| `src/classify/estimate.ts`, `plan.ts`, `pricing.ts` | 6. dry run and the spend ceiling |
| `src/classify/file-store.ts` | 7. file mode |
| `scripts/classify.ts` | 8. the script |
| `src/classify/anthropic.ts` | the only file that imports `@anthropic-ai/sdk` (pinned at 1.8.0) |

## Sources for every API fact used

Read on 2026-11-15 from the claude-api skill (`typescript/claude-api/batches.md`, `README.md`,
`tool-use.md`, `shared/prompt-caching.md`, `shared/token-counting.md`), the installed SDK's type
declarations, and the official pages named below (fetched as Markdown).

| Fact | Source |
|---|---|
| Create `client.messages.batches.create({ requests: [{ custom_id, params }] })`, poll `.retrieve(id).processing_status` (`in_progress`, `canceling`, `ended`), stream `.results(id)`; result `type` is `succeeded`, `errored`, `canceled` or `expired` | skill `typescript/claude-api/batches.md`; SDK `resources/messages/batches.d.ts` |
| Batch limits: 100,000 requests or 256 MB, whichever first; most batches finish in an hour, all within 24; results kept 29 days from creation; results in any order, match by `custom_id`; `custom_id` is 1 to 64 characters of `[a-zA-Z0-9_-]`; expired requests are not billed; a batch request cannot set `max_tokens: 0`, `stream`, `speed` or `fallbacks` | https://platform.claude.com/docs/en/build-with-claude/batch-processing |
| Prompt caching in batches is best effort: hit rates "typically" 30 to 98 percent; use identical `cache_control` blocks in every request; batches can outlast 5 minutes so the 1-hour TTL is suggested | same page, "Using prompt caching with Message Batches" |
| `cache_control: { type: 'ephemeral', ttl: '5m' \| '1h' }` on a system text block; prefix match; verify with `usage.cache_read_input_tokens` and `cache_creation_input_tokens` | skill `shared/prompt-caching.md`; https://platform.claude.com/docs/en/build-with-claude/prompt-caching |
| Minimum cacheable prompt: 512 tokens for Claude Haiku 5.5 and Claude Sonnet 5.5 (4,096 for Haiku 4.5); a shorter prefix is not cached and raises no error | prompt-caching page, "Cache limitations" (the skill lists the same value but says to confirm it in the docs; confirmed) |
| Structured output: `output_config: { format: { type: 'json_schema', schema } }`. Supported: `enum`, `anyOf`, `required`, `additionalProperties: false`. Not supported: `maxLength`, numeric bounds, array bounds beyond `minItems` 0 or 1 (400). Refusal and `max_tokens` stop reasons can return output that does not match the schema. Works with batch processing. | https://platform.claude.com/docs/en/build-with-claude/structured-outputs; skill `typescript/claude-api/tool-use.md` |
| Token counting: `client.messages.countTokens({ model, system, messages })` returns `input_tokens`; free, separate rate limit; does not apply caching logic; counts are model specific | skill `shared/token-counting.md`; https://platform.claude.com/docs/en/build-with-claude/token-counting |
| Thinking: Haiku 5.5 accepts `{ type: 'disabled' }` at effort `high` or below; Sonnet 5.5 rejects `disabled` with a 400 and its lowest setting is `{ type: 'between_tools' }`; no `temperature`, `top_p` or `top_k` | https://platform.claude.com/docs/en/build-with-claude/thinking |
| Prices (below) | https://platform.claude.com/docs/en/about-claude/pricing |

### Prices used (USD per million tokens, before the 50 percent batch discount)

| Model | Input | Cache write 5m | Cache write 1h | Cache read | Output |
|---|---:|---:|---:|---:|---:|
| claude-haiku-5-5, prompt up to 100,000 tokens | 0.10 | 0.125 | 0.20 | 0.01 | 0.50 |
| claude-haiku-5-5, prompt over 100,000 tokens | 0.50 | 0.625 | 1.00 | 0.05 | 2.50 |
| claude-sonnet-5-5 | 2.00 | 2.50 | 4.00 | 0.10 | 10.00 |

The batch discount is 50 percent on input and output (pricing page, "Batch processing"). The page
says the discounts stack but prints no batch price for cache reads or writes, so `pricing.ts`
halves the cache prices too. That is an inference. The first live run's usage settles it.

### Where sources disagree or are silent

- Skill and docs agree on every price and on the 512-token minimum. The skill's caching file tells
  the reader to check the docs for the 512 figure; the docs page was checked and says 512.
- The docs print no batch-and-cache price table (see above).
- The taxonomy draft says the Haiku classifier may see images, to be decided in B4. v0 sends text
  only: no image tokens, no extra cost, and it is a known weak spot for coins whose subject is only
  in the picture.
- The draft taxonomy writes labels (`culture/meme`); the database and the issue use slugs
  (`culture_meme`). The prompt maps one to the other from the `narratives` table.
- Anthropic documents no lookup of a batch by label, so a batch whose id was never saved cannot be
  found (see Resume).

## Prompt and untrusted text

The system prompt is `prompts/classify-v0.md` with the taxonomy file and a label-to-slug list filled
in. It never depends on the coin, so it is the same bytes in every request and is the cached
prefix (one `cache_control` marker, TTL 1 hour by default). The coin is the user message: one
`<coin_record>` block of JSON in which `<`, `>` and `&` are written as unicode escapes, so no
creator text can close the block or open a tag. The system prompt says the block is data, not
instructions. A test sends a description of "ignore previous instructions" and checks that the
request's system prompt is byte-identical to the one for an ordinary coin.

The version stored in `coins.classifier_prompt_version` is the template id plus the first eight hex
digits of a SHA-256 of the final system prompt (`classify-v0+247d2722`). Swapping the taxonomy
file changes the hash, which re-opens every coin for classification.

The default taxonomy is a draft copy of sections 2 to 7 of `docs/taxonomy.md` from branch
`claude/11-taxonomy-guide`. The lead replaces it with `--taxonomy PATH` or by editing the file.

## Dry run

`estimate.ts` explains the arithmetic. In short, per pass: requests, system-prompt tokens
(cacheable if at least 512), record tokens, and output tokens. Each request either reads the
cached system prompt or writes it; the expected figure uses the configured hit rate (default 90
percent), the ceiling figure assumes none. Characters become tokens at 3 per token by default,
which leans toward overcounting; `--count-tokens` measures the real system prompt and recalibrates.
The second pass is the coins already under 0.7 plus 15 percent of the first pass (PLAN.md's
assumption). A 1-hour write costs twice the input price, so with a poor hit rate caching costs more
than not caching; the dry run prints the "caching off" figure next to the others to show it.

Output tokens per coin (220) are a guess until the first run. Thinking is switched off on both
models so the estimate has no hidden thinking tokens.

## Resume and idempotence

State lives in `ingest_runs` (kind `classify`): `params.batches` holds one entry per batch (id,
pass, model, coin keys, ceiling estimate, state), `estimate` the plan, and `actual` the usage the
API reported, summed (`usage.input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`,
`output_tokens`), with dollars computed from them. In-flight coins have `coin_stages` row
`classified` at status `running` with the run id, and no selection returns them.

Order of events for one batch: save the entry with `id: null`, claim the coins, call `create`,
save the id. A restart (any `--confirm` run) first polls every saved id and applies its results,
then starts a new run. Results are applied only to coins still in flight for that run, so applying
twice writes once. If the process dies between the API creating a batch and the id being saved, the
entry stays without an id, its coins are released, and they can be sent again; that one window can
double-bill a batch. `actual.abandonedBatches` counts it, and the console will show the batch.
Usage is saved every 200 results, so a kill in the middle of applying can under-count the usage of
up to 200 results.

Statuses: a result that fails validation sets the stage to `failed` (up to 3 attempts, then it is
skipped unless `--force`) and writes nothing to the coin. An expired or canceled request goes back
to its earlier state without using an attempt. A failed second pass keeps the first result and
records the error on the stage.

## Needed in /db later

Nothing was changed outside `/pipeline`. `db-store.ts` holds the queries a `/db` helper could own
later: selecting coins to classify, claiming and releasing coins, applying a result, and the
`ingest_runs` bookkeeping. They are in `/pipeline` for now.
