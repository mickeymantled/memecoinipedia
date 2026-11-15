# Data sources for pump.fun launch history and OHLCV

Status: **approved 2026-11-14**, then updated the same day with the Codex probe result (section 7). Prices and terms were read on 2026-11-14.

How to read the confidence labels used below:

- **Verified**: I read the provider's own page or source code myself.
- **Reported**: a research agent read the provider's page; I did not recheck it.
- **Secondary**: comes from news or a third-party blog.
- **Inferred**: arithmetic or reasoning on top of the above.

## 1. Recommendation

Use four cheap sources, each for the job it is good at, and keep one ingestion code path per coin that serves both the backfill and the live worker.

| Job | Source | Cost | Why |
|---|---|---|---|
| Find every candidate coin, size the target set, cross-check our ATH numbers | Dune SQL (one-off queries) | 7-day trial, then about $75/mo only in months we query | Its Solana DEX trades table already decodes the pump.fun curve, PumpSwap and Raydium with USD amounts. One query lists every graduate and a rough peak market cap. |
| Price history per coin (candles), for backfill and for live | **Codex** (Growth plan, bought 2026-11-14). DexPaprika Pro and Birdeye are untested fallbacks. | $360/mo for 3M compute units, $138 per extra 1M | The only candle source proven so far: 1-minute bars from the minute of graduation for 20 of 20 test coins, including pools dead since 2024, with trade, trader and liquidity counts on every bar. The same per-coin fetch serves the backfill and new coins. |
| Launch metadata (name, ticker, description, image, socials) | Helius DAS plus direct IPFS fetches | $0 to $49/mo | 1,000 mints per call at 10 credits. 300,000 mints is about 3,000 credits. |
| Current market cap and alive/dead refresh | Jupiter Tokens API, DexScreener as cross-check | $0 | 100 mints per call. A sweep of 300,000 coins is about 3,000 calls. |
| Live detection of new graduates | PumpPortal migration stream, Helius websockets as fallback | $0, or $49/mo | Free stream of graduations. Crossing $100k is then detected by polling the free refresh sources. |

**Expected spend** (Inferred): Codex at $360 a month is now the main data cost. At 20 to 30 compute units per coin, one month's 3M units covers 100,000 to 150,000 coins. The backfill therefore costs $360 if the target set is that size, and up to about $1,200 at 300,000 coins. Dune adds about $75 in months we query it. Classification and embedding costs are separate and are in PLAN.md.

**What is still open.** Codex's terms do not clearly permit storing its data or displaying statistics derived from it, so written confirmation is needed before the full backfill (section 7). The size of the target set still needs the Dune query. DexPaprika at $99 a month might do the same job for less, but it is untested and would need its own probe.

## 2. What the research changed

### The target set is probably smaller than "hundreds of thousands"

