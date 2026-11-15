# Memecoinipedia plan

Status: **approved 2026-11-14, Phase A in progress.** Last updated 2026-11-15.

A search engine and encyclopedia of past memecoins. Users find comparable coins and see how high they went. Scope for this plan: every pump.fun coin from 2024 onward that reached a $100k+ all-time-high market cap. Other chains come after, and the schema is keyed by chain so they fit.

Task status values: `todo`, `in progress`, `in review`, `blocked`, `on hold`, `done`. The lead updates this file after every task. Issue numbers refer to this repository's GitHub issues, which hold the live discussion for each task.

## How work flows

`AGENTS.md` sets the lanes and the workflow. This plan follows it.

| Lane | Owner | Who does the work |
|---|---|---|
| `/db`, `/ingest`, `/api`, `/pipeline` | Claude | Sonnet subagents `data-ingestion`, `backend-api` and `testing`, and the Haiku subagent `repo-chores`. Definitions are in `.claude/agents/`. |
| `/web`, `/scripts`, `/.github` | OpenAI Codex | Codex, from issues labelled `codex` |
| `/research/narratives` | Grok | Grok, from issues labelled `grok` |
| `/research/evals` | Muse | Muse, from issues labelled `muse` |
| Root config, `PLAN.md`, `/docs`, `/probes`, `.claude` | Lead | The lead. `AGENTS.md` does not list these yet; see Q11. |

- **Lead (Fable, in Claude Code)** owns this plan, the taxonomy, the metric rules, the API contract, every ambiguous call, and review of every pull request in every lane. The lead does not write bulk code.
- **One issue, one branch, one pull request.** Branches are named `<agent>/<issue-number>-<slug>`. Subagents that run in parallel each work in their own git worktree. The lead reviews every pull request against its acceptance criteria. You merge.
- **Status commits.** The lead commits status updates to this file straight to `main`. Everything else goes through a pull request.
- **"Codex" means two things.** Codex.io is the data API we buy candles from. OpenAI Codex is the coding agent that owns `/web`. This file says "Codex.io" for the API and "OpenAI Codex" for the agent.
- **Runtime classification** runs on the Anthropic API (Haiku with the Batch API and prompt caching, Sonnet for low-confidence re-runs), never through a Claude Code session.
- **Cost gates (relaxed by you on 2026-11-15).** You asked for the project to be finished as fast as possible, with an alert "if it gets too crazy pricing wise", and set $500 aside. So the lead no longer stops for approval before a paid step. Every paid job still has its estimate written in this file first, and still needs an explicit confirm flag and a spending ceiling. The lead alerts you before any spend beyond the plans already paid (Dune's 4,000 credits a month, Codex.io's 3 million compute units a month, Helius) or beyond about $500 in total.

## Decisions made

Recorded in `docs/data-sources.md` section 8: source mix approved, attribution accepted, free site with no data sales, market cap is price times 1 billion supply, candles are stored, non-SOL pump.fun launches are included, and the product name is Memecoinipedia.

Codex.io is the candle source. Its probe passed on 20 of 20 coins and you bought its Growth plan on 2026-11-14 ($360 a month, 3M compute units).

Approved with the plan on 2026-11-14:

| # | Decision | Answer |
|---|---|---|
| Q1 | Comparables for a coin we have never indexed | The endpoint accepts any pump.fun address and fetches its metadata on demand |
| Q2 | Survivorship bias | Every distribution is labelled "among coins that reached $100k+". A minimal row is kept for every graduate so a real hit rate can be added later. |
| Q3 | Status definitions | *Alive*: at least $1,000 of 24-hour volume and $5,000 of liquidity. *Dead*: below that for 7 days. *Rugged*: fell 80% or more within 30 minutes of its ATH and never recovered above half of it. Tuned on the 500-coin sample. |
| Q4 | Sensitive content | The classifier sets a `sensitive` flag; flagged images are hidden by default |
| Q5 | Eval split | 200 labels: 120 for tuning, 80 held back for the reported number |
| Q7 | Git flow | Initial commit to `main` by the lead, then pull requests the lead reviews and you merge |
| Q8 | Live freshness | Within one hour of crossing $100k |
| Q9 | Use the paid Codex.io month | The candle stage of the backfill moves to right after A6, inside the billing month that ends about 2026-12-14, with the cost estimate shown to you first |

## Decisions I need from you

