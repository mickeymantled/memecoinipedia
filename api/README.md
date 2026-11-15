# Memecoinipedia API contract

Version 1, written 2026-11-15 by the lead. This file is the contract between the API in `/api` and the site in `/web`. Both are built against it. To change the API, change this file first, in a pull request the lead reviews.

Nothing here is implemented yet. Section 9 says which plan task builds each part.

## 1. Conventions

**Service.** The API is its own HTTP service, built in `/api`. `/web` reaches it at the address in the `API_BASE_URL` environment variable. Every path below starts with `/api/v1`. All endpoints are `GET` and return JSON (`content-type: application/json; charset=utf-8`). There is no authentication: the data is public.

**Coins are identified by chain and contract address.** `chain` is `solana` for every coin in version 1. `address` is the mint address, written in base58 and case-sensitive. The API never exposes database ids.

**Which coins the API serves.** A coin is *listed* when its ATH market cap, computed from candles by the rules in `docs/metrics.md`, is $100,000 or more. Lists, search results, narrative statistics and comparables contain listed coins only. The database also holds coins below that line (candidates that were measured and fell short); they are never returned, except as the subject of a comparables request (section 6).

**Formats.**

| Kind | Format |
|---|---|
| Time | ISO 8601 in UTC with a `Z`, to the second: `2024-11-03T14:07:00Z` |
| Money | US dollars as a JSON number, not rounded. Market caps can reach 2e10. |
| Duration | Whole seconds as a JSON number |
| Percent | A number from 0 to 100 |
| Narrative | A slug from section 5: `ai`, `tech`, `animal`, `celebrity`, `political`, `news_event`, `culture_meme`, `gaming`, `derivative`, `utility`, `other` |

**Nulls.** Every field in this file is always present in a response. A value that is unknown or not computed yet is `null`. Lists are empty rather than `null`. A coin can be listed before it is classified, so the narrative and summary fields of a listed coin can be `null`.

**Creator-written text is untrusted.** `name`, `ticker`, `description` and the links in `socials` were written by whoever launched the coin. The API returns them as plain text, unchanged apart from trimming. The site must render them as text, never as HTML. Each link in `socials` is a full `https://` URL or `null`; anything else was dropped at ingestion.

**Images.** `image_url` is a URL on our own storage, or `null` when we hold no copy. It is never a third-party or IPFS gateway URL. Until image storage exists (open decision Q6 in `PLAN.md`) it is `null` for every coin, and the site shows a placeholder. When `sensitive` is `true` the site hides the image until the reader asks for it (decision Q4).

**Caching.** Responses carry `cache-control: public, max-age=N`. N is 60 for lists and search, 300 for a coin and for comparables, 3600 for narratives.

## 2. Errors

Every error has the same shape and an HTTP status that matches it:

```json
{ "error": { "code": "invalid_parameter", "message": "ath_min must be a number of 0 or more", "param": "ath_min", "reason": null } }
```

`message` is written for a developer, not for display. `param` names the offending query parameter, else `null`. `reason` narrows a `not_found`, else `null`.

| Status | `code` | When |
|---|---|---|
| 400 | `invalid_parameter` | A parameter is missing, malformed or out of range. Unknown parameters are ignored. |
| 400 | `invalid_cursor` | The cursor is not one this API issued, or it was issued for other parameters |
| 404 | `not_found` | See the reasons below |
| 429 | `rate_limited` | Too many requests from this client. `retry-after` header in seconds. |
| 503 | `not_ready` | The feature needs data that has not been built yet (embeddings, for semantic search and comparables) |
| 503 | `upstream_unavailable` | A data provider did not answer while fetching a coin on demand. `retry-after` header. |
| 500 | `internal` | Anything else |

Reasons for `not_found`:

| `reason` | Meaning |
|---|---|
| `unknown_route` | No such endpoint |
| `unknown_coin` | We hold nothing for this chain and address |
| `not_listed` | We hold the coin, but its ATH is below $100,000, or its metrics are not computed yet |
| `not_pump_fun` | Comparables only: the address is not a pump.fun launch, or has no token metadata |
| `unknown_narrative` | No such narrative slug |

## 3. Coin objects

### 3.1 `CoinSummary`

Used wherever coins appear in a list.

