# Operator's runbook: the backfill and the live process

For someone who has never seen the code. Each section starts with the situation, then the commands,
then how to tell it worked. Where there is no command for something yet, the section says so and
names the function that would do it; nothing here is invented. It describes the code in `main`.

## Before anything

- Run every command from the repository root. Scripts live in `ingest/scripts`; the commands below
  run one with the repository's `.env` (`--env-file=../.env`, as `pnpm -C ingest` runs in `ingest/`).
- `.env` must define `DATABASE_URL`. A real run also needs `CODEX_API_KEY` and `HELIUS_API_KEY`
  (`JUPITER_API_KEY` is optional). No command prints a key.
- There are two long-running processes: the backfill (`backfill.ts run --confirm`) and the live
  process (`live.ts run --confirm`). They share one lock, so **only one runs per database**. The
  second to start refuses and says who holds the lock.
- Without `--confirm` both only print a plan and read the database. They never reach a provider.
- Read-only commands, safe at any time and beside a running process: `live.ts status`,
  `live.ts health`, `backfill-status.ts`.

## Reading what is going on

**You want to know whether the live process is alive and healthy.**

```
pnpm -C ingest exec tsx --env-file=../.env scripts/live.ts health
pnpm -C ingest exec tsx --env-file=../.env scripts/live.ts health --json
pnpm -C ingest exec tsx --env-file=../.env scripts/live.ts status
```

`health` prints one line per check: `ok`, `warn` or `alert`, the figure, and the limit it was held
against. Exit code 0 means no check alerts (a `warn` never changes it), 1 means at least one
alert, 2 means a usage error or a database it could not read. `--json` prints the same as one
object. It reads the database in one read-only transaction, takes no lock and calls no provider.

A database where the live process has never run gives one `warn` line saying so, and exit 0.

Limits are named in `ingest/src/live/health.ts` (`DEFAULT_HEALTH_LIMITS`). Override one for a run
with `--limit NAME=VALUE` (repeat it for several). A monthly Codex.io allowance is given with
`--monthly-codex-units N`; without it the month check is left out.

```
pnpm -C ingest exec tsx --env-file=../.env scripts/live.ts health --limit discoveryAlertSeconds=900 --monthly-codex-units 3000000
```

`status` is the longer picture: the discovery cursor and how far behind it is, the watched coins by
age, today's counts and units, the refresh, the last sweep.

**You want to know how far the backfill is.**

```
pnpm -C ingest exec tsx --env-file=../.env scripts/backfill-status.ts
```

It prints, per stage, the coins done, failed, running, waiting and not run, the queue sizes, the
usage in the last hour and in total, the failures by reason, and an estimate of the time left.

### What each health alert means, and what to do

