# Evaluation sample

`sample-200.csv` lists the 200 coins of the evaluation set for the narrative classifier (task B2, issue #45). Labels for them go in `/research/evals/labels.csv` (Muse, task B3) and research notes in `/research/narratives/` (Grok). This file only says which coins they are.

| Column | Meaning |
|---|---|
| `mint` | The coin's address on Solana |
| `half_year` | Launch half-year, `2024-H1` to `2026-H2` |
| `ath_band` | ATH market cap as measured by the Phase A run: `100k-1M`, `1M-10M` or `10M+` |
| `probe` | `true` for the 20 probe coins |
| `research_issue` | The issue whose research batch covers the coin |

## How it was drawn

From the 421 coins of the Phase A sample (500 coins, run on 2026-11-15) that came out with an ATH of $100,000 or more and have a ticker and a name.

1. The 20 probe coins are in, because their research exists already (issue #7).
2. For each launch half-year and ATH band, coins are taken in ascending order of the SHA-256 of the mint (as lowercase hex of the UTF-8 address) until the cell holds its quota, probe coins counting towards it. Quotas per half-year: 18 at `100k-1M`, 9 at `1M-10M`, and for `10M+` 5, 7, 7, 7, 6, 6 from 2024-H1 to 2026-H2 (2024-H1 has only five such coins).
3. The 180 coins that are not probes are sorted by the same hash and cut into six batches of 30, one research issue each.

## What the spread means for scores

The draw is even across launch periods and leans towards large coins: 54% are under $1M, against about three quarters of all listed coins. Large coins are easier to research and more likely to be known to a model, so an accuracy figure on this set is somewhat kinder than one on the whole encyclopedia would be. Report accuracy for the `100k-1M` band on its own next to the overall figure.

Some of these coins have hateful or sexual names. They are in the set on purpose: the classifier has to handle them and mark them as sensitive. Names and tickers are left out of this file.
