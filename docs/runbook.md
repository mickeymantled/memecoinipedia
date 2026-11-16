# Operator's runbook: the backfill and the live process

For someone who has never seen the code. Each section starts with the situation, then the commands,
then how to tell it worked. Where there is no command for something yet, the section says so and
names the function that would do it; nothing here is invented.

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
| `watch` | the last watch pass ended more than 10 minutes ago (warn at 5) | The watch loop is not running: the process is stuck or down (see the `process` rows). The loop writes the end of every pass, even one with nothing due, so a quiet watched set does not raise this. With no record at all (a first start on a database) or only an earlier process's, the age is counted from the start of the run, so `no watch pass recorded, run started ... ago` is `ok` for 5 minutes, then `warn`, then `alert` at 10: a watch pass that throws every time never writes its record and shows up this way. A `watch:prices` line is not shown until the run's first pass. |
| `watch:prices` | no pass without a failed price request for six intervals of the fastest watched tier (60 minutes with a coin under 3 days old; 6 hours otherwise; warn at three) | The loop runs but Jupiter is not answering. The log says `watch: price request failed`. Nothing to do if Jupiter is down; the coins are read again as soon as it answers. If it is a 429, see "A provider is down or limiting". |
| `queue:STAGE:running` | a stage `running` for twice its timeout | A worker died holding it, or nothing is taking over. A running process takes such rows over after the timeout; if it has not, the process is stuck: restart it. |
| `queue:STAGE:waiting` | watched coins waiting for a stage while nothing finishes it for an hour | Candles hold at the daily unit ceiling (check `provider:codex:day`); otherwise a provider is down. The process queues waiting coins again every 10 minutes. |
| `failures:STAGE:REASON` | 20 or more failures of one reason in 24 hours, and a quarter of the stage's finished rows | Look at the reason: `price_error`, `metadata_unreachable` and so on. A provider outage ends by itself; see the provider section, then retry the failed stages. |
| `provider:codex:day` | 95% of the day's unit ceiling (warn at 80%) | The process pauses discovery and candle fetches itself at 100% until the next UTC day. To allow more, restart it with a higher `--max-codex-units-per-day` (see the cost section first). |
| `provider:codex:month` | 95% of the allowance you gave (warn at 80%) | Spend is near the month's plan; decide before the next run. |
| `provider:jupiter:pauses` | many pauses today | Jupiter is rate limiting. The check reads the provider name `jupiter_pause`, which comes with issue #93; until that is merged there is no such row and the line is not printed. |
| `refresh:yesterday` | yesterday's daily refresh did not finish | Nothing. Today's refresh covers every listed coin, so what yesterday's missed is read again today. It means the process was down for part of yesterday (see the `process` rows if it is down now). Only the latest day is kept, so this shows only until today's refresh starts. |
| `refresh:today` | today's refresh has not started by 01:00 UTC | It starts at the first tick of the UTC day. The process is down or its ticks are failing. |

What the checks read: the lock itself (`pg_locks`); the newest usage sample of the latest live run
as the heartbeat; `live_state` keys `last_discovery` and `refresh_state`; the watch loop's own record, the
`live_state` key `last_watch` (when the last pass ended, and when the last pass without a failed
price request ended); `coin_stages` rows for the queue and the failures; the usage tally for the
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
and listed pool, source) and leaves the role; a pool-list refresh of that coin settles it. Only
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
the next pass, so nothing is lost. In this version there is no separate "Jupiter rate limit" stop;
the client slows itself down after a 429. A recorded pause (`jupiter_pause`) arrives with issue #93.

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
- A Jupiter rate limit does not stop the backfill, and it does hit it: the `metadata` stage asks
  Jupiter for prices, 100 coins a request. On this version a 429 fails every coin of that batch
  with the reason `price_error` after the client's quick retries (the coins then show in
  `backfill-status.ts` under failures, and a stage that used its attempts stays `failed`). What to
  do: run the `metadata` stage with `--metadata-concurrency 1`; if 429s persist, stop the run
  (Ctrl-C) and wait; retry the failed coins later with `--retry-failed`:

```
pnpm -C ingest exec tsx --env-file=../.env scripts/backfill.ts run --stages metadata --metadata-concurrency 1 --confirm
pnpm -C ingest exec tsx --env-file=../.env scripts/backfill.ts run --stages metadata --metadata-concurrency 1 --retry-failed --confirm
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
puts failed stages back to `pending` with zero attempts before the run starts. Its scope: every
coin's failed rows of the stages the run names with `--stages`, not only the coins of the current
selection. Name the stages you mean:

```
pnpm -C ingest exec tsx --env-file=../.env scripts/backfill.ts run --stages metadata_file --retry-failed --confirm
pnpm -C ingest exec tsx --env-file=../.env scripts/backfill.ts run --stages candles,metrics --retry-failed --max-codex-units N --confirm
```

How to tell it worked: `backfill-status.ts` shows the failed count for the stage drop and the done
count rise. A backfill run needs the lock, so stop the live process first.

The live process retries failed candles of coins it is watching by itself, once a UTC day (the
sweep; `live status` shows `failed candles retried`). It does not retry the rest.

The failures table of `backfill-status.ts` groups by reason (the text of the error up to its first
colon), so you can see whether a failure is a provider outage (retry once it is back) or a coin the
provider does not know (retrying will not help).

## Refreshing the pools of chosen coins, and ingesting one coin again

**There is no command for either on this version.** What exists:

- `reopenStages(db, coinId, stages, now)` in `db/src/stages.ts` puts the given stages of one coin
  back to `pending` with zero attempts (only rows that are `done` or `skipped` change), so the next
  run does them again. Re-ingesting a coin from the start is `reopenStages` with the stages
  `candles`, `metrics`, `metadata` and `metadata_file`, then a backfill run over those stages.
- `requeueFailed(db, stages, { addresses, now })` in the same file does the same for failed rows of
  the coins whose addresses are given. The backfill's `--retry-failed` calls it without addresses,
  which is why it covers every coin.

A command that would do it: `backfill.ts reopen --address MINT [--address MINT]... [--stages LIST]`,
calling those two functions inside the pipeline lock. Not built; this runbook does not pretend it is.
Whether a reopened candles stage reads a coin's pool list again, rather than only the bars after
what is held, has not been checked here; check `ingest/src/candles/fetch.ts` before relying on it
to refresh pools.

## A provider is down or limiting

**Codex.io (candles, discovery).** Failed stages show in `failures` with a reason code, and the
live `discovery` check ages. The clients retry network errors, 429 and 5xx with backoff, and stages
retry up to three attempts. Nothing to do while it is down. When it is back: let the live process
continue (it catches up from the cursor), and retry failed backfill stages with `--retry-failed`.
If it is limiting you (usage near the ceiling), do not raise the ceiling to push through: see the
cost section.

**Jupiter (prices: the live watch loop, the daily refresh, and the backfill's `metadata` stage).**
In the live process the `watch:prices` check ages and the log says `watch: price request failed`.
The watch loop goes first on the shared limiter and the refresh yields to it. Without a key
Jupiter allows about one request every two seconds. Nothing to do while it limits; set
`JUPITER_API_KEY` in `.env` and restart the live process for a higher rate. In a backfill, a 429 on
the `metadata` stage fails the coins of the batch with `price_error` after quick retries (on this
version there is no pause and resume): run that stage with `--metadata-concurrency 1`, stop the
run if 429s persist, and retry later with `--retry-failed` (the two commands are in "What the
backfill's last lines mean").

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
  `candles` stage; Helius credits for `metadata`), `live.ts run --confirm` (Codex.io units, always
  under the daily ceiling), `ingest-sample.ts --confirm`, `check-candles.ts --confirm`,
  `dune-discovery.ts --confirm` (Dune credits). Everything else reads the database or sends
  nothing.
- **Dry runs.** Every one of these prints its plan and estimate and sends nothing until `--confirm`.
  Read the estimate first.
- **Ceilings.** A backfill run with `--confirm` and the `candles` stage must be given
  `--max-codex-units N` (there is no default) and stops cleanly when it is used up. The live
  process always has a daily ceiling (40,000 units by default), and pauses discovery and candle
  fetches at it until the next UTC day.
- **The command that starts part 2 of the backfill by accident.** A plain `backfill.ts run
  --confirm --max-codex-units N`, with the default stages (which include `candles`) and the default
  selection (rough peak of $30,000 and up, every candidate not yet done), fetches candles for every
  candidate that part 1 did not reach: part 2, the smallest candidates, last estimated at about 1.36
  million Codex.io units. Whether and when to run it is a decision in `PLAN.md`, not an operator's.
  For anything else, name the stages (`--stages metrics`, `--stages metadata`,
  `--stages metadata_file`), as in the examples above.

## What has no command yet

- Re-ingesting one coin from the start, and refreshing the pools of chosen coins: no command (see
  above); `reopenStages` and `requeueFailed` in `db/src/stages.ts` are the functions.
- A recorded Jupiter pause (`jupiter_pause`): comes with issue #93.
- Delivery of alerts: `live health` prints and sets an exit code; where its alert goes is decided
  with hosting (Q6 in `PLAN.md`).