| Check | Alert when | Do |
|---|---|---|
| `process` | no process holds the pipeline lock | The live process is not running. See "The live process stopped" below. |
| `process` | heartbeat old | The process holds the lock but has stopped writing its usage samples (every 15 seconds): it is stuck, or cannot reach the database. Read its log; if it does not recover, stop it (section on stopping) and start it again. |
| `process` (warn) | a backfill holds the lock | The live process is not running because a backfill is. Normal during a backfill. |
| `discovery` | last pass older than six intervals (30 minutes) | Codex.io is down or limiting, or the process is stuck. A pass that was only paused at the daily unit ceiling is a warn: see `provider:codex:day`. The cursor is kept, so after any gap the next pass reads from the cursor and loses nothing. |
| `watch` | the last watch pass ended more than 10 minutes ago (warn at 5) | The watch loop is not running: the process is stuck or down (see the `process` rows). The loop writes the end of every pass, even one with nothing due, so a quiet watched set does not raise this. With no record at all (a first start on a database) or only an earlier process's, the age is counted from the start of the run, so `no watch pass recorded, run started ... ago` is `ok` for 5 minutes, then `warn`, then `alert` at 10: a watch pass that throws every time never writes its record and shows up this way. A `watch:prices` line is not shown until the run's first pass. A pass can also be old because the loop is waiting out a Jupiter rate limit: a request that meets HTTP 429 waits inside the Jupiter client through up to four pauses of up to 5 minutes each (20 minutes at the longest; 60 seconds each when Jupiter names no time) before the fifth 429 in a row ends it with an error. That is longer than these limits, so a `watch` warn or alert with a live process can mean "waiting", not "stuck": look at the `provider:jupiter:pauses` line of the same report (its count rises with each pause, and the usage is flushed every few seconds) and at `live.ts status` (`paused N times after HTTP 429`). If pauses are being counted, wait; if not, treat it as the stuck loop above. |
| `watch:prices` | no clean pass for six intervals of the fastest watched tier (60 minutes with a coin under 3 days old; 6 hours otherwise; warn at three). A clean pass is one that read its prices to the end: a pass with a failed price request, or one that ended early because Jupiter had asked every request to wait (`paused`), is not clean | The loop runs but no price is being read: Jupiter is not answering or is rate limiting. The log says `watch: price request failed` for a failure; a paused pass logs nothing and shows in the pause count. Nothing to do if Jupiter is down; the coins are read again as soon as it answers. If it is rate limiting, see "A provider is down or limiting". |
| `queue:STAGE:running` | a stage `running` for twice its timeout | A worker died holding it, or nothing is taking over. A running process takes such rows over after the timeout; if it has not, the process is stuck: restart it. |
| `queue:STAGE:waiting` | watched coins waiting for a stage while nothing finishes it for an hour | Candles hold at the daily unit ceiling (check `provider:codex:day`); otherwise a provider is down. The process queues waiting coins again every 10 minutes. |
| `failures:STAGE:REASON` | 20 or more failures of one reason in 24 hours, and a quarter of the stage's finished rows | Look at the reason: `price_error`, `metadata_unreachable` and so on. A provider outage ends by itself; see the provider section, then retry the failed stages. |
| `provider:codex:day` | 95% of the day's unit ceiling (warn at 80%) | The process pauses discovery and candle fetches itself at 100% until the next UTC day. To allow more, restart it with a higher `--max-codex-units-per-day` (see the cost section first). |
| `provider:codex:month` | 95% of the allowance you gave (warn at 80%) | Spend is near the month's plan; decide before the next run. |
| `provider:jupiter:pauses` | 24 or more pauses today (warn at 5) | Jupiter is rate limiting. Every 429 pauses all Jupiter requests of the process (the watch loop, the daily refresh, the metadata stage) for the time Jupiter names, up to 5 minutes, else 60 seconds. A few a day are normal without a key; set `JUPITER_API_KEY` in `.env` and restart the live process for a higher rate (see "A provider is down or limiting"). The check reads the usage row `jupiter_pause` (`requests` is the number of pauses, `units` the seconds paused). The line is printed once any run has recorded a pause on this database, and counts today's; before the first pause ever recorded it is not shown. |
| `refresh:yesterday` | yesterday's daily refresh did not finish | Nothing. Today's refresh covers every listed coin, so what yesterday's missed is read again today. It means the process was down for part of yesterday (see the `process` rows if it is down now). Only the latest day is kept, so this shows only until today's refresh starts. |
| `refresh:today` | today's refresh has not started by 01:00 UTC | It starts at the first tick of the UTC day. The process is down or its ticks are failing. |

What the checks read: the lock itself (`pg_locks`); the newest usage sample of the latest live run
as the heartbeat; `live_state` keys `last_discovery` and `refresh_state`; the watch loop's own record, the
`live_state` key `last_watch` (when the last pass ended, and when the last pass without a failed
price request and without ending paused); `coin_stages` rows for the queue and the failures; the usage tally for the
providers. A `last_watch` left by an earlier process counts from the start of the current run.

If `health` answers that the database schema is behind and names the `migrate` command, migrations
have not all been applied to that database: apply them (section "Migrations, backups, restoring"),
then run it again. It exits 2.

## The live process

**You start the live process for the first time, or after it stopped.**

Look first (nothing is sent without `--confirm`):

```
pnpm -C ingest exec tsx --env-file=../.env scripts/live.ts run
```

It prints the watched coins by age and the requests and units a day it expects. Then start it
(keep it in a terminal multiplexer or under a service manager; it runs until stopped):

