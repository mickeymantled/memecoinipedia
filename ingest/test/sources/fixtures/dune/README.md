# Dune fixtures

Not recorded from the live API. Every file here was written by hand from Dune's API
documentation, read on 2026-11-15. No request was ever sent to Dune to make them. Treat the
field names and shapes as the documentation's claims, not as verified behaviour.

| File | Documentation page |
|---|---|
| `execute.json` | https://docs.dune.com/api-reference/executions/endpoint/execute-sql.md |
| `status-pending.json`, `status-executing.json`, `status-completed.json`, `status-failed.json`, `status-cancelled.json`, `status-partial.json` | https://docs.dune.com/api-reference/executions/endpoint/get-execution-status.md |
| `cancel.json` | https://docs.dune.com/api-reference/executions/endpoint/cancel-execution.md |
| `usage-billing-periods.json`, `usage-billingPeriods.json` | https://docs.dune.com/api-reference/usage/endpoint/get-usage.md (the page shows both spellings) |
| `graduates.csv` | The column list in issue #23, not a Dune page. Mints are from `probes/coins.json`; every other value is invented. |

The status page has no example for the pending, executing, cancelled or partial states. Those
files follow the state list on the same page and are guesses at the shape. The credit figures,
byte sizes and row counts are invented.
