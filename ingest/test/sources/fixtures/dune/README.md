# Dune fixtures

These files were written by hand. None was recorded by a program from the live API: the agent
that wrote them sent no request to Dune. Two kinds:

**Shapes reported from the first live runs (2026-11-15).** The lead ran Dune calls that day and
described what came back. These files copy those shapes with invented or rounded values and no
ids from the live account (the execution id is made up). They are only as good as that
description.

| File | What it follows |
|---|---|
| `usage-billing-periods.json` | Usage response: top-level `private_queries`, `private_dashboards`, `bytes_used`, `bytes_allowed`, `billing_periods[]` (snake case) |
| `execute-tier-400.json` | The 400 body for `performance: "small"` on the Analyst plan |
| `results-csv-402.json` | The 402 body for a CSV download without `limit` on a large result |
| `cancel.json` | `{"success": true}` |
| `status-cancelled.json` | State `QUERY_STATE_CANCELLED` (two Ls) with `execution_cost_credits` set |
| `status-failed.json` | A failed run: cost 0, error with `type` and `message`, no `metadata` |
| `status-completed.json` | A small query: fractional cost, `result_metadata` with `total_row_count`, `total_result_set_bytes`, times, column names and types |
| `discovery-page.csv` | The CSV format of `discovery.sql` (header and number formatting, including exponent form for whole numbers). Three rows copied in shape from a live page; the third row (no hourly prices) is made up |

**Guesses from Dune's documentation (read 2026-11-15).** The documentation has no example for
these states, so the files follow its state list and are guesses at the shape.

| File | Page |
|---|---|
| `execute.json` | https://docs.dune.com/api-reference/executions/endpoint/execute-sql.md |
| `status-pending.json`, `status-executing.json`, `status-partial.json` | https://docs.dune.com/api-reference/executions/endpoint/get-execution-status.md |
| `usage-billingPeriods.json` | https://docs.dune.com/api-reference/usage/endpoint/get-usage.md. The page's example uses `billingPeriods`; the live API uses `billing_periods`. Kept to test that both are accepted |

Not recorded from the live API, any of it.