```
pnpm -C ingest exec tsx --env-file=../.env scripts/live.ts run --confirm
```

The daily Codex.io ceiling is always in force: 40,000 units a day unless you pass
`--max-codex-units-per-day N`. How to tell it worked: the log says `live run N started`, and after a
minute `live.ts health` shows `ok` for `process`.

**The top-up reads a coin's pool list again when it is old** (issue #87). The daily candle top-up
extends the bars of the pools a coin holds; a coin whose pool list was last read more than 14
days ago (`TOPUP_POOL_LIST_MAX_AGE_DAYS`) also gets one list request, through the same path as
`backfill run --refresh-pools`: new pools are stored under the current rules, their bars are
fetched with the others' up to the clock, and the metrics are recomputed. The request is one more
Codex.io request of about 4 units and counts against the daily ceiling like any other; none is
made while the gate is closed, and the top-up hands out at most a tenth of the ceiling a day to
them (1,000 requests at 40,000 units). The time of the read is `coins.pools_listed_at`. A coin
with no stored time (every coin that existed when migration 0022 was applied) is aged by its
newest stored pool, else by its last finished candles; the first days after this shipped, most
selected coins are therefore due, and the daily share spreads those reads over the days that
follow (a coin left out is due again the next day). The dry run prints the list requests it
expects ("Pool lists" line). A top-up never moves the graduation role: when the list names another
graduation pool than the stored one it records the data issue `graduation_pool_differs` (stored
and listed pool, source) and leaves the role. The rule `late-graduation-pool` selects such a coin
(a stored graduation pool created more than the distance from the graduation, or no graduation
pool on a coin whose candles are done), because the top-up has closed the old
`graduation_pool_late` or `graduation_pool_not_found` issue that would have excluded it. To settle
them, stop the live process (a refresh takes the pipeline lock), look first, then run:

```
pnpm -C ingest exec tsx --env-file=../.env scripts/backfill.ts select --rule late-graduation-pool | wc -l
pnpm -C ingest exec tsx --env-file=../.env scripts/backfill.ts run --refresh-pools --rule late-graduation-pool
pnpm -C ingest exec tsx --env-file=../.env scripts/backfill.ts run --refresh-pools --rule late-graduation-pool --max-codex-units N --confirm
```

(the second prints the estimate, the third spends: one list request a coin, so N is about 5 times the count). The refresh moves or
sets the role and closes `graduation_pool_differs`. The rule also picks coins that were never
read under the current distance, so the count can be higher than the open issues. No command shows
open data issues by kind; count them with
`psql "$DATABASE_URL" -c "select kind, count(*) from data_issues where resolved_at is null and kind = 'graduation_pool_differs' group by kind"`. Only
a coin on the full path (highest daily high of $1,000,000 or more, or a Dune peak far above it)
has the bars of pools other than its graduation pool fetched, as in a refresh: for a coin on the
light path the new pool is stored and its bars wait.

**You want to stop the live process.**

Press Ctrl-C in its terminal, or send it SIGTERM. What is running finishes, then it prints the
status and exits with code 0. A second signal exits at once; rows left `running` are taken over
after their stage's timeout. Starting it again continues from the cursor.

**You want to restart it** (a new ceiling, after a crash): stop it, then start it with the command
above. The discovery cursor, the day's counters and the refresh position are kept in the database,
so a restart neither repeats nor skips work.

**The live process stopped with "The pipeline lock was lost".** Its database connection dropped, so
it took no new work, let the jobs in flight finish and exited with an error. Check that no other
pipeline process is running (next section), then start it again.

**The log says the daily ceiling was reached** (`Discovery and candle fetches are paused until ...`):
that is the ceiling working. The price watch and the stages that cost Codex.io nothing carry on, and
the paused work resumes at the next UTC midnight (the log says so). Nothing to restart.

**The log says `watch: price request failed`**: Jupiter did not answer. The coins are due again on
the next pass, so nothing is lost.

