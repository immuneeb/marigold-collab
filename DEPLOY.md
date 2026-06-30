# Deploying Marigold

Two independently-deployed pieces on two **separate registrable domains** (the
claude.ai / claudeusercontent.com isolation model):

```
 marigold.app                          marigoldusercontent.com
 ┌──────────────────────────┐          ┌─────────────────────────────┐
 │ Next.js app (Vercel)     │          │ Render Worker (Cloudflare)  │
 │ auth · dashboard · API   │  EdDSA   │ d-<rand>.…  serves untrusted │
 │ MCP server · OAuth AS    │  token   │ doc bytes from R2, sandboxed │
 │ viewer (parent frame)    │ ───────▶ │ + strict CSP. PUBLIC key.   │
 └─────────┬────────────────┘          └──────────────┬──────────────┘
      Neon │ Postgres                          R2 read │
           ▼                                           ▼
     (pooled conn)                            bucket: marigold-blobs
                          app writes blobs ──▶ (S3 API)
```

The app holds the EdDSA **private** key and signs render tokens; the Worker holds
only the **public** key. A Worker compromise cannot forge tokens.

## 0. Accounts / resources you provide

- Two domains (any names; the plan uses `marigold.app` + `marigoldusercontent.com`).
- **Cloudflare** account (DNS for both domains, R2, the Worker).
- **Vercel** account (the Next.js app).
- **Neon** account (Postgres).
- A **Google OAuth** client.
- (optional) a **Resend** API key for invite emails.

## 1. Secrets + keys (generate once)

```sh
openssl rand -base64 32                       # AUTH_SECRET
openssl rand -base64 32                       # MCP_TOKEN_SECRET
pnpm --filter @marigold/core keygen           # RENDER_TOKEN_{PRIVATE,PUBLIC}_KEY (+ KID)
```

## 2. Neon (database)

1. Create a project + database named `marigold`.
2. Copy the **pooled** connection string → app `DATABASE_URL`.
3. Apply the schema using the **direct** (non-pooled) string:
   ```sh
   DATABASE_URL='postgres://…(direct)…/marigold?sslmode=require' pnpm --filter @marigold/db migrate
   ```

## 3. Cloudflare R2 (blobs)

1. `wrangler login`
2. `wrangler r2 bucket create marigold-blobs`
3. Create an **R2 S3 API token** → note Access Key ID + Secret. The endpoint is
   `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`. These become the app's
   `R2_*` env vars (`BLOB_DRIVER=r2`).

## 4. Render Worker (Cloudflare)

1. Add `marigoldusercontent.com` as a zone in Cloudflare (update registrar
   nameservers). A wildcard cert for `*.marigoldusercontent.com` is issued
   automatically.
2. In `apps/render/wrangler.toml`, set `APP_ORIGIN` to your app URL and
   uncomment the `routes` block with your render zone.
3. Set the public key as a secret + deploy:
   ```sh
   pnpm --filter @marigold/render exec wrangler secret put RENDER_TOKEN_PUBLIC_KEY
   pnpm --filter @marigold/render deploy
   ```

## 5. Google OAuth

Create an OAuth client (Web). Authorized redirect URI:
`https://marigold.app/api/auth/callback/google`. Authorized JS origin:
`https://marigold.app`. Copy the client id/secret into the app env.

## 6. Vercel (the app)

1. Import the repo. **Root Directory = `apps/web`**, enable "Include files
   outside the Root Directory" (so the pnpm workspace + `@marigold/*` packages
   install). Framework: Next.js. Install: `pnpm install`. Build: `pnpm build`.
2. Add every variable from `.env.production.example` (Production scope). Set
   `DEV_AUTH=0`.
3. Deploy, then add the domain `marigold.app` to the project and point DNS.

## 7. Smoke test

- Sign in with Google → dashboard.
- `/new` → paste HTML → it renders in a sandboxed iframe on
  `d-<rand>.marigoldusercontent.com` (check the frame origin + CSP in devtools).
- Add the remote MCP server to a client, authorize once, `create_doc`.
- Share a doc to a second Google account → it appears in their "Shared with me".

## Env var reference

| Variable | App (Vercel) | Worker (wrangler) |
|---|---|---|
| `APP_ORIGIN`, `RENDER_BASE_HOST`, `RENDER_BASE_SCHEME` | ✓ | `APP_ORIGIN` only |
| `AUTH_SECRET`, `AUTH_URL`, `GOOGLE_CLIENT_*`, `DEV_AUTH=0` | ✓ | — |
| `DATABASE_URL` (Neon pooled) | ✓ | — |
| `MCP_TOKEN_SECRET` | ✓ | — |
| `RENDER_TOKEN_PRIVATE_KEY` + `_PUBLIC_KEY` + `_KID` | ✓ (both) | `_PUBLIC_KEY` only (secret) |
| `BLOB_DRIVER=r2`, `R2_*` | ✓ | — (uses the R2 binding) |
| `RESEND_API_KEY`, `EMAIL_FROM` | ✓ | — |

## Pre-public-deploy TODO (from the reviews)

Per-account rate limits + doc/byte quotas, and alerting on the render-token-deny
counter. The kill switch (quarantine) already ships; these gate opening signups.
