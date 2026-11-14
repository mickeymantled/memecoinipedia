# AGENTS.md

Memecoinedpedia: a search engine and encyclopedia of past memecoins.
Claude Code is the lead. It assigns work through GitHub issues and
reviews every PR.

Naming: "Codex.io" is a blockchain data API. "OpenAI Codex" is the
coding agent that owns /web. They are different things.

## Lanes
| Directory                       | Owner  | Issue label |
|---------------------------------|--------|-------------|
| /db, /ingest, /api, /pipeline   | Claude | claude      |
| /web, /scripts, /.github        | Codex  | codex       |
| /research/narratives            | Grok   | grok        |
| /research/evals                 | Muse   | muse        |

No agent edits outside its lane. If you need a change in another
lane, open a new issue with that owner's label.

## Workflow
1. Pick up an open issue with your label.
2. Add the label "<agent>:in-progress" and comment "claimed".
3. Branch: <agent>/<issue-number>-<slug>
4. One PR per issue. Keep PRs small.
5. If changes are requested, push to the same branch.
6. If blocked, comment on the issue.

## PR checklist
- Links to the issue
- Meets every acceptance criterion
- Touches only files in your lane
- CI passes
- No secrets committed; new env vars added to .env.example
- Screenshots for UI changes

## Stack
Next.js, TypeScript, Postgres with pgvector, queue-backed worker.

## Narrative taxonomy
AI, tech, animal, celebrity, political, news event, culture/meme,
gaming, derivative, utility, other

## Schemas

/research/narratives/batch-<issue>.json, array of:
{ "mint": "", "ticker": "", "primary_narrative": "",
  "secondary_narratives": [], "origin": "", "origin_date": "",
  "trigger_event": "", "parent_mint": null, "key_accounts": [],
  "sources": [], "confidence": 0.0, "notes": "" }

/research/evals/labels.csv columns:
mint,ticker,primary_narrative,secondary_narratives,parent_mint,
confidence,notes

/research/evals/qa-<issue>.md: free-form review notes.

## API contract
Not defined yet. The lead will document it in /api/README.md.
Do not invent endpoints or fields.