**Jupiter answers HTTP 429.** The client does not fail the coins. It pauses every Jupiter request of
the process until the time Jupiter names (`Retry-After`, at most 5 minutes; 60 seconds when it names
none), then sends the waiting request again. While it is paused, the watch loop and the daily
refresh end their passes early (the refresh carries on from the same place at the next pass) and the
metadata stage takes no coins. Five 429s in a row with no answer between them give up: the refresh
logs `refresh: Jupiter kept answering HTTP 429 ...; the next pass goes on from the same place`, the
watch pass records the failure, and the metadata stage is held for 60 seconds. Each pause is counted
(`live.ts status` and the `provider:jupiter:pauses` line). Nothing to restart.

## The backfill

**You want to see what a backfill run would do.** The default is a dry run: the selection, the
coins per stage and the estimate in units.

```
pnpm -C ingest exec tsx --env-file=../.env scripts/backfill.ts run --stages metrics
```

**You want to run it.** A run that includes the `candles` stage spends Codex.io units and needs a
ceiling. Read the cost section first.

```
pnpm -C ingest exec tsx --env-file=../.env scripts/backfill.ts run --stages metrics --confirm
pnpm -C ingest exec tsx --env-file=../.env scripts/backfill.ts run --stages candles,metrics,metadata --max-codex-units N --confirm
```

The stages can be named in one run or run one after another. The `metadata` stage asks Helius and
Jupiter for the coins at the head of its queue, in batches (1,000 and 100 coins a request), so the
dry run's request counts hold whether it runs alone or behind a faster stage such as `metrics`. A
checkout from before pull request #119 does not do this: there, run `--stages metrics` and
`--stages metadata` as two runs, or the metadata stage asks Jupiter about once per coin.

**You want to stop it.** Ctrl-C or SIGTERM: no new coin is taken, the ones in flight finish, the
summary is printed, the exit code is 0. Run the same command again to continue; nothing is fetched
twice.

### What the backfill's last lines mean

- `Stopped on request: nothing in flight was left running. Run the same command again to continue.`
  You (or a signal) stopped it. Run the same command.
- `Stopped at the Codex.io unit ceiling. Run again with a higher --max-codex-units to continue.`
  The run used the ceiling you gave. Decide whether to spend more, then run again with a higher
  number. Coins already done are skipped.
- `Backfill run finished.` Nothing is waiting in the stages you named. A line below lists coins
  still waiting, if any.
- `Stopped: Jupiter kept answering HTTP 429: 5 pauses in a row, N seconds paused; stopping. Try again later, or set JUPITER_API_KEY for a higher rate. The coins of the batch are left to be retried by the next run: ...`
  The `metadata` stage asks Jupiter for prices, 100 coins a request. A single 429 does not stop
  the run: every Jupiter request waits for the time Jupiter names (up to 5 minutes; 60 seconds when
  it names none) and the request is sent again, silently. Five 429s in a row with no answer between
  them stop the run with this line. The coins of the batch that met it show in `backfill-status.ts`
  under failures with the reason `jupiter_rate_limited`; no attempt was spent on them, so the next
  run takes them with no flag (`--retry-failed` is not needed). What to do: wait (minutes to an
  hour), or set `JUPITER_API_KEY` in `.env` for a higher rate, then run the same command again:

```
pnpm -C ingest exec tsx --env-file=../.env scripts/backfill.ts run --stages metadata --confirm
```

  The run's final status and `backfill-status.ts` print the pauses (`Jupiter paused N times after HTTP 429`).

### The metadata stages: social links and the metadata file

`metadata` (a default stage) reads the coin's on-chain asset from Helius, then its price and links
from Jupiter. `metadata_file` is a stage of its own and not in the default stages: it fetches the
creator's metadata file from the public gateways (no key, no cost) for the social links, the
creator's description and the image.

**Where a coin's social links come from.** Two sources, the file trusted most. The metadata file is
the record of what the creator published at launch: once it was read, the coin keeps the file's links
(also when the file held none) and Jupiter never overwrites them. Until then Jupiter's token answer
fills the links (website, Twitter, Telegram), marked as from Jupiter; they say where the coin is
today, since an owner can edit them after launch. A file read later replaces Jupiter's links. A file
stage that ends done without reading the file (not found, invalid, too large, unsupported address)
changes neither the links nor their source. A link that does not clean up to a proper URL is dropped
and recorded as a data issue (`social_links_dropped`).