| # | Decision | Recommendation | Needed by |
|---|---|---|---|
| Q6 | **Hosting.** Where do Postgres, the web app and the worker run in production? | Your call. | Phase D |
| Q10 | **Who labels the 200-coin eval set.** Your brief said you and I would hand-label it. `AGENTS.md` gives `/research/evals/labels.csv` to Muse. | Muse labels all 200 without seeing any classifier output, using Grok's research as evidence. You review every label where Muse's confidence is under 0.8 plus 40 picked at random, and the 120/80 split is frozen after you sign off. | B3 |
| Q11 | **Lead-owned paths.** `AGENTS.md` lists no owner for the root config files, `PLAN.md`, `/docs`, `/probes` or `.claude`. It also spells the product "Memecoinedpedia". | Add one row to the lanes table for the lead and correct the name. Sent as pull request #10 for you to accept or reject. | When convenient |
| Q12 | **Local database.** This machine has no running Docker and its Postgres has no pgvector. Phase A does not need pgvector; Phase B's embeddings do. For the Phase A run the lead created one database, `memecoinipedia_dev`, on this machine's Postgres on 2026-11-15. No other database is touched. | Install Docker Desktop, or let me run `brew install pgvector`. | B8 |

## Architecture

- **One language:** TypeScript for the web app, the worker and shared code.
- **Layout:** a pnpm workspace whose packages are the lanes.
  - `/db`: migrations, typed query access, seed data, the taxonomy values
  - `/ingest`: data-provider clients (`src/sources`), the price metric library (`src/metrics`, pure functions), the queue worker and per-coin pipeline (`src/worker`)
  - `/pipeline`: the Anthropic batch classification pipeline, parent-coin candidates, embeddings, the eval harness, and loaders for the research files
  - `/api`: the search and comparables API, and its contract in `/api/README.md`
  - `/web`: the Next.js site (OpenAI Codex)
  - `/research/narratives`, `/research/evals`: research and labels (Grok, Muse)
  - `/docs`, `/probes`: specifications, research and the provider probes
- **Queue:** pg-boss, which runs on the same Postgres. The backfill is limited by provider rate limits, far below what a Postgres-backed queue handles, so a separate Redis is not worth running.
- **Database:** Postgres with pgvector. Coins are keyed by chain plus contract address.
- **Ingestion is a per-coin pipeline** with stages: discovered, metadata, candles, metrics, classified, embedded. Each stage records completion per coin, so any run can stop and resume, and re-running a finished stage changes nothing. The backfill and the live worker use the same pipeline.
- **Research inputs.** Grok's batches are evidence, not ground truth: they feed Muse's labels and the taxonomy guide, and can be given to the classifier as context for the coins they cover. Muse's `labels.csv` is the eval set. Neither scales to the full backfill; the Haiku pipeline classifies everything. The pilot batch (B0) found a sourced origin story for the well-known coins and nothing reliable for 10 of the 20, all of them small and dead. So for most of the long tail the classifier has only the coin's own launch data to go on: name, ticker, description, image and socials.

### How ATH is calculated

This is the number the product rests on. The full rules are in `docs/metrics.md`; the implementation and the tests are written from that file by different agents. In short:

- Market cap is price in USD times 1,000,000,000.
- Prices come from pool-level bars: the bonding curve and the graduation pool always, and any other pool only while it holds at least $5,000 of liquidity. Codex.io's token-level bars and its own ATH fields are never used; the probe showed both are wrong for many coins.
- **A price counts as reached only if at least two 1-minute closes within a 3-minute span were at or above it, at least $1,000 traded in that span, and at least one of those minutes had 5 or more distinct traders.** For a full window this is the 3-minute median close. A single-candle spike cannot set the ATH. Neither can a print on an empty pool, or two wallets trading with each other.
- Where several pools trade in the same minute, the busiest pool's price is used, so a small side pool that drifts cannot set any metric.
- A coin can peak long after launch; one probe coin peaked a year later. Hourly or daily bars cover the coin's whole life, and 1-minute bars are fetched for every period that could hold the peak before the ATH is final.
- The raw maximum candle high is stored separately as `ath_wick`, so the difference is visible.
- Any market cap above $20 billion is treated as a data error and queued for review.
- Time above $100k, $1M, $10M and $100M, and max drawdown, come from a running price level. Thin trades can lower that level but cannot raise it. With no trades, the last level carries forward for at most 24 hours.
- Every ATH records which pool and which minute it came from.

The thresholds are starting values. Task A6 tunes them against the 500-coin sample.

## Target set (measured on Dune, 2026-11-15)