- pump.fun has launched somewhere between 18 and 24 million tokens (Secondary; sources disagree and none is primary).
- Graduates, meaning coins that completed the bonding curve, are probably 250,000 to 430,000 (Inferred from a 1.4% to 1.8% graduation rate).
- Coins that peaked at $100k or more are a subset of graduates, and the share swings with the SOL price. A coin graduates at about 411 SOL of market cap (Inferred from the curve constants in pump.fun's public docs). At SOL near $170 to $250, that is $70k to $100k, so a large share of graduates crossed $100k. In August 2026 the median market cap at graduation was $30,558 and only 9.1% of priced graduates peaked at $100k or more (Verified on the MadeOnSol August 2026 report: 1,536 of 16,935).
- My estimate is 30,000 to 150,000 coins at $100k or more (Inferred, wide error bars). One Dune query gives the exact number, which is why it is the first probe.

The cost tables below use 50,000, 100,000 and 300,000 so the plan holds at either end.

### Graduated coins are the candidate set

A coin on the bonding curve stays under about 411 SOL of market cap, which is under $100k unless SOL is above about $243 (Inferred). So:

- Candidates are graduated coins. There is no need to index all 18 to 24 million launches.
- One edge case: in the weeks when SOL was above about $243 (late 2024 and January 2025), a coin could touch $100k near the end of the curve and fall back without graduating. The Dune discovery query should include curve trades for those weeks.
- Because every $100k crossing happens at or after graduation, the metrics (ATH, time above thresholds, drawdown) need candles from the post-graduation pools. Curve-phase candles are nice to have, not required.

### Indexing facts that any source has to handle

- Graduated coins went to Raydium until 2025-03-20 and to PumpSwap after that (Secondary, The Block). A coin can also trade in side pools on Orca, Meteora and others, some with tens of dollars of liquidity (Reported from a live probe). Those dust pools are where bad wicks come from, so pool selection matters as much as candle filtering.
- Program IDs (Reported from pump.fun's public docs): bonding curve `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`, PumpSwap `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`.
- pump.fun's instruction and event formats changed several times: new trade instruction versions (v2, v3), quote mints other than SOL (USDC, and other pump coins up to two levels deep), holder-reward fields, and PumpSwap pricing on "effective" reserves that can differ from the vault balance (Verified in the pump-public-docs README). Market cap is therefore not always SOL-denominated.
- New coins since November 2025 are reportedly created with `create_v2` under Token-2022, with metadata no longer in Metaplex (Secondary: pump.fun's developer Telegram channel and Chainstack). A decoder or metadata fetch that assumes classic SPL tokens will miss them.

These format changes are the main argument for buying decoded data instead of decoding raw transactions ourselves.

## 3. Sources compared

### 3a. Bulk SQL warehouses

| Source | Status | pump.fun coverage | Price | Verdict |
|---|---|---|---|---|
| Dune | Live | `dex_solana.trades` unions `pumpdotfun_version_1_base_trades`, `pumpswap_version_1_base_trades` and `raydium_v4_base_trades` among 36 models (Verified in Dune's Spellbook source). Has `amount_usd`. Refreshes about every 3 hours (Reported). | Free plan is view-only. 7-day trial with 2,500 credits; a card is required (Verified). Analyst about $75/mo for 4,000 credits, Plus about $399/mo for 25,000 (Reported, derived from the credit table; Dune's pricing page showed me no dollar figures). Export 2 to 10 credits per MB. | **Use for discovery, sizing and cross-checks.** |
| Allium | Live | `solana.dex.trades` with `usd_amount` for pumpfun, pumpswap, raydium (Reported) | Sales-quoted; no verified price | Skip unless Dune fails |
| Bitquery Data Store | Live | Parquet dumps: trades, creations, migrations, pools, 1-minute OHLCV (Reported) | $3,000 for the latest 12 months; earlier history needs a custom quote (Reported) | Too expensive for what we need |
| Goldsky, SQD, Substreams | Live | Decoded or raw streams into your own database; no USD column on Goldsky (Reported) | Not published | Skip |
| BigQuery public Solana dataset | Stale since 2025-03-31 (Secondary) | Raw only | n/a | Do not use |
| Flipside | Data business sold to SonarX in May 2026 (Secondary) | Unknown | Unknown | Do not use |
| Sim by Dune | Shut down 2026-08-01 (Reported) | n/a | n/a | Gone |

Dune could also compute every metric in SQL and export only the results. I am not recommending that as the primary path, for three reasons. The credit cost of a heavy scan is undocumented and can only be measured by running it. Dune's terms say exports cannot be "provided on a running basis as a data product" and require attribution (Reported), which is a grey area for a public encyclopedia. And the live worker needs a per-coin fetch path anyway, so a second, SQL-only backfill path is extra code to keep correct. As a cross-check it is ideal: a rough per-coin ATH from Dune, compared with ours, flags the coins where our wick handling disagrees.

### 3b. Per-coin candle APIs

Planning assumption: 6 calls per coin (three for 1-minute candles over the first 48 hours, two for hourly candles after that, one for metadata). Coins that lived for months need more hourly calls or daily candles; they are a small share.

| Source | History and resolution | Plan | Backfill cost and time | Storage and display terms | Open risk |
|---|---|---|---|---|---|
| **DexPaprika** | 1-minute and up "since 2024" on Pro; token-level and pool-level OHLCV (Verified on pricing page) | Pro $99/mo, 5M credits, 500 req/min, 1 credit per request. Overage $20 per 1M (Verified) | 300k coins: 1.8M credits, $99, about 60 hours. 100k coins: about 20 hours. | Commercial use on paid plans. "Powered by DexPaprika" attribution required. No caching limit stated. Copying data is limited to integrating it in your application (Verified in API terms) | Curve coverage, dead-pool retention and max candles per call are untested. Keyless probe returned 402. |
| **Birdeye** | OHLCV by token or pair, up to 5,000 candles per call; candles carry volume (Reported). Depth for 1-minute and hourly candles not stated. | Premium $199 (20M CU), Business $499 (60M CU), B-15 $899 (150M CU) (Verified) | About 200 CU per coin (Inferred). 50k coins: $199. 100k: $499. 300k: $499 at the quota limit, $899 to be safe. Hours of wall clock. | Not read | History depth and curve coverage untested |
| CoinGecko Onchain (GeckoTerminal) | 1-minute pool and token OHLCV from 2021 on Analyst and above (Verified). Keyless access is limited to 180 days (Reported from a live 401). | Analyst $129 (500k credits), Lite $499 (2M), 500 req/min, overage $0.0005 per call (Verified) | 100k coins: about $180. 300k coins: $499. About 60 hours. | **Conflicts with our use.** "We do not encourage caching or storage of Data", refresh at least every 24 hours, delete everything on termination, no storing or deriving outside the terms (Verified, sections 6.1, 6.2, 10.4.3). Redistribution licence is Enterprise only. | Best-documented depth, but not usable for a stored encyclopedia without a negotiated licence |
| **Codex** | 1-minute bars from pool creation, including dead 2024 pools; bars carry volume, trade and trader counts and liquidity (Verified by probe, section 7) | Growth $360/mo for 3M compute units, 300 req/s, overage $138 per 1M (Verified) | 4 units per request, 20 to 30 per coin. 100k coins: one month. 300k coins: about $775 to $1,200. | Generic site terms with no data licence and no attribution rule; reusing content commercially needs written permission (Reported by the probe agent) | **Chosen.** Terms need written confirmation. |
| Solana Tracker | pump.fun-specific; separates curve and PumpSwap markets; graduated-token list endpoint (Reported) | Premium €397/mo for 10M requests (Reported) | €397 | Not read | Chart depth not documented |
| Moralis, Mobula, CoinMarketCap DEX | Pair OHLCV exists; depth and unit costs not found (Reported) | Various | Cannot compute | Not read | Skip |
| DexScreener, Jupiter | No historical candles (Reported from live probes) | Free | n/a | n/a | Use for current-market-cap refresh and a free chart embed |

### 3c. Raw chain (decode it ourselves)

Helius `getTransactionsForAddress` costs 10 credits per 100 full transactions (Verified). Plans are $49 for 10M credits and $499 for 100M (Reported). At 0.1 credit per transaction, 100M credits buys about a billion transactions.

This route has the cleanest rights position, because the data is the public chain and nobody's terms govern what we derive from it. It also gives trade-level data, the best possible input for ATH. Against that: we would write and maintain decoders for the curve, PumpSwap and Raydium across every format version listed in section 2, build our own SOL/USD and USDC pricing, and the total transaction count is unknown because a few large coins have tens of millions of trades each. I recommend keeping it as the fallback if candle APIs fail their probes or a licensing problem appears, not as the starting point.

### 3d. pump.fun's own API

Not usable. Every keyless request to its frontend API hosts returned a Cloudflare challenge or `access_denied` (Reported from live probes), there is no documented public data API, and `robots.txt` disallows `/api/`. The official docs repo covers the on-chain programs only.

### 3e. Launch metadata

- Name, ticker and metadata URI: Helius DAS `getAssetBatch`, 1,000 mints per call, 10 credits per call (Verified). 300,000 mints fits in the free tier's credits.
- Description, image and socials sit in the JSON at the metadata URI, on IPFS. Whether 2024-era IPFS content still resolves is unknown. Phase A's 500 coins will measure the miss rate.
- Creator wallet and launch time come from the create event: from the Dune discovery query in bulk, or one or two Helius calls per coin for live.
- Images should be copied to our own storage at ingestion. IPFS gateways are rate-limited and the files can vanish.

### 3f. Live worker

| Need | Source | Cost |
|---|---|---|
| New graduations as they happen | PumpPortal `subscribeMigration` (Reported; its legal and fee pages could not be read) | Free |
| Paid fallback for the same | Helius enhanced websockets, Developer plan (Reported) | $49/mo |
| Detect a coin crossing $100k | Poll current market cap for all graduates with Jupiter (100 mints per call, 1 request per second on a free key) | Free. Recent graduates every few minutes, the full set daily. |
| Fetch history once a coin qualifies | Same candle API as the backfill | Included in $99/mo |
| Trade-level streaming, if polling proves too slow | Flat-rate Yellowstone gRPC: Chainstack from $49/mo, Solana Tracker €200/mo (Reported) | Only if needed |

## 4. Backfill cost by scenario

Data cost for one backfill month, excluding classification and embeddings (Inferred from the prices above).

| Target set | DexPaprika Pro | Birdeye | CoinGecko (if licensed) | Wall clock at 500 req/min |
|---|---|---|---|---|
| 50,000 coins | $99 | $199 | $129 | about 10 hours |
| 100,000 coins | $99 | $499 | about $180 | about 20 hours |
| 300,000 coins | $99 | $499 to $899 | $499 | about 60 hours |

Add about $75 for a Dune month and $0 to $49 for Helius. Every row fits inside one billing month.

**Codex, measured by the probe:** 20 to 30 compute units per coin (pair listing, 1-minute bars for the first 48 hours, hourly and daily bars after, 1-minute bars again for peak days).

| Target set | Compute units | Cost on the 3M Growth plan |
|---|---|---|
| 50,000 coins | 1M to 1.5M | $360, one month |
| 100,000 coins | 2M to 3M | $360, one month, close to the limit |
| 300,000 coins | 6M to 9M | $720 to $1,080 over two or three months, or about $775 to $1,200 in one month with overage at $138 per 1M |

Codex allows 300 requests a second on this plan, so the backfill is limited by quota, not by time.

## 5. Risks

1. **Codex's terms are the main open risk.** History for dead 2024 pools is now proven on Codex (section 7), but its terms do not clearly allow storing bars or displaying statistics derived from them. If Codex says no, the fallbacks are the DexPaprika and Birdeye probes, then Dune-computed metrics or raw-chain decoding.
2. **Candle APIs hide pool selection.** A token-level candle may blend in a dust pool. Our ATH rules need to work on volume and on cross-checks against Dune, and PLAN.md should require that every ATH is traceable to a pool and a time.
3. **Attribution and terms.** DexPaprika and CoinGecko require a visible "Powered by" credit; Codex's terms require none. Storage terms for Birdeye and Solana Tracker have not been read and must be before we pay for either.
4. **Dune terms** are a grey area for publicly displayed derived data. Using it for discovery and internal cross-checks is the conservative reading; displaying Dune-computed numbers would need a written answer from Dune.
5. **Unofficial free pieces** (PumpPortal, Jupiter's free tier) can change or disappear. Each has a paid fallback listed above.
6. **Non-SOL quote mints and Token-2022 coins** from 2026 must be included in the probe sample, or the pipeline will silently drop the newest coins.

## 6. Not recommended, and why

- **CoinGecko Onchain** as the stored source: terms forbid long-term storage without an Enterprise licence.
- **Bitquery Data Store**: $3,000 or more, and it does not cover 2024 off the shelf.
- **pump.fun frontend API**: blocked, undocumented, disallowed by robots.txt.
- **Unofficial scraping of GMGN and similar sites**: against their terms.
- **BigQuery public dataset, Flipside, Sim**: stale, sold, or shut down.

## 7. Probes before committing

Each needs an account, which I have not created. Total cost is at most $99.

| # | Probe | Needs | Passes if |
|---|---|---|---|
| 1 | **Size the target set.** One Dune query: graduates per month, how many peaked at $100k or more, trade counts per coin. | Dune trial (free for 7 days, card required) | We get an exact count, and the query's credit cost is small enough to rerun monthly |
| 2 | **Candle depth on DexPaprika.** 20 hand-picked coins across early 2024, late 2024, 2025 and 2026, including dead coins, a Token-2022 coin and a USDC-quoted coin. | DexPaprika Pro, $99 for one month (the free and $30 tiers only keep 7 and 30 days) | 1-minute candles exist from the first minutes after graduation for at least 19 of 20, with volume |
| 3 | **Same test on Birdeye and Codex free tiers** | Free keys (Codex charges a one-time $1 signup fee) | Same bar. Gives us a fallback and a second opinion on ATH for the same coins. |

### Probe 3 result: Codex passed (2026-11-14)

Run by a Sonnet agent with 201 requests. I checked its report against the raw output in `probes/codex-probe-results.json`, which is kept locally and not committed because it holds raw provider data. The test set is `probes/coins.json`: four well-known coins and 16 obscure graduates from April 2024 to September 2026, 14 of them dead.

- **History:** 1-minute bars start in the minute the graduation pool was created, for 20 of 20 coins. 18 had all 60 bars in the first hour. The other two had 59 and 56 because some minutes had no trades.
- **Bar contents:** open, high, low, close, volume, buys, sells, buyers, sellers, traders, transactions and liquidity.
- **Venues:** Raydium pools from 2024, PumpSwap pools from 2025 and 2026, and a USDC-quoted coin all work.
- **Cost:** 4 compute units per bars request or pair listing, whatever the bar count, and at most 1,500 bars per request. Every response reports its own cost, so spend can be metered exactly.
- **Accuracy:** for the one coin young enough to compare, the first bars matched GeckoTerminal within about 1%. For the well-known coins the pool-level peak was 5% to 11% above publicly reported ATHs, which is the raw-wick effect our ATH rules are meant to remove.

What the probe says we must not do:

- **Do not use Codex's own ATH fields.** They were 3 to 15 times lower than the bars for most 2024 and 2025 coins.
- **Do not use its token-level bars.** They blend in dust pools. One coin showed a $13.1M daily high against $1.24M in its real pool. Use pool-level bars from the graduation pool.
- **Do not treat raw bar highs as ATHs.** One coin's peak minute had 7 trades from 2 traders. Another opened a bar at $4.29M and closed it at $0.012M.

Gaps:

- **Discovery before 2024-04-21.** Codex's pump.fun "migrated" filter returns nothing earlier, so graduates from January to April 2024 must be found through Dune.
- **Curve-phase bars** are missing for the four largest 2024 coins. They are not needed for ATH.
- **Token-2022 coins** were not positively identified in the test set.
- **Terms.** Codex's terms of service (updated 2026-10-29) are generic site terms with no data licence. Section 8 bars copying or reusing content "for commercial purposes or for personal gain" without written permission, and nothing addresses storing API data or displaying derived statistics. Written confirmation from hello@codex.io is needed before the full backfill.

### What building the client added (2026-11-14)

Found against the live API while writing the Codex.io client (task A2a), with 14 requests costing about 49 compute units.

- **Prices are USD.** For the same pool and minute, Codex.io and GeckoTerminal agree within 0.2% on open and close.
- **Bars.** A request for exactly 1,500 buckets works and 1,501 is rejected. 48 hours of 1-minute bars is 2 requests; a year of hourly bars is 6.
- **Costs are not quite flat.** A bars request costs exactly 4 units. A token lookup costs 4.0044. The pool listing costs 4 plus about 0.0048 per pool returned, so 5.2 for a full page of 250. `filterTokens` costs 5 plus about 0.0048 per token. The client records the cost each response reports and falls back to these figures only when a response reports none.
- **Discovery paging.** `filterTokens` returns at most 200 rows per request, and `limit` plus `offset` cannot pass 10,000. The `count` it returns is the size of the page, not a total. Discovery therefore walks the calendar in windows and restarts inside a window that is still full at 10,000 rows.
- **The pool listing is capped at 250 and big coins exceed it.** CHILLGUY's list is full of dust pools on other venues. Its graduation pool was still in the list, but for a large coin with no migrated pool address (most coins before March 2025) the pick is made from a truncated list and is not guaranteed. The client marks such picks as unverified. The fix is to take the graduation pool for those coins from Dune.
- **Some pool creation dates are wrong.** The Raydium pool for CHILLGUY is dated 12 seconds after migration, as expected, but other pools on the same token carry 2026 dates. Creation time is only trusted for choosing the graduation pool.

### Where the other probes stand

- **Probe 1 (Dune)** is still needed: for the target-set count, for discovery before April 2024, and as the independent ATH cross-check. Codex cannot cheaply tell us which graduates peaked at $100k, because its ATH fields are unreliable and checking every graduate's bars would use about a month of quota.
- **Probe 2 (DexPaprika, $99)** is on hold. Buy it only if Codex's terms come back unfavourable, or to test a cheaper long-term source.
- **Birdeye** is on hold for the same reason.

## 8. Decisions (answered 2026-11-14)

1. **Recommendation and probes: approved**, including up to $99 for a DexPaprika Pro month.
2. **Accounts and keys.** You create the provider accounts and the keys go in a local, git-ignored `.env`. The Codex key is in place, and you bought Codex's Growth plan ($360 a month, 3M compute units, billing period started 2026-11-14). Still needed: Dune and Helius. DexPaprika and Birdeye are on hold.
3. **Attribution: accepted.** A visible "Powered by" credit on the site is fine.
4. **Monetisation: free site, no data sales.** Standard paid API plans with attribution should cover this. Selling data or an API later would need the licences revisited.
5. **Market cap = price times the fixed 1 billion supply.** Burned supply is ignored.
6. **Candles are stored** (1-minute for the first 48 hours, hourly after) so ATH rules can be retuned without refetching. The coin page embeds a free third-party chart.
7. **Non-SOL launches are included.** USDC-quoted and coin-paired pump.fun launches are converted to USD.
8. **Product name: Memecoinipedia.**

### Jupiter's rate limit in practice (found 2026-11-15)

Jupiter documents 0.5 requests a second without a key and 1 with a free key. A metadata run sent about 1,250 requests at exactly that rate and met HTTP 429 after half an hour, so the client paces at 80% of the documented rate. A 429 pauses every Jupiter request of the process until `Retry-After` (capped at 5 minutes; 60 seconds when the header is absent), and the request that met it is sent again afterwards, in a fresh attempt of the HTTP helper (the pause is never waited inside one of the helper's attempts, which carry a 30-second timer; the helper's own five tries stay for 5xx and network errors). Five pauses in a row with no answer below HTTP 400 between them stop the run with one message: the request that met the 429 waits through the first four pauses, so up to 4 minutes by default and 20 minutes at the cap. The coins of the batch are left to be retried by the next run: the status report shows them as failed with the reason `jupiter_rate_limited`, and no attempt is spent. Pauses and the seconds paused are counted in the usage tally and shown by the status reports.

### Social links: where they come from and whom to trust

A coin has up to three links in `coins.socials` (`website`, `twitter`, `telegram`), and `coins.socials_source` says where they came from: `metadata_file` or `jupiter`.

1. **The coin's own metadata file** (`metadata_file` stage, one gateway request a coin) is the record of what the creator published at launch. It is the most trusted source. `socials_source = metadata_file` means the file was read (outcome `ok`): the coin keeps the file's links, also when the file held none, and Jupiter never overwrites them. A file stage that ends done without reading the file (not found, invalid, too large, unsupported URI) learns nothing, so it changes neither the links nor the source.
2. **Jupiter's token answer** (`metadata` stage, 100 coins a request, no extra request) carries the same three fields. It fills every coin whose source is not `metadata_file`, with source `jupiter`. Jupiter's links are what the token page shows now, and a token's owner can edit them after launch, so they say where the coin is today, not what it said at launch.
3. **Order.** When a file is read for a coin that holds Jupiter's links, the file's links replace them and the source becomes `metadata_file`.

Both sources go through the same link cleaning (a link is kept only as a full http(s) URL without credentials; anything else is dropped and recorded in the `social_links_dropped` issue, with its source). One function decides which links a coin ends up with, and both stages call it.

## 9. Sources

- Dune Spellbook, Solana DEX trades model: https://github.com/duneanalytics/spellbook/tree/main/dbt_subprojects/solana/models/_sector/dex
- Dune pricing FAQ and API billing: https://docs.dune.com/learning/how-tos/pricing-faqs , https://docs.dune.com/api-reference/overview/billing.md
- Dune application terms: https://dune.com/application-terms
- DexPaprika pricing and API terms: https://dexpaprika.com/api/pricing , https://dexpaprika.com/api/terms
- Birdeye pricing: https://data.birdeye.so/docs/guides/payment/pricing.md
- CoinGecko pricing, API terms, pump.fun page: https://www.coingecko.com/en/api/pricing , https://www.coingecko.com/en/api_terms , https://www.coingecko.com/en/api/launchpads/pump-fun
- Codex pricing, getBars, pump.fun launchpad docs, terms: https://www.codex.io/pricing , https://docs.codex.io/reference/getbars , https://docs.codex.io/launchpads/pump-fun.md , https://dashboard.codex.io/terms
- Solana Tracker pricing and pump.fun guide: https://docs.solanatracker.io/pricing.md , https://docs.solanatracker.io/guides/pumpfun
- Bitquery pump.fun datasets: https://bitquery.io/datastore/datasets/pumpfun
- Helius credits, pricing, DAS: https://www.helius.dev/docs/billing/credits , https://www.helius.dev/pricing , https://www.helius.dev/docs/api-reference/das/getassetbatch
- pump.fun public docs: https://github.com/pump-fun/pump-public-docs
- PumpPortal data API: https://pumpportal.fun/data-api/real-time
- Jupiter Tokens API: https://developers.jup.ag/docs/tokens
- DexScreener API reference: https://docs.dexscreener.com/api/reference
- MadeOnSol August 2026 deployer stats: https://madeonsol.com/blog/pump-fun-deployer-stats-august-2026
- PumpSwap launch (The Block): https://www.theblock.co/news/business/2025-03-20-pump-fun-launches-dex-called-pumpswap-to-instantly-migrate-graduated-tokens-347360
- BigQuery dataset stopped updating: https://discuss.google.dev/t/public-solana-bigquery-dataset-crypto-solana-mainnet-us-stopped-updating-on-march-31-2025/185629
- Flipside sale to SonarX: https://einpresswire.com/article/913502316/flipside-sells-blockchain-data-business-to-sonarx-commits-fully-to-edisyl-enterprise-ai-platform