**A rerun of the `metadata` stage is free** of Codex.io units and gateway requests, and nearly so for
Helius: over finished coins (after a version bump, say) it makes one Jupiter request per 100 coins
and one Helius request per 1,000 coins (10 credits each).

**Coins in flight.** `metadata_file` runs `--file-concurrency` coins at once, default 3. More makes
the gateways time out and rate-limit each other: with about 37 in flight, over half the first tries
failed in three minutes; with 3 and 1.5 requests a second to each gateway the stage did about 86
coins a minute with no failure. `--metadata-concurrency` (default 40) applies to the `metadata` stage
only and no longer to the file stage. `--gateway-rps` (default 1 request a second to each gateway)
is what paces the file stage. If every gateway attempt for a coin was a rate limit or a timeout (at
least one a rate limit), the setting is too hot, not the coin bad: the first such failure of a coin
in a run costs an attempt, later ones in the same run are given back, and the next run tries again.

```
pnpm -C ingest exec tsx --env-file=../.env scripts/backfill.ts run --stages metadata_file --file-concurrency 3 --confirm
```

## Another process holds the lock

**You start a run and it says "Cannot start a ... run: a `live run` process appears to hold it".**

The message comes from a hint row (who took the lock and when). The truth is the lock itself, which
`live.ts health` reads:

```
pnpm -C ingest exec tsx --env-file=../.env scripts/live.ts health
pnpm -C ingest exec tsx --env-file=../.env scripts/live.ts status
```

- `process: holds the lock` means a process is alive and holds it. Wait for it, or stop it with
  Ctrl-C in its terminal (or SIGTERM to the pid in the message), then start yours.
- `process: no process holds the pipeline lock` means the lock is free; the message came from a
  stale hint (the hint is overwritten by the next process that starts). Start your run again.
- The lock is a Postgres session lock: a process that dies loses its connection and the database
  releases the lock by itself. Only if the lock is still held after the process is certainly gone
  (a half-open connection), find the session and end it, then start your run:

```
psql "$DATABASE_URL" -c "select l.pid, d.datname as database, coalesce(a.client_addr::text, 'local socket') as client, a.state, a.query_start from pg_locks l join pg_database d on d.oid = l.database join pg_stat_activity a on a.pid = l.pid where l.locktype = 'advisory' and d.datname = current_database() and l.classid = 1 and l.objid = 3007493705 and l.objsubid = 1"
psql "$DATABASE_URL" -c "select pg_terminate_backend(PID)"
```

Advisory locks belong to one database, and `pg_locks` lists the whole server, so the query is
limited to the database `DATABASE_URL` names (`d.datname = current_database()`); the output shows
that database and the client address of the session. Check both before you go on: the database must be
the one you mean, and the client must be the machine the pipeline ran on. The two numbers
(`classid = 1`, `objid = 3007493705`) are the pipeline lock key split into its two halves, as
`pg_locks` lists a 64-bit key; a test keeps them equal to `PIPELINE_LOCK_KEY` in
`db/src/pipelineLock.ts`.

Replace `PID` with the pid from the first command. Do this only after you are sure no pipeline
process is running; ending the session of a live one makes it stop with "The pipeline lock was lost".

## Retrying failed stages

**Stages failed and you want them tried again with a fresh set of attempts.**

A stage that used up its attempts stays `failed` on later runs. `--retry-failed` on a backfill run
puts failed stages back to `pending` with zero attempts before the run starts. Its scope: the failed
rows of the stages the run names with `--stages`, for the coins inside the run's selection (the
rough-peak floor, `--limit` and the rest of the selection), not every coin in the database. A failed
row of a coin outside the selection, or of a stage you did not name, stays failed. Name the stages
you mean:

```
pnpm -C ingest exec tsx --env-file=../.env scripts/backfill.ts run --stages metadata_file --retry-failed --confirm
pnpm -C ingest exec tsx --env-file=../.env scripts/backfill.ts run --stages candles,metrics --retry-failed --max-codex-units N --confirm
```