| Field | Type | Source |
|---|---|---|
| `chain` | string | `coins.chain` |
| `address` | string | `coins.address` |
| `ticker` | string or null | `coins.ticker` |
| `name` | string or null | `coins.name` |
| `image_url` | string or null | Built from `coins.image_storage_key`; see Images above |
| `sensitive` | boolean | `coins.sensitive` |
| `launched_at` | time or null | `coins.launched_at`: when the coin was created on pump.fun, not when it graduated |
| `ath_market_cap_usd` | number | `coins.ath_market_cap_usd`. Never null for a listed coin. |
| `ath_at` | time | `coins.ath_at` |
| `seconds_to_ath` | number or null | `coins.seconds_to_ath`: from `launched_at` to `ath_at` |
| `current_market_cap_usd` | number or null | `coins.current_market_cap_usd`, refreshed daily |
| `status` | `alive`, `dead`, `rugged` or `unknown` | `coins.status`. Definitions are decision Q3 in `PLAN.md`. |
| `primary_narrative` | narrative or null | `coins.primary_narrative` |
| `secondary_narratives` | list of narratives, at most three | `coins.secondary_narratives` |

```json
{
  "chain": "solana",
  "address": "ExampLeMint1111111111111111111111111111pump",
  "ticker": "EXDOG",
  "name": "Example Dog",
  "image_url": null,
  "sensitive": false,
  "launched_at": "2024-11-03T14:07:00Z",
  "ath_market_cap_usd": 4210000,
  "ath_at": "2024-11-05T09:31:00Z",
  "seconds_to_ath": 156240,
  "current_market_cap_usd": 18400,
  "status": "dead",
  "primary_narrative": "animal",
  "secondary_narratives": ["culture_meme"]
}
```

All examples in this file are made up.

### 3.2 `Coin`

Everything in `CoinSummary`, plus:

| Field | Type | Source |
|---|---|---|
| `launchpad` | string or null | `coins.launchpad` (`pump.fun`) |
| `creator_wallet` | string or null | `coins.creator_wallet` |
| `quote_token` | string or null | `coins.quote_token`: the mint the coin was paired with at launch (for SOL, the wrapped SOL mint). `null` when not recorded. |
| `graduated_at` | time or null | `coins.graduated_at`: when it left the bonding curve |
| `description` | string or null | `coins.description`, as written at launch |
| `socials` | object | `coins.socials`, always with the three keys `website`, `twitter`, `telegram`, each a URL or null |
| `ath_pool` | `PoolRef` or null | `coins.ath_pool_id`: the pool the ATH was reached on |
| `primary_pool` | `PoolRef` or null | The coin's pool with `pools.is_primary`. The site uses its address for the third-party chart embed. |
| `ath_wick_market_cap_usd` | number or null | `coins.ath_wick_market_cap_usd`: the highest single candle high, before the rules that reject spikes. Always at least `ath_market_cap_usd`. |
| `ath_wick_at` | time or null | `coins.ath_wick_at` |
| `seconds_above_100k`, `seconds_above_1m`, `seconds_above_10m`, `seconds_above_100m` | number or null | The columns of the same names |
| `max_drawdown_pct` | percent or null | `coins.max_drawdown_pct` |
| `rug_pattern` | boolean or null | `coins.rug_pattern` |
| `metric_flags` | list of strings | `coins.metric_flags`; the names are listed in `docs/metrics.md` section 11 |
| `metrics_as_of` | time or null | `coins.metrics_as_of`: the last candle the metrics include |
| `current_price_usd`, `current_liquidity_usd`, `current_volume_24h_usd` | number or null | The columns of the same names |
| `current_refreshed_at` | time or null | `coins.current_refreshed_at` |
| `status_changed_at` | time or null | `coins.status_changed_at` |
| `narrative_confidence` | number from 0 to 1, or null | `coins.narrative_confidence` |
| `narrative_reason` | string or null | `coins.narrative_reason`: the classifier's one-line reason |
| `summary` | string or null | `coins.summary`: two or three sentences written by the classifier |
| `classified_at` | time or null | `coins.classified_at` |
| `parent` | `ParentRef` or null | `coins.parent_coin_id` and `coins.parent_address`: the coin this one is a derivative of |

`PoolRef` is `{ "address": string, "dex": string }`, from `pools.address` and `pools.dex`.

`ParentRef` is `{ "chain": string, "address": string, "ticker": string or null, "name": string or null, "listed": boolean }`. When `listed` is `false` the site shows the address without a link.

## 4. Search and lists

### `GET /api/v1/coins`

