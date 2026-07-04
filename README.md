# Marigold

"Google Docs for AI-generated webpages." Any AI assistant publishes an interactive
HTML doc via MCP, the owner reviews and shares it by email, and people leave inline
comments anchored to elements on the **rendered** page.

The canonical, commentable object is the rendered artifact, not its source. Every doc
is attacker-controlled code, so it runs on an **isolated origin** in a sandboxed
iframe, reachable only through a short-lived capability token.

See `initial_spec_062626.md` for the full spec. This repo implements **Phases 0–3**
(foundations, hosting + versioning, MCP server, identity/sharing/ACL).

## Layout

```
apps/
  web/      Next.js (App Router) — dashboard, control-plane API, MCP server, OAuth AS, viewer
  render/   Cloudflare Worker — isolated render origin (Phase 1)
packages/
  db/       Drizzle schema + migrations (Postgres)
  core/     ingest, versioning, blobs, capability tokens, ACL (Phase 1)
  local/    marigold-local — localhost review loop for agent-authored drafts
```

## Local review loop (no cloud needed)

`marigold-local` runs the same comment shell against a file on disk for fast
agent↔human iteration: the agent writes `draft.html`, you comment in the
browser and hit **Send feedback to agent**, the agent's blocked CLI call
returns your feedback, and its next save live-reloads the tab. See
**[packages/local/README.md](./packages/local/README.md)**.

## Prerequisites

- Node 20+ and pnpm (`brew install pnpm`)
- Postgres 16 for local dev:
  ```sh
  brew install postgresql@16
  brew services start postgresql@16
  createdb marigold
  ```

## Setup

```sh
pnpm install
pnpm db:migrate          # apply schema to the local marigold database
cp .env.example .env     # optional — sane local defaults work without it
```

Local dev needs no credentials: Postgres uses your OS user, and a **dev login**
(hard-gated to non-production) lets you sign in without Google. Add `GOOGLE_CLIENT_ID`
/ `GOOGLE_CLIENT_SECRET` to `.env` when you want real Google sign-in.

## Run

```sh
pnpm --filter @marigold/web dev    # http://localhost:3000
```

Sign in with the dev login (any email), and you land on the dashboard.

## Database commands

```sh
pnpm db:generate   # generate SQL migrations from packages/db/src/schema.ts
pnpm db:migrate    # apply migrations
pnpm db:studio     # Drizzle Studio
```

## Production

See **[DEPLOY.md](./DEPLOY.md)** — an all-Vercel deploy (no custom domains, no
Cloudflare): two Vercel projects (app + render origin) on `*.vercel.app`, which
are cross-site (vercel.app is a public suffix), with Postgres provisioned through
Vercel and blob bytes stored in Postgres (`BLOB_DRIVER=pg`). Render tokens are
EdDSA-signed (app holds the private key; the render origin only verifies).

The blob layer is pluggable (`BLOB_DRIVER=fs|pg|r2`), so a custom-domain +
Cloudflare R2/Worker setup remains available for stronger isolation later.