The dry run (the same command without `--confirm`) prints one line, `Failed stages to retry
(--retry-failed): N; they are put back to pending with a full set of attempts.`, and writes
nothing. When failed stages are the only work left, the run counts them as work and goes ahead; it
does not answer "Nothing to do".

How to tell it worked: `backfill-status.ts` shows the failed count for the stage drop and the done
count rise. A backfill run needs the lock, so stop the live process first.

A stage that failed with the reason `jupiter_rate_limited` did not use an attempt and needs no flag:
the next run takes it (see "What the backfill's last lines mean").

The live process retries failed candles and failed metrics of coins it is watching by itself, once
a UTC day (the sweep; `live status` shows `failed candles retried`). It does not retry the other
stages.

The failures table of `backfill-status.ts` groups by reason (the text of the error up to its first
colon), so you can see whether a failure is a provider outage (retry once it is back) or a coin the
provider does not know (retrying will not help).

## Refreshing the pools of chosen coins

**A coin was fetched with a short or wrong list of pools, and you want its pools listed again.**
Typical causes: its graduation pool was named wrongly (a pool created long after the migration, or
a pool of another coin), or the first fetch met a pool clash. The refresh asks Codex.io for each
chosen coin's pool list once, stores the pools it did not hold (side pools only when quoted in SOL,
USDC or USDT; nothing stored is deleted), fetches bars for the added pools only (no bar already
held is asked for again), and puts the metrics of a coin that gained a pool, or whose graduation
pool moved, back to pending so they are recomputed (ATH, status and so on may change). It runs
through the backfill's own stage, queue, unit ceiling, retries and run record.

It spends Codex.io units: about 4 a coin for the list request (the dry run prints the figure), plus
about 4 units a request for the bars of each pool it adds, which cannot be known before the list is
read. Check the month's allowance first (see "The cost traps").

Choose the coins in one of two ways. The option refuses to run without one of them, and refuses both
together.

*From a file.* One coin id or mint address a line; blank lines and lines starting with `#` are
ignored, and anything after the first space or comma on a line is ignored (a CSV with the coin in
its first column works). A line that is neither an id nor an address, or a coin that is not in the
database, stops the run before anything is written.

*By a rule.* `--rule late-graduation-pool` picks coins from the database alone, asking no provider:
a graduation pool created more than 3,600 seconds before or after the coin's graduation time; a
graduation pool with no creation time whose first stored bar starts more than a day after the
graduation, or that holds no bar on a coin whose candles are done; or no graduation pool on a coin
whose candles are done. A coin whose pool list was already read under this rule and still shows no
pool at the migration (it carries an open data issue `graduation_pool_late` or
`graduation_pool_not_found` marked with this distance) is left out, so the rule is not repeated at
one request a coin. To see or edit the list before spending, print it (no provider, no write; the
count goes to stderr):

```
pnpm -C ingest exec tsx --env-file=../.env scripts/backfill.ts select --rule late-graduation-pool > coins.txt
```

Look first (the default is a dry run: the coins, how many have candles done and will be put back to
pending, and the estimate; nothing is sent or written):

```
pnpm -C ingest exec tsx --env-file=../.env scripts/backfill.ts run --refresh-pools --coins coins.txt
pnpm -C ingest exec tsx --env-file=../.env scripts/backfill.ts run --refresh-pools --rule late-graduation-pool
```

Then run it. `--max-codex-units N` is required with `--confirm` (there is no default). The stages
default to `candles,metrics` with this option. Stop the live process first (one pipeline process per
database):

```
pnpm -C ingest exec tsx --env-file=../.env scripts/backfill.ts run --refresh-pools --coins coins.txt --max-codex-units N --confirm
pnpm -C ingest exec tsx --env-file=../.env scripts/backfill.ts run --refresh-pools --rule late-graduation-pool --max-codex-units N --confirm
```