| Parameter | Meaning | Default |
|---|---|---|
| `q` | Search text, 1 to 100 characters after trimming. Empty means absent. | none |
| `mode` | `keyword` or `semantic` | `keyword` |
| `narrative` | One or more narrative slugs, separated by commas. A coin matches if any of them matches. | all |
| `narrative_scope` | `primary` matches the primary narrative only; `any` also matches secondary ones | `primary` |
| `status` | One or more of `alive`, `dead`, `rugged`, `unknown`, separated by commas | all |
| `ath_min`, `ath_max` | Bounds on `ath_market_cap_usd` in dollars, both inclusive | none |
| `launched_from`, `launched_to` | Bounds on `launched_at`. A date (`2025-01-01`) or a time. `from` is inclusive, `to` is exclusive. | none |
| `sort` | `relevance`, `ath_desc`, `ath_asc`, `launched_desc`, `launched_asc` | `relevance` with `q`, else `ath_desc` |
| `limit` | 1 to 100 | 25 |
| `cursor` | `page.next_cursor` from the previous response, sent with the same other parameters | none |

**Keyword mode.** If `q` is a whole address (32 to 44 base58 characters) the only possible match is the coin with that address. Otherwise `q` is matched against `ticker` and `name`, ignoring case, and tolerating small misspellings (trigram similarity). `relevance` orders by: exact ticker, then ticker starting with `q`, then similarity of ticker or name, with ties broken by higher ATH. `sort=relevance` without `q` is an `invalid_parameter`.

**Semantic mode.** `q` is required. It is embedded with the same model as the coins, and results are the listed coins nearest to it, nearest first, after the filters are applied. `sort` must be absent or `relevance`. There is one page of at most `limit` results: `page.next_cursor` and `page.total` are `null`. Each item carries one extra field, `similarity` (0 to 1, cosine similarity). Returns `not_ready` until embeddings exist.

**Response.**

```json
{
  "data": [ { "…": "CoinSummary" } ],
  "page": { "limit": 25, "next_cursor": "b2Zmc2V0OjI1", "total": 1840 }
}
```

`total` is the exact number of listed coins that match. `next_cursor` is `null` on the last page. A cursor is opaque and stays valid for at least an hour. No match is not an error: `data` is empty and `total` is 0.

## 5. Narratives

### `GET /api/v1/narratives`

All eleven narratives, in the order of `narratives.sort_order`.

```json
{
  "data": [
    {
      "slug": "animal",
      "label": "animal",
      "coin_count": 18402,
      "secondary_coin_count": 2950,
      "ath_distribution": { "n": 18402, "median": 318000, "p75": 1120000, "p90": 4870000, "max": 2400000000, "population": "ath_100k_plus" }
    }
  ]
}
```

| Field | Source |
|---|---|
| `slug`, `label` | `narratives.slug`, `narratives.label`. The label is the taxonomy's own wording (`AI`, `news event`, `culture/meme`). |
| `coin_count` | Listed coins whose `primary_narrative` is this one |
| `secondary_coin_count` | Listed coins that have it in `secondary_narratives` |
| `ath_distribution` | A `Distribution` (below) over the coins counted in `coin_count` |

### `GET /api/v1/narratives/{slug}`

One object of the same shape, not wrapped in `data`. The coins themselves come from `GET /api/v1/coins?narrative={slug}`.

### `Distribution`

| Field | Meaning |
|---|---|
| `n` | How many coins the figures are computed from. The site shows it beside every distribution. |
| `median`, `p75`, `p90` | Percentiles of `ath_market_cap_usd` over those coins, with linear interpolation (Postgres `percentile_cont`) |
| `max` | The highest `ath_market_cap_usd` among them |
| `population` | Always `ath_100k_plus`: the figures describe coins that reached $100,000, not all coins launched. The site must say so wherever it shows a distribution (decision Q2). |

With `n` of 0 the four figures are `null`.

## 6. Comparables

### `GET /api/v1/coins/{chain}/{address}/comparables`

Given a coin (the *subject*), returns the listed coins most similar to it and the distribution of their ATHs.

| Parameter | Meaning | Default |
|---|---|---|
| `k` | The most neighbours to return, 10 to 200 | 50 |
| `only_earlier` | `true` keeps only neighbours launched before the subject | `false` |

**How neighbours are chosen.** Similarity is the cosine similarity between the subject's embedding and each listed coin's embedding (task B8 defines what is embedded: name, description, narratives and summary). The subject itself is never a neighbour. Neighbours below a fixed floor are dropped; the floor is returned as `min_similarity` and is set in task C3. The nearest `k` of the rest are returned, nearest first.

**The subject need not be listed** (decision Q1). The endpoint accepts any pump.fun address:

- A listed coin: used as it is.
- A coin we hold but do not list: used with what we hold.
- An address we have never seen: its launch metadata is fetched on demand, it is classified and embedded, and the result is kept for 24 hours. This can take up to 15 seconds. It can fail with `upstream_unavailable`, or with `not_found` and reason `not_pump_fun`. This path is rate-limited per client.

**Response.**