One Dune query lists every pump.fun coin that graduated since January 2024, with a rough peak market cap taken from Dune's hourly price table (the 99.9th percentile of the coin's hourly prices, times one billion coins). The queries, their costs and the checks behind them are in `ingest/sql/dune/README.md` (#22).

| Launched | Graduates | Hourly peak $30k+ | $50k+ | $100k+ | $1M+ | $10M+ | $100M+ |
|---|---|---|---|---|---|---|---|
| 2024 H1 | 18,449 | 14,793 | 11,366 | 6,985 | 1,495 | 573 | 100 |
| 2024 H2 | 56,964 | 49,198 | 37,989 | 23,735 | 4,181 | 974 | 448 |
| 2025 H1 | 65,829 | 50,965 | 35,486 | 20,559 | 3,292 | 739 | 225 |
| 2025 H2 | 22,853 | 19,450 | 14,333 | 8,065 | 1,099 | 181 | 35 |
| 2026 H1 | 48,653 | 21,489 | 14,641 | 8,654 | 1,329 | 218 | 47 |
| 2026 H2 (to 15 Nov) | 134,818 | 60,616 | 45,355 | 31,488 | 14,060 | 7,131 | 1,984 |
| **All** | **347,566** | **216,511** | **159,170** | **99,486** | **25,456** | **9,816** | **2,839** |

How to read it:

- **The hourly peak is not an ATH.** On the 20 probe coins it is 0.34 to 1.13 times the highest 1-minute candle high (median 0.62), because an hourly price flattens a short spike. A coin with an hourly peak of $34k can have touched $100k.
- **Candidates: 216,511.** Every graduate with an hourly peak of $30k or more is fetched and measured on candles. That floor is the safe cut for a $100k ATH.
- **Expected final size: roughly 100,000 to 160,000 coins at $100k or more.** This is the lead's estimate from the probe ratios. The 500-coin sample (A5, A6) measures it.
- **The top columns are inflated by bad prices.** 2,839 coins at $100M or more is far more than exist. Most of them are in the second half of 2026, when 21,000 to 34,000 coins graduate a month. Of the coins launched then with an hourly peak of $100k or more, half have a price in fewer than 30 hours (10 to 29 by month), against about 180 to 230 hours for earlier launches. Candles decide; the hourly figure only picks candidates.
- **Not in the list:** coins that passed $100k on the bonding curve without graduating (possible in weeks when SOL was above about $243), and 1,846 graduates with no hourly price. Both get an issue before the full backfill.
- **Other things the sample will meet:** from the second quarter of 2026 almost every new coin is a Token-2022 mint, and from September 2026 coins are paired with hundreds of quote coins other than SOL.

**Phase A sample.** 500 coins: the 20 probe coins plus 480 drawn in Dune, 80 per launch half-year, spread over five peak cells ($30k to $50k: 5, $50k to $100k: 10, $100k to $1M: 30, $1M to $10M: 20, $10M and above: 15), in a fixed order by hash of the mint so the draw can be repeated. File: `ingest/sql/dune/results/sample-2026-11-15.csv`.

**What it cost.** Discovery 3.2 credits, sizing 7.2, sample 7.4. Total used on Dune so far: 113 of 4,000 credits. That total includes two mistakes by the lead: 24.6 credits on two price-table probes that had to be cancelled (a cancelled run is still billed), and 49.1 credits on a test download whose body was not kept (a download is billed when requested). Downloads are the expensive part, at about 1.5 credits per 1,000 rows. So sizing and the sample were computed inside Dune, and the candidate list is downloaded once, at backfill time, for about 325 credits.

**What the backfill will cost on Codex.io.** 216,511 candidates at 20 to 30 compute units each is 4.3 to 6.5 million units. The plan includes 3 million a month. That means either $184 to $483 of overage in one month (at $138 per extra million), or two plan months. With a $50k floor (159,170 coins) it is 3.2 to 4.8 million units. A5 measures the real units per coin, and A6 says whether a $50k floor or a one-request screen is safe. The overage price and whether the account has an overage cap still need checking before E2.

**First measurement, 2026-11-15: 60 units a coin on the 20 probe coins**, not 20 to 30. At that rate the backfill would need about 13 million units, roughly $1,400 of overage. That is not acceptable, so the fetch plan is being changed before anything larger runs (see A5b). The lead's target for the staged plan is about 8 units for a coin that is screened out, 16 to 24 for a listed coin under $1M, and 40 to 120 for a large one: 3.5 to 4.5 million units in all, which is $70 to $210 of overage or a few weeks into a second plan month. The 500-coin run gives the measured figure.

**Second measurement, 2026-11-15, staged plan on 30 coins:** a screened-out coin costs 11 units on average, a coin on the light path 20, a coin on the full path 48 (median 26; the largest coins reach 150). The 20 probe coins cost 837 units against 1,254 before. The lead's estimate from these figures, by hourly-peak cell: 57,000 coins at $30k to $50k at 16 units, 60,000 at $50k to $100k at 19, 74,000 at $100k to $1M at 20, 15,600 at $1M to $10M at 26, 9,800 above $10M at 60. That is about 4.5 million units: 1.5 million over the month's plan, about $210 of overage, or nothing extra if the run is spread over two plan months. With a $50k floor it is about 3.6 million. Two things could bring it inside one month: half of the smallest coins are screened out for 11 units instead of 4 because Codex.io's launch info did not name their graduation pool, so taking that pool from Dune would save about 6 units a coin; and the $50k floor. Both wait for the 500-coin run (A5c), which measures the share of coins on each path, the share that needs the extra lookup, and how many coins in each cell end up listed.

## Pull requests waiting for you

Merge in this order. #14, #16, #17 and #18 are built on #8, so #8 goes first.

So that Phase A does not wait for the merges, the lead built the branch `claude/phase-a-base`: #8, #14, #20 (which contains #16), #17 and #18 merged together, with no conflicts. Typecheck and lint pass on it, as do 834 ingest tests and 24 database tests. A5 is built on it. It is not a pull request and is never merged itself.

| Order | Pull request | Task | State |
|---|---|---|---|
| 1 | #8 | P6 scaffold and metric interface types | Reviewed, ready |
| 2 | #14 | A1 schema, migrations, candle storage | Reviewed, ready |
| 3 | #16 | A2a Codex.io client | Reviewed, ready |
| after #16 | #20 | A2b metadata and current-price clients (Helius, IPFS, Jupiter) | Reviewed, ready. Built on #16. |
| 4 | #17 | A3 metric library, with clarifications to `docs/metrics.md` | Reviewed, ready |
| 5 | #18 | A4 metric fixtures | Reviewed, ready. With #17 merged, all 50 fixtures pass. |
| any | #10 | `AGENTS.md`: lead-owned paths and the product name (Q11) | Your decision |
| not yet | #12 | B1 taxonomy guide | Draft. Waiting for Muse's review (#13), then your approval. |
| any | #15 | B0 Grok's pilot batch | Reviewed, ready. Independent of the others. |
| any | #22 | P2 Dune queries, with the sizing result and the Phase A sample | Reviewed, ready. Independent of the others. |
| after #20 | #24 | A2c Dune client and candidate-list download | Reviewed, ready. Built on #20. |
| any | #28 | C0 API contract, `/api/README.md` | Written by the lead. Revised on 2026-11-15 with the points #36 found unclear. Please read the "Choices worth a look" in its description. Phase D issues for OpenAI Codex open once it is merged. |
| not yet | #30 | A5b candle plan and metric write-back | The staged plan is accepted. One more change requested: decide where to look for the peak by candle highs, not closes. Built on `claude/phase-a-base`. |
| after #18 | #31 | A5a pipeline core: worker, stage tracking, seeding, metadata | Reviewed, ready. Built on `claude/phase-a-base`. |
| after #18 | #32 | B4 classification pipeline | Reviewed, ready. Built on `claude/phase-a-base`. No live run yet: needs an Anthropic API key. |
| after #32 | #35 | B6 eval harness | Reviewed, ready. Built on #32. |
| after #28 | #36 | C1 search API: keyword search, filters, coin and narrative endpoints | Reviewed, ready. Built on `claude/phase-a-base`. |

## Phase 0: probes and setup

| ID | Task | Owner | Acceptance criteria | Status |
|---|---|---|---|---|
| P1 | Codex.io candle-history probe on 20 coins | data-ingestion | Per-coin table; pass or fail against "1-minute bars from the first minutes after graduation for 19 of 20"; terms quoted; under 400 requests. **Passed 20 of 20 with 201 requests.** Results in `docs/data-sources.md` section 7. | done |
| P2 | Dune sizing query: graduates per month, how many peaked at $100k+ | data-ingestion | Exact target-set count; credit cost of the query recorded. **Done on 2026-11-15 (#22, issue #21). The planned scan of every trade was dropped: three days of trades did not finish in four minutes on this Dune plan. Discovery now reads pump.fun's decoded tables and Dune's hourly price table in one query: 347,564 graduates for 3.2 credits. The sizing table and the 500-coin sample are computed inside Dune, because downloads are the expensive part. An exact count of coins at $100k or more needs candles; Dune gives the candidate list and a range. Results under "Target set".** | done; #22 approved, waiting for merge |
| P3 | DexPaprika candle-history probe, same 20 coins | data-ingestion | Same bar as P1. Run only if Codex.io's terms come back unfavourable (P7), or to test a cheaper long-term source. Needs a $99 Pro key. | on hold |
| P4 | Birdeye candle-history probe, same 20 coins | data-ingestion | Same bar as P1; storage terms read. Same condition as P3. | on hold |
| P5 | Choose the candle source and record why in `docs/data-sources.md` | lead | Decision backed by probe results. **Codex.io chosen**, conditional on P7. | done |
| P6 | Repo scaffold: workspace, TypeScript, lint, test runner, Docker Compose Postgres with pgvector, package skeletons, metric interface types. Issue #1. | repo-chores, lead | Clean clone: install, typecheck, lint and tests pass; the Compose database has pgvector available. **Install, typecheck, lint and tests pass. The Compose file is validated but has not been run: this machine has no Docker (Q12).** | in review (#8) |
| P7 | Written confirmation from Codex.io that we may store its bars and display statistics derived from them on a free public site | you (lead drafts the email) | Reply on file before E3. If the answer is no, P3 and P4 run. | todo |
| P8 | CI: install, typecheck, lint and test on every pull request, with a pgvector Postgres service. Issue #6. | OpenAI Codex | Fails when any step fails; needs no secrets; under 10 minutes | todo (after #8 merges) |

## Phase A: schema, 500 coins, ATH

| ID | Task | Owner | Depends on | Acceptance criteria | Status |
|---|---|---|---|---|---|
| A1 | Schema and migrations in `/db`: coins, pools, candles, narratives, per-coin stage tracking, eval labels, narrative research, ingest runs, data-issue queue. Issue #2. | backend-api | P6 | Migrations apply from empty and are safe to re-apply; unique on chain plus address; candle storage measured on real bars and projected for 100,000 coins; seed script loads fixtures. **Candles are stored as one row per pool per day: about 8 to 21 GB for 100,000 coins, against 18 to 48 GB as one row per candle. The projection extends the 60 sampled bars synthetically; A5 re-measures it on full series.** | in review (#14) |
| A2a | Codex.io client in `/ingest/src/sources`: token discovery, pools for a token, pool-level bars with pagination, shared rate limiter, compute-unit metering and budget. Issue #3. | data-ingestion | P5, P6 | Tests run from recorded fixtures with no live calls; rate limiter proven to hold its limit; dry-run returns planned calls and cost; spend is metered from the cost each response reports, and a per-run budget stops the job when it is reached. **Checked against the live API with 14 requests (about 49 compute units). Open: a coin's pool list is capped at 250, and large coins exceed it, so the graduation pool of a pre-March-2025 coin can be missing from the list; A5 takes it from Dune instead.** | in review (#16) |
| A2b | Metadata and current-price clients: Helius, IPFS with several gateways, Jupiter | data-ingestion | A2a, Helius key | Same test bar as A2a; verified against the live Helius API once the key arrives. Jupiter's `createdAt` is not used as a launch time: the pilot batch found it repeats across unrelated 2024 tokens, and our chain data confirms it is wrong for them. **Delivered as #20 (issue #19). Live check used 24 Helius requests (240 credits), 2 Jupiter, 74 gateway and 20 Codex.io requests (80 compute units). Findings: the create transaction costs one request and 10 credits per coin and matched Codex.io's creator on 20 of 20 probe coins (creation time within 2 seconds); all four 2026 probe coins are Token-2022; every probe coin's metadata still resolves, through `ipfs.filebase.io` and `gateway.pinata.cloud`, while `ipfs.io`, `dweb.link` and `cf-ipfs.com` no longer serve it; Jupiter needs no key at one request every two seconds. Review took three rounds: four small changes, then a fault my re-check found (metadata JSON nested thousands of levels deep crashed the fetcher; now limited to 64 levels and reported as invalid). 339 tests pass.** | approved, waiting for merge (#20) |
| A2c | Dune client (run SQL, read its cost, download CSV page by page, credit budget), reader for the candidate list, and the sizing and sample draw in code. Issue #23. | data-ingestion | A2b | Tests make no live calls; cost recorded is the cost Dune reports; downloads refused when over budget; sizing and draw tested at the boundaries and deterministic; runner resumable, capped by `--max-credits`, inert without `--confirm`. **Reworked for the single-query design with the facts from the live run: paginated download that never pays for a saved page twice, a 402 handled as its own error, the cost of a cancelled run read back. Its sizing code reproduces an independent count on a real 7,000-row page. 529 tests. Used at backfill time to download the candidate list. Four small changes were requested in review and made (ceiling across resumed runs, a zero measured cost, line ends between pages, sizing without the confirm flag); 537 tests.** | approved, waiting for merge (#24) |
| A3 | Metric library in `/ingest/src/metrics`, implementing `docs/metrics.md`. Issue #4. | data-ingestion | P6 | Pure functions; passes every A4 fixture; `ath` never exceeds `ath_wick`; time above $1M never exceeds time above $100k; result independent of input order. **Passes all 50 A4 fixtures. 11 deliberate faults planted in the library were each caught by the fixtures.** | in review (#17) |
| A4 | Edge-case fixtures with hand-worked expected answers, in `/ingest/test/fixtures/metrics`. Issue #5. | testing | P6 | Each fixture has the full expected output and the reasoning; written from `docs/metrics.md`, not from A3's code; every ambiguity found in the rules is reported. **50 fixtures. The ambiguities found are now settled in `docs/metrics.md` (in #17).** | in review (#18) |
| A5a | Pipeline core: queue worker (pg-boss), per-coin stage tracking, seeding of the 500 sample coins from the Dune sample file, and the metadata stage (Helius in batches, token metadata through IPFS gateways, Jupiter). Issue #25. | data-ingestion | A1, A2b, P2 | Creator and creation time come from Dune in bulk. Creation time and graduation time stay separate fields (CHILLGUY was created 40 days before it graduated). Image reference stored without a gateway host (`ipfs://<cid>/<path>` for IPFS content); copying images waits for Q6. Social links lost to the full-URL rule counted. Stage state survives a kill; a second run changes nothing. Live run of seeding and metadata for the 500 coins into the local database, inside 300 Helius credits, with no Codex.io calls. **Delivered as #31. The 500 coins are seeded in the local database; metadata is done for 490 and failed for 10 whose creator-hosted links are dead. Of the 490: 373 have a description, 482 an image reference, 342 at least one social link; 14 links were dropped by the full-URL rule. Helius cost 10 credits a run, as estimated. A second run does nothing. A worker killed with SIGKILL resumes with no duplicates. IPFS gateways rate-limit at 3 requests a second each, so the default is now 1.** | approved, waiting for merge (#31) |
| A5b | Candle fetch plan, pool selection, fetch under a compute-unit budget, peak refinement and metric write-back. Issue #26. | data-ingestion | A1, A2a, A3 | A pure, tested fetch plan that gives the metric library what `docs/metrics.md` section 12 asks for. Live check on the 20 probe coins inside 2,500 compute units; every coin whose ATH falls outside 0.5 to 1.1 times the probe's 1-minute high is explained. **Open: Dune's discovery query does not return the graduation pool, so a coin whose Codex.io pool list is cut off at 250 needs another source for it (the pool address derived from the mint, or Dune's pool-creation table). Delivered as #30. All 20 probe coins come out between 0.51 and 0.99 of the probe's 1-minute high, each explained by the 3-minute rule, and a second run makes no requests. But it cost 60 compute units a coin, twice the estimate. Sent back for a staged plan: daily bars of the graduation pool first, stop when the highest daily high is under $90k, graduation pool only for coins under $1M, hourly bars only on days at or above $80k. The exhaustive plan stays as a preset so A6 can measure what the cheap one loses. Reworked the same day: the staged plan costs 837 units for the 20 probe coins against 1,254, and 14 of the 20 come out with the same ATH. The other six showed a fault in the lead's own rule: a period was fetched at 1-minute resolution only when an hourly close beat the ATH, so a spike that collapsed inside the hour was never looked at (USOF: $2.65M measured, $4.25M real). The rule now uses the candle high. Sent back for that one change; the two plans must then agree on all 20 coins.** | changes requested (#30) |
| A5c | Wire the candle and metric stages into the pipeline and run the 500 coins end to end | data-ingestion | A5a, A5b | Estimate written here before the run; at least 98% of coins complete with reasons listed for the rest; a second run changes nothing; killing the worker mid-run and resuming completes with no duplicates; actual calls within 10% of the estimate; compute units per coin reported by peak cell. **Issue #37. Estimate for the run: about 19,000 Codex.io compute units (per coin by cell: 16 at $30k to $50k, 18 at $50k to $100k, 20 at $100k to $1M, 35 at $1M to $10M, 80 above $10M, 42 for the probe coins), with a hard ceiling of 30,000, which is 1% of the month's plan. The candle stage needs only the discovered stage, so a coin whose metadata failed still gets candles. The run starts after the lead has reviewed the wiring and the fix to #30.** | in progress (#37) |
| A6 | Validation: compare our ATH with Dune's rough ATH and with public figures for well-known coins; review the largest disagreements and the largest wick-to-ATH gaps; tune thresholds | lead, testing | A5 | Every coin whose ATH is outside 0.5 to 3 times Dune's hourly peak is reviewed and explained or fixed; well-known coins within 10% of their public ATH. (Changed by the lead on 2026-11-15 from "95% of coins within 15% of the Dune figure": the Dune figure is now an hourly price, which runs 0.34 to 1.13 times the 1-minute high on the probe coins, so a 15% band cannot hold.) Also report how many sampled coins in each hourly-peak cell reach a $100k ATH, which sets the candidate floor for the backfill. Also check the known weak points listed in `docs/metrics.md` section 13: how often one thin trade lowers the running level (it ends time-above, raises drawdown and can set the rug pattern), how often a busier thin window hides a qualifying one, and whether the five-trader rule drops real peaks. And confirm the cause of three coins where pump.fun's own page shows an ATH 10 to 20 times ours (Andrew, dodge, DSG; found in the review of #15). **Likely cause found on 2026-11-15: the low figure came from Codex.io's ATH summary field, which is wrong for many coins. For Andrew that field says $271k, while Codex.io's own candles reach $3.7M and Dune's hourly prices $1.6M. The pipeline computes ATH from candles and never uses that field.** | todo |

A3 and A4 run in parallel from the same written rules, so the tests are an independent check. A1, A2a, A3 and A4 all run at once after P6.

## Phase B: classification

| ID | Task | Owner | Depends on | Acceptance criteria | Status |
|---|---|---|---|---|---|
| B0 | Pilot research batch on the 20 probe coins, to test the research format. Issue #7. | Grok | none | `/research/narratives/batch-7.json` valid against the `AGENTS.md` schema; every claim sourced; boundary cases noted. **Delivered as #15. Seven edits were requested and made; approved on re-review. The pilot settled what `origin_date` means (the date of the thing the coin refers to, not the launch date) and showed that `other` was being used for "could not research".** | approved, waiting for merge (#15) |
| B1 | Taxonomy guide: a definition, boundary cases and tie-break rules for each of the 11 narratives, plus what counts as a derivative and its parent | lead, reviewed by Muse, approved by you | none (B0 helps) | `docs/taxonomy.md` approved by you. **Draft is in #12 (issue #11). Muse's review is issue #13, claimed 2026-11-15.** | in review (#12, draft) |
| B2 | Draw a 200-coin sample spread across eras, ATH sizes and likely narratives; open research issues for Grok in batches | lead, Grok | A5 | Sample list committed; a research batch covering every sampled coin | todo |
| B3 | Label the 200 coins in `/research/evals/labels.csv`: 120 for tuning, 80 held back | Muse, with you (see Q10) | B1, B2 | 200 labels in the `AGENTS.md` format; the split is frozen before any tuning; no classifier output seen while labelling | todo |
| B4 | Classification pipeline in `/pipeline`: Batch API, prompt caching, structured output (primary, up to three secondary, confidence, one-line reason, parent, sensitive flag, 2 to 3 sentence summary); re-run under 0.7 confidence on Sonnet | data-ingestion | A5, B1 | Dry-run prints token and cost estimate; cache reads confirmed in usage; every output validates against the schema; re-running skips finished coins. **Started early (issue #29), built with a fake client and a placeholder prompt: it does not wait for A5 or for the taxonomy guide. A live run needs an Anthropic API key in `.env`, which is not there yet. Delivered as #32: 91 tests, prices and limits checked against the current API reference. Its dry run puts 1,000 coins at about $0.47 for both passes (at most $1.93), so the whole set costs tens of dollars. Text only for now; images and thinking are tuning choices for B7.** | approved, waiting for merge (#32) |
| B5 | Parent candidates: for each coin, earlier and larger coins with a similar name, ticker or description, passed to the classifier as context | backend-api | A5 | Returns the right parent for a hand-checked set of 20 known derivatives | todo |
| B6 | Eval harness and loaders for `labels.csv` and the research batches: accuracy overall and per narrative, confusion table, accuracy by confidence band | testing | B3 | One command scores a run against the labels; the confidence bands show whether 0.7 is the right cut-off. **Delivered as #35 (issue #34), built on #32: loaders for the labels and the research batches, a seeded 120/80 split that is written once, and a scorer that prints accuracy with a Wilson interval, a confusion table, confidence bands and parent precision and recall. Holdout coins are withheld from every output unless asked for. The reported accuracy must come from runs without research notes, because research exists only for the eval coins.** | approved, waiting for merge (#35) |
| B7 | Prompt tuning | lead | B4, B6 | Primary-narrative accuracy above 90% on the 80 held-back coins; 50 summaries spot-checked for claims not supported by the coin's own data; Muse's review notes in `/research/evals/qa-<issue>.md` | todo |
| B8 | Embeddings: choose the model with a cost estimate, embed name, description, narratives and summary, add the vector column and index | data-ingestion, backend-api | B4, Q12 | Model choice and cost approved by you; all classified coins embedded; nearest neighbours for 20 spot-checked coins look sensible | todo |

Rough classification cost, to be re-estimated from real token counts before any run: about $10 to $30 per 100,000 coins on Haiku with batching and caching, plus about $50 per 100,000 coins if 15% need the Sonnet re-run. Embeddings should be under $10 for the full set.

## Phase C: search and comparables API

| ID | Task | Owner | Depends on | Acceptance criteria | Status |
|---|---|---|---|---|---|
| C0 | API contract in `/api/README.md`: endpoints, parameters, response and error shapes, with example responses OpenAI Codex can build `/web` against | lead | A1 | Covers search, coin, narrative and comparables; every field traced to a database column or a documented calculation. **Written as #28 (issue #27). The API is its own HTTP service that `/web` calls; only coins with an ATH of $100k or more are served; no chart endpoint (third-party embed).** | in review (#28) |
| C1 | Keyword search and filters (narrative, ATH range, launch date, status), with fuzzy matching on ticker and name | backend-api | A5, B4, C0 | 95th-percentile response under 200 ms on 300,000 synthetic rows; paginated; matches the contract. **Delivered as #36 (issue #33), against the contract in #28 and synthetic rows. The lead's own run: 95th percentile 106 ms for the search mix on 300,000 rows, 85 tests. Every request value reaches SQL as a bound parameter, and only listed coins are served. Semantic search and comparables answer `not_ready` until embeddings exist.** | approved, waiting for merge (#36) |
| C2 | Vector similarity search | backend-api | B8 | Index recall at least 0.95 against exact search on a sample; same latency bar | todo |
| C3 | Comparables: given a contract address, the nearest past coins and their ATH distribution (median, p75, p90, max) | backend-api | C2 | Statistics match a brute-force reference; sample size always returned; fewer than 10 neighbours returns an explicit "not enough comparables" result; unknown addresses handled per Q1 | todo |
| C4 | API tests | testing | C1, C2, C3 | Covers filters, pagination, bad input, and the comparables statistics on a fixture with a known answer | todo |

## Phase D: frontend

All of Phase D is in `/web` and belongs to OpenAI Codex. Each task becomes an issue labelled `codex` once C0 is merged; the lead reviews each pull request.

| ID | Task | Owner | Depends on | Acceptance criteria | Status |
|---|---|---|---|---|---|
| D1 | Layout, shared components, number and duration formatting, provider attribution | OpenAI Codex | C0 | Creator-written text renders as plain text only; images come from our own storage; attribution visible | todo |
| D2 | Search page | OpenAI Codex | D1, C1 | Keyword, filters and pagination work; empty, loading and error states checked | todo |
| D3 | Coin page: identity, metrics, summary, narratives, parent, socials, embedded chart | OpenAI Codex | D1 | Server-rendered for search engines; flagged images hidden per Q4 | todo |
| D4 | Narrative page: coins in a narrative with its ATH distribution | OpenAI Codex | D1, C1 | Sample size shown beside every distribution | todo |
| D5 | Comparables page | OpenAI Codex | D1, C3 | The "$100k+ only" caveat from Q2 is visible; "not enough comparables" state handled | todo |
| D6 | End-to-end tests and an accessibility pass | OpenAI Codex | D2 to D5 | Each page's main path and failure states covered | todo |

D2 to D5 can run in parallel after D1.

## Phase E: full backfill and live worker

| ID | Task | Owner | Depends on | Acceptance criteria | Status |
|---|---|---|---|---|---|
| E1 | Backfill orchestration: enqueue from the discovery list, progress view, pause and resume, rate budget | data-ingestion | A6 | A 5,000-coin run measures throughput, failure rate and cost per coin | todo |
| E2 | **Cost estimate for the full backfill, shown to you.** Data first (per Q9), then classification and embeddings, from E1's measurements. | lead | E1 | Estimate written here and sent to you. If it fits inside the plans already paid, the lead goes ahead. **Anything beyond them (Codex.io overage, a second plan month) is flagged to you before it is spent.** | todo |
| E3 | Full backfill: the candle and metric stages inside the paid Codex.io month, classification and embeddings once Phase B passes | data-ingestion | E2 approved, P7 | Resumable and idempotent as in A5; final spend reported against the estimate | todo |
| E4 | Live worker: graduation feed, watchlist polling, ingest and classify a coin when it crosses $100k | data-ingestion | E3 | A coin crossing $100k appears within the Q8 target; a missed feed message is recovered by the daily sweep | todo |
| E5 | Daily refresh of current market cap and status | data-ingestion | E3 | Full sweep finishes inside a day on free-tier limits | todo |
| E6 | Monitoring and a runbook | data-ingestion, repo-chores | E4 | Alerts on a stalled queue and on provider errors; runbook covers restart and re-ingest | todo |

## Budget summary

| Item | Estimate | When it is confirmed |
|---|---|---|
| Probes | $0 spent. DexPaprika's $99 is not needed so far. | Done |
| Codex.io Growth plan | $360 a month, bought 2026-11-14. Phase A uses under 1% of a month's quota. | Paid |
| Full backfill data | Measured 2026-11-15: 216,511 candidates. On Codex.io the staged plan needs about 4.5 million compute units (lead's estimate from 30 coins) against 3 million a month in the plan: about $210 of overage, or no extra cost if spread over two plan months. With a $50k floor, about 3.6 million. The 500-coin run replaces this estimate. On Dune, about 325 credits to download the candidate list, inside the credits already paid. See "Target set". | E2 |
| Dune | Analyst plan, 4,000 credits a month, in place since 2026-11-15. 113 credits used so far. | Paid |
| Set aside by you for extra spend | $500 (2026-11-15). Nothing drawn. | When an estimate goes beyond the paid plans |
| Classification and embeddings | Roughly $60 to $90 per 100,000 coins | B4 dry-run, then E2 |
| Live running cost, data | $360 a month on the current plan, which is the smallest paid size. Live use needs a small fraction of it. | E4 |
| Hosting | Not estimated | Q6 |

## Later: other chains

Ethereum, Base, BNB and others. Out of scope for this plan. The chain-keyed schema, the per-coin pipeline and the source clients are the pieces built to be reused.