**A refresh that was stopped, or stopped at the ceiling.** Run the same command again. A run
recognises a continuation from the run records: earlier refreshes of exactly the same coin list, back
to the last one that ended `done`. The log says `refresh continued (first started ...)`, and a coin
finished since the first start is not put back again, so no coin's list is asked for twice. A
refresh that ended `done` is over: the same file given later is a new refresh and lists every coin
again. With `--rule` the list is worked out again at each start; coins the first run refreshed usually
drop out of it, so the second run is a new, shorter refresh.

**What the two data issues mean.** They are rows of the `data_issues` table, one open one a coin,
replaced by each run that lists the pools and cleared when a run no longer finds the problem. The
status reports do not print them; read the table.

- `graduation_pool_late`: no pool in the list was created within 3,600 seconds of the migration, so
  the closest one was kept as the graduation pool. The detail has the distance, the limit, the venue
  and the source of the choice. Nothing to do; this coin's list holds nothing better.
- `graduation_pool_not_found`: the coin graduated but no pool in the list serves as its graduation
  pool. Nothing to do either; the row marks the coin as examined, so the rule skips it next time.

If a refresh moves the graduation role to a pool that another coin holds as its own, the stage
fails with the reason `pool_claimed_by_two_coins` and is not retried; the failure names both coins.
That is a data question for the lead, not a rerun.

**How to tell it worked:** the summary at the end says how many candles stages were put back and
finished; `backfill-status.ts` shows no new failures for `candles` and `metrics`; the same rule's
dry run afterwards picks fewer coins.

## Ingesting one coin again

**There is no command for this.** What exists:

- `reopenStages(db, coinId, stages, now)` in `db/src/stages.ts` puts the given stages of one coin
  back to `pending` with zero attempts (only rows that are `done` or `skipped` change), so the next
  run does them again. A reopened `candles` stage does not read the pool list again and does not
  start from scratch: with pools already stored it fetches only the bars after what is held. The
  pool list is read again by a pool refresh (above) and, in the live process, by the top-up of a
  coin whose list is more than 14 days old ("The live process").
- `requeueFailed(db, stages, { addresses, now })` in the same file puts failed rows back for the
  coins whose addresses are given (the live sweep calls it). `--retry-failed` uses
  `requeueFailedInSelection` in `db/src/backfill.ts`, which is scoped to the run's selection.

A command that would do it: `backfill.ts reopen --address MINT [--address MINT]... [--stages LIST]`,
calling `reopenStages` inside the pipeline lock. Not built; this runbook does not pretend it is.

## A provider is down or limiting

**Codex.io (candles, discovery).** Failed stages show in `failures` with a reason code, and the
live `discovery` check ages. The clients retry network errors, 429 and 5xx with backoff, and stages
retry up to three attempts. Nothing to do while it is down. When it is back: let the live process
continue (it catches up from the cursor), and retry failed backfill stages with `--retry-failed`.
If it is limiting you (usage near the ceiling), do not raise the ceiling to push through: see the
cost section.

