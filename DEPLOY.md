# Deploying Marigold (all-Vercel, no custom domains)

Two Vercel projects from this one repo. Because **`vercel.app` is on the Public
Suffix List**, `your-app.vercel.app` and `your-render.vercel.app` are treated by
browsers as different *sites* (cross-site) — the isolation the design needs,
with no domains to register and no Cloudflare.

```
 <app>.vercel.app  ── Next.js app (auth, dashboard, API, MCP, OAuth, viewer)
        │  signs EdDSA render token
        ▼
 <render>.vercel.app ── Next.js render origin (cross-site). Serves untrusted doc
        │               bytes for a token-authorized version, sandboxed + CSP.
        ▼
   Vercel Postgres (Neon) ── users/docs/versions/shares + blob bytes (base64).
```

Two tradeoffs vs. the custom-domain design (both fine for v1, both upgrade
later): all docs share one render origin (still isolated by the sandbox +
capability token, not a per-doc subdomain), and the render function reads blobs
from Postgres (so it isn't fully stateless — scope it to a read-only DB role
when you harden).

## 0. You need only: a Vercel account. Everything else is provisioned in Vercel.

Pick two project names now (their URLs are predictable):
`APP  = https://<app>.vercel.app` · `RENDER = https://<render>.vercel.app`.

## 1. Secrets + keys (local, one-time)

```sh
openssl rand -base64 32                 # AUTH_SECRET
openssl rand -base64 32                 # MCP_TOKEN_SECRET
pnpm --filter @marigold/core keygen     # RENDER_TOKEN_{PRIVATE,PUBLIC}_KEY (+ KID)
```

## 2. Create the two Vercel projects (same repo)

Both import this Git repo; they differ only in **Root Directory**:

| Project | Root Directory | Framework |
|---|---|---|
| app | `apps/web` | Next.js |
| render | `apps/render` | Next.js |

For each, enable **"Include files outside the Root Directory"** (needed so the
pnpm workspace + `@marigold/*` packages install). Install command `pnpm install`,
build `pnpm build`.

## 3. Postgres (through Vercel)

Vercel dashboard → **Storage → Create Database → Postgres (Neon)**. Then
**Connect** that database to **both** projects (it injects `DATABASE_URL` /
`POSTGRES_URL` into each). Apply the schema from your machine using the database
connection string (copy it from the Storage tab):

```sh
DATABASE_URL='postgres://…?sslmode=require' pnpm --filter @marigold/db migrate
```

## 4. Environment variables

**app project** (Settings → Environment Variables, Production):

```
APP_ORIGIN=https://<app>.vercel.app
RENDER_ORIGIN=https://<render>.vercel.app
AUTH_SECRET=…            AUTH_URL=https://<app>.vercel.app     DEV_AUTH=0
GOOGLE_CLIENT_ID=…       GOOGLE_CLIENT_SECRET=…
MCP_TOKEN_SECRET=…
RENDER_TOKEN_KID=k1
RENDER_TOKEN_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----"
RENDER_TOKEN_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\n…\n-----END PUBLIC KEY-----"
RENDER_TOKEN_TTL=60
BLOB_DRIVER=pg
RESEND_API_KEY=…(optional)   EMAIL_FROM=Marigold <you@example.com>
```

**render project** (only needs these):

```
APP_ORIGIN=https://<app>.vercel.app          # CSP frame-ancestors
RENDER_TOKEN_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\n…"   # public key ONLY
BLOB_DRIVER=pg
# DATABASE_URL / POSTGRES_URL are injected by the connected Postgres.
```

(`DATABASE_URL` is injected into both by step 3.)

## 5. Google OAuth

Create an OAuth client (Web). Authorized redirect URI:
`https://<app>.vercel.app/api/auth/callback/google`. Authorized JS origin:
`https://<app>.vercel.app`. Put the id/secret in the **app** project env.

## 6. Deploy + smoke test

Deploy both projects (push to the branch, or "Deploy" in the dashboard).

- Open `https://<app>.vercel.app` → sign in with Google → dashboard.
- `/new` → paste HTML → it renders in a sandboxed iframe on
  `https://<render>.vercel.app/...` (check the frame origin + CSP in devtools).
- Add the remote MCP server (`https://<app>.vercel.app/api/mcp`) to a client,
  authorize once, `create_doc`.
- Share a doc to a second Google account → "Shared with me".

## Later hardening (when you outgrow v1)

- Add custom domains → restore per-doc unguessable subdomains + a fully
  stateless render origin (swap `BLOB_DRIVER=pg` back to object storage).
- Give the render project a **read-only** DB role (it only needs
  `blobs` + `doc_versions`).
- Per-account rate limits + doc/byte quotas before opening signups (the
  quarantine kill switch already ships).
