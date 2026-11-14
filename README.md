# Memecoinipedia

A search engine and encyclopedia of past memecoins: find comparable coins and see how high they went.

## Where things are

- `PLAN.md`: the plan and task status
- `AGENTS.md`: who owns which folder and the workflow
- `docs/`: data-source research and the metric rules
- `/db`: migrations, typed query access, seed data, the taxonomy values
- `/ingest`: data-provider clients, the price metric library, the queue worker and per-coin pipeline
- `/pipeline`: the Anthropic batch classification pipeline, parent-coin candidates, embeddings, the eval harness, and loaders for the research files
- `/api`: the search and comparables API, and its contract in `/api/README.md`
- `/web`: the Next.js site
- `/research`: narrative research and eval labels

## Setup

```sh
pnpm install
cp .env.example .env
pnpm db:up
pnpm typecheck
pnpm lint
pnpm test
```

The database runs in Docker on port 5433. Tests read `TEST_DATABASE_ADMIN_URL` and create their own temporary databases.