**Jupiter (prices: the live watch loop, the daily refresh, and the backfill's `metadata` stage).**
In the live process the `watch:prices` check ages and the log says `watch: price request failed`.
The watch loop goes first on the shared limiter and the refresh yields to it. The client keeps to
80% of Jupiter's documented rate (one request every two seconds without a key, one a second with
one), because the documented rate itself drew 429s in practice. A 429 pauses every Jupiter request
of the process (up to 5 minutes, 60 seconds when Jupiter names no time) and the request is sent
again; after five in a row the client gives up. Nothing to do while it limits; set `JUPITER_API_KEY`
in `.env` and restart the live process for a higher rate. In a backfill, the `metadata` stage stops
with the "Jupiter kept answering HTTP 429" line, its coins show as failed with
`jupiter_rate_limited`, and the next run takes them with no flag (see "What the backfill's last
lines mean").

**Helius (token launch information in the metadata stage).** Failures show as stage failures with
the reason code of the metadata stage. Retry them when Helius is back:

```
pnpm -C ingest exec tsx --env-file=../.env scripts/backfill.ts run --stages metadata --retry-failed --confirm
```

**The metadata gateways (the metadata file: social links, the creator's description and image).**
Failures show as `metadata_unreachable` on `metadata_file`. Gateways come and go; to see which
answer now, probe them (this sends requests to public gateways, no key, no cost; without
`--confirm` it only prints what it would ask):

```
pnpm -C ingest exec tsx scripts/gateway-probe.ts --file CIDS.txt
```

Then retry the stage: `backfill.ts run --stages metadata_file --retry-failed --confirm`.

## Migrations, backups, restoring

**You are applying migrations.** They are forward-only SQL files in `db/migrations`, applied in
order, each once. Take a backup first (next), stop both pipeline processes as a precaution, then:

```
pnpm --filter @memecoinipedia/db migrate
```

How to tell it worked: it prints `applied N migration(s)` and running it again prints `up to date`.

**You are about to start a large run, or migrate.** Take a backup. A directory-format dump can be
taken and restored in parallel; it covers the queue tables too (the queue lives in the same
database):

```
pg_dump --format=directory --jobs=4 --file=backup-DATE.dir "$DATABASE_URL"
```

Check the size of the target disk first; for the full database this is several gigabytes.

**You need to restore.** Restore into a new, empty database, check it, then point `DATABASE_URL` at
it. Never restore over a database a pipeline process is using.

```
createdb memecoinipedia_restored
pg_restore --jobs=4 --no-owner --dbname=memecoinipedia_restored backup-DATE.dir
```

A backup predates migrations applied after it; run `migrate` on the restored database afterwards.

## The cost traps

- **Which commands spend provider units.** `backfill.ts run --confirm` (Codex.io units for the
  `candles` stage, including `--refresh-pools`; Helius credits for `metadata`), `live.ts run --confirm` (Codex.io units, always
  under the daily ceiling), `ingest-sample.ts --confirm`, `check-candles.ts --confirm`,
  `dune-discovery.ts --confirm` (Dune credits). Everything else reads the database or sends
  nothing.
- **Dry runs.** Every one of these prints its plan and estimate and sends nothing until `--confirm`.
  Read the estimate first.
- **Ceilings.** A backfill run with `--confirm` and the `candles` stage must be given
  `--max-codex-units N` (there is no default) and stops cleanly when it is used up. The live
  process always has a daily ceiling (40,000 units by default), and pauses discovery and candle
  fetches at it until the next UTC day.
- **The command that fetches candles by accident.** A plain `backfill.ts run --confirm
  --max-codex-units N`, with the default stages (which include `candles`) and the default selection
  (rough peak of $30,000 and up, every candidate not yet done), fetches candles for every candidate
  in that selection that is not done. Both parts of the backfill have run (`PLAN.md`, E3), so on that
  database nothing is waiting there; but a lower `--min-rough-peak`, or candidates added with
  `backfill.ts seed`, make it select unfetched coins again, and every Codex.io unit is overage until
  the plan month renews (about 2026-12-14, per `PLAN.md`). Read the dry run's estimate; whether to
  spend is a decision in `PLAN.md`, not an operator's. For anything else, name the stages
  (`--stages metrics`, `--stages metadata`, `--stages metadata_file`), as in the examples above.
- **The curve-only list (issue #102) spends nothing until it is asked for.** Seeding it
  (`backfill.ts seed --list curve-only`) writes the database and sends nothing. A selection leaves
  its coins out unless `--source dune-curve-only` is given, so a plain `run` does not reach them;
  the dry run says how many it left out. With the option the estimate is its own: 12 units a coin
  (launch record, pool list, daily screen), about 20 if the screen passes; read it before
  `--confirm`, and fetch a limited part first (`--limit N --order hash`, then the rest). Do not run
  `mayhem-graduates.sql` on Dune, or `dune-discovery.ts --list curve-only --confirm`, without the
  lead's go: both spend Dune credits (the second one already ran once, 23.31 credits).
  `scripts/mayhem-load.ts` asks no provider.

## What has no command yet

- Ingesting one coin again from the start: no command (see "Ingesting one coin again");
  `reopenStages` and `requeueFailed` in `db/src/stages.ts` are the functions.
- Delivery of alerts: `live health` prints and sets an exit code; where its alert goes is decided
  with hosting (Q6 in `PLAN.md`).
