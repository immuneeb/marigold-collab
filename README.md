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
```

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

## Production (after Phase 3)

- App on Vercel, Postgres on Neon (`DATABASE_URL`), blobs on Cloudflare R2,
  render origin as a Cloudflare Worker on the separate `marigoldusercontent.com`
  domain. Render tokens are EdDSA-signed (app holds the private key; the Worker
  only verifies).