```json
{
  "subject": { "…": "CoinSummary fields", "listed": false },
  "status": "ok",
  "min_similarity": 0.55,
  "neighbours": [ { "…": "CoinSummary fields", "similarity": 0.91 } ],
  "ath_distribution": { "n": 50, "median": 264000, "p75": 910000, "p90": 3300000, "max": 61000000, "population": "ath_100k_plus" }
}
```

| Field | Meaning |
|---|---|
| `subject` | A `CoinSummary` plus `listed`. For a subject that is not listed, `ath_market_cap_usd`, `ath_at` and any other field we do not hold are `null`. |
| `status` | `ok`, or `not_enough_comparables` when fewer than 10 neighbours pass the floor |
| `min_similarity` | The floor that was applied |
| `neighbours` | `CoinSummary` objects, each with `similarity` |
| `ath_distribution` | A `Distribution` over `neighbours`. `null` when `status` is `not_enough_comparables`; the neighbours that were found are still returned. |

A distribution over neighbours describes what similar coins that reached $100,000 went on to do. It says nothing about how many similar coins never reached it. The site must show that caveat on the comparables page.

## 7. Coin

### `GET /api/v1/coins/{chain}/{address}`

Returns one `Coin` (section 3.2), not wrapped in `data`.

- An address in the wrong format is an `invalid_parameter` with `param` set to `address`.
- A coin we do not hold is `not_found` with reason `unknown_coin`.
- A coin we hold but do not list is `not_found` with reason `not_listed`. The site can still offer its comparables.

```json
{
  "chain": "solana",
  "address": "ExampLeMint1111111111111111111111111111pump",
  "ticker": "EXDOG",
  "name": "Example Dog",
  "image_url": null,
  "sensitive": false,
  "launched_at": "2024-11-03T14:07:00Z",
  "ath_market_cap_usd": 4210000,
  "ath_at": "2024-11-05T09:31:00Z",
  "seconds_to_ath": 156240,
  "current_market_cap_usd": 18400,
  "status": "dead",
  "primary_narrative": "animal",
  "secondary_narratives": ["culture_meme"],
  "launchpad": "pump.fun",
  "creator_wallet": "ExampLeCreator11111111111111111111111111111",
  "quote_token": "So11111111111111111111111111111111111111112",
  "graduated_at": "2024-11-03T15:02:00Z",
  "description": "the most example dog on solana",
  "socials": { "website": null, "twitter": "https://x.com/exampledog", "telegram": null },
  "ath_pool": { "address": "ExampLePoo1111111111111111111111111111111111", "dex": "raydium" },
  "primary_pool": { "address": "ExampLePoo1111111111111111111111111111111111", "dex": "raydium" },
  "ath_wick_market_cap_usd": 5630000,
  "ath_wick_at": "2024-11-05T09:30:00Z",
  "seconds_above_100k": 1296000,
  "seconds_above_1m": 388800,
  "seconds_above_10m": 0,
  "seconds_above_100m": 0,
  "max_drawdown_pct": 99.6,
  "rug_pattern": false,
  "metric_flags": [],
  "metrics_as_of": "2026-11-14T00:00:00Z",
  "current_price_usd": 0.0000184,
  "current_liquidity_usd": 6100,
  "current_volume_24h_usd": 240,
  "current_refreshed_at": "2026-11-15T06:00:00Z",
  "status_changed_at": "2025-02-11T00:00:00Z",
  "narrative_confidence": 0.93,
  "narrative_reason": "Dog mascot coin with no link to a person or event.",
  "summary": "Example Dog is a dog-themed coin launched on pump.fun in November 2024. It reached a $4.2M market cap two days after launch and has traded near zero since early 2025.",
  "classified_at": "2026-11-14T10:00:00Z",
  "parent": null
}
```

## 8. Health

### `GET /api/v1/health`

`{ "ok": true }` with status 200 when the service can reach the database, else status 503 with the error shape. Not cached.

## 9. What builds what

| Part | Plan task | Needs |
|---|---|---|
| `GET /coins` in keyword mode, `GET /coins/{chain}/{address}`, narratives, health, the error shape | C1 | Coins with metrics (A5); narratives appear as coins are classified (B4) |
| `GET /coins` in semantic mode | C2 | Embeddings (B8) |
| Comparables | C3 | Embeddings (B8) |

## 10. Not in version 1

- Candle or chart data. The coin page embeds a third-party chart for `primary_pool`.
- A list of a coin's derivatives, per-creator pages, and site-wide statistics.
- Hit rates (how many launches of a kind reached $100k). The data for it is being kept; the endpoint is not designed.
- Write endpoints of any kind.
