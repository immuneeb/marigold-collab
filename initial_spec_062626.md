# Marigold — Build Specification

> **Codename:** Marigold
> **One line:** A service where any AI assistant can publish an interactive HTML doc via MCP, the owner reviews it and shares it by email with specific people, and everyone leaves inline comments anchored to elements on the *rendered* page — "Google Docs for AI-generated webpages."

---

## 0. How to use this document (read first, build agent)

This is a phased spec. **The phases in §13 are ordered and each one is independently shippable.** Build them in sequence; do not start a later phase until the prior phase's acceptance criteria pass. If a later phase seems to require a decision not made here, check §14 (Open decisions) and ask the human rather than guessing.

The single most important architectural idea, which everything else serves: **the canonical, commentable object is the rendered artifact, not its source.** Comments anchor to elements in the live DOM the viewer sees. Keep this invariant in mind whenever a design choice is ambiguous.

The two genuinely hard parts are (a) safely executing untrusted AI-generated HTML/JS, and (b) anchoring comments durably to an arbitrary page that the AI regenerates. Most of the rest is assembling known pieces. Spend care accordingly.

---

## 1. Product overview

### 1.1 The problem
People explore ideas with an AI assistant (Claude, ChatGPT, Gemini) and frequently want more visual clarity than a chat transcript gives, or want to share the idea visually with someone. Assistants can already generate rich, interactive HTML, but there is nowhere to **host it privately, share it with specific people, and collect inline feedback** without building all of that plumbing yourself.

Existing tools each solve only part of this and anchor comments to the *source* object their business cares about (Figma → the design file, Vercel → the deployment, Gamma → its block doc). None treats the rendered, externally-shared, interactive page as the thing you comment on. That gap is the product.

### 1.2 What Marigold is
1. An **MCP server** (the universal write path) that any MCP-capable assistant can call, authorized once to the user's account, to create and update docs.
2. A **host** that renders arbitrary AI-generated HTML safely and serves it at a stable, access-controlled URL.
3. A **share-by-email identity layer** so docs can be shared with specific people, including people who don't have an account yet.
4. A **commenting layer** that pins threaded comments to specific elements on the rendered page and keeps them anchored as the AI revises the doc.
5. A **feedback loop**: the assistant can read the comments back through MCP, revise the doc, and the comments re-anchor onto the new version.

### 1.3 Non-goals (explicit)
- Not a document/HTML editor. Humans do not edit doc source inside Marigold; the assistant produces it. (Humans comment; the assistant revises.)
- Not a website builder or CMS.
- Not a general application host. Docs are front-end artifacts that may call **allowlisted** external APIs; they are not full backend apps.
- Not (in v1) a real-time multiplayer editor.
- Not an analytics product.

---

## 2. Users and core capabilities

### 2.1 Actors
- **Owner** — the person whose account the MCP is authorized to. Creates docs (via their assistant), reviews, comments, shares, manages access.
- **Invited collaborator** — someone the owner shared a doc with by email. May be a brand-new user.
- **AI assistant** — a non-human actor that writes and updates docs and reads comments, acting on the owner's behalf through the MCP server.

### 2.2 Capabilities (functional requirements)

**As an owner, I can:**
- Connect Marigold to my AI assistant once via MCP (OAuth), so the assistant can publish on my behalf without re-auth each time.
- Have my assistant spin up a doc from HTML it generated; I immediately get a private URL.
- Have my assistant update an existing doc; the URL stays the same and prior comments persist.
- See all my docs in a dashboard, open and interact with any of them.
- Leave inline comments pinned to specific elements of a doc, and reply to / resolve threads.
- Share a doc with one or more email addresses at a chosen role (viewer / commenter / editor), **even if the recipient has no Marigold account yet**.
- See who has access, change a person's role, and revoke access.
- See incoming comments, and ask my assistant to revise the doc in response.

**As an invited collaborator, I can:**
- Receive an invite email and open the shared doc.
- Sign in with Google OAuth; afterward I automatically see every doc shared with my verified email in a "Shared with me" list.
- View and interact with a doc I have access to, and (if my role allows) leave inline comments and reply to threads.
- Never see docs I wasn't granted; never need an account *before* being invited.

**As an AI assistant (via MCP), I can:**
- `create_doc` from generated HTML and return the URL.
- `update_doc` to replace a doc's content in place (same URL, comments preserved).
- `list_docs` / `get_doc` to find and read existing docs.
- `share_doc` to grant a person access by email.
- `get_comments` to read the human feedback (with the element/context each comment is anchored to), then revise and `update_doc`.

---

## 3. System architecture

Three planes. See the component flows below.

```
AUTHORING PLANE
  Any AI assistant ──(MCP, OAuth to owner account)──▶ MCP server

CORE (STATEFUL)
  MCP server ──▶ Control plane API ──▶ Postgres (users, docs, versions, shares, comments)
                          └────────▶ Object storage (content-addressed HTML/asset blobs)
                          └────────▶ Identity (Google OAuth, email-keyed invites)

DELIVERY
  Viewer (Marigold origin) ──embeds──▶ Isolated render origin (sandboxed iframe + CSP)
  Viewer ──▶ Control plane (comments, render-token requests)

FEEDBACK LOOP
  Comments ──(get_comments via MCP)──▶ assistant ──(update_doc)──▶ re-anchored doc
```

### 3.1 Key flows

**Publish / update flow:**
1. Assistant calls `create_doc`/`update_doc` on the MCP server (OAuth token identifies the owner).
2. Server parses the HTML, runs **deterministic ingest** (injects stable element IDs — see §8.2), splits into files.
3. Each file is stored as a content-addressed blob; a **manifest** (path → hash) is assembled; an immutable **version** record is written and the doc's `latest` ref is moved (see §5).
4. Server returns `{docId, slug, url, versionId, ordinal}`.

**View + comment flow:**
1. A signed-in viewer opens `marigold.app/d/:slug`.
2. The Marigold web app (the "viewer") checks the ACL server-side, then requests a **capability token** scoped to `{doc, version, viewer}` from the control plane.
3. The viewer embeds the doc in a sandboxed `<iframe>` pointing at the **isolated render origin**, passing the token. The render origin validates the token and streams the blob with strict CSP headers.
4. Marigold injects a small trusted **anchor agent** into the doc at ingest time; the agent reports element geometry and click coordinates to the parent via `postMessage`.
5. The **comment overlay lives in the parent frame** (never inside the untrusted iframe). It paints pins and the sidebar; comment bodies are written to the control plane against the anchored version.

**Feedback loop:**
1. Assistant calls `get_comments(docId)`; receives each comment plus the text/element context it's anchored to.
2. Assistant revises and calls `update_doc`.
3. On the new version, every comment's anchor is re-resolved (see §8.4); resolvable ones move forward, unresolvable ones are flagged orphaned.

---

## 4. Data model

Postgres. Types are Postgres types. IDs are prefixed ULIDs/strings unless noted.

```sql
-- People
users (
  id            text primary key,            -- "usr_..."
  google_sub    text unique not null,        -- Google subject id
  primary_email text not null,
  display_name  text,
  created_at    timestamptz not null default now()
);

-- A user may control several verified emails; shares bind to verified emails.
user_emails (
  user_id   text references users(id) on delete cascade,
  email     text not null,                   -- normalized (lowercased, alias-folded)
  verified  boolean not null default false,
  primary key (user_id, email)
);
create unique index on user_emails(email) where verified;

-- Docs: stable identity + movable pointers into the version chain
docs (
  id                   text primary key,     -- "doc_..."
  slug                 text unique not null, -- url segment
  owner_id             text references users(id),
  latest_version_id    text,                 -- what the assistant last wrote
  published_version_id text,                 -- what shared viewers see (nullable until published)
  title                text,
  created_at           timestamptz not null default now()
);

-- Immutable version records forming an append-only chain (git-like)
doc_versions (
  id                   text primary key,     -- = hash of the manifest (content identity)
  doc_id               text references docs(id) on delete cascade,
  ordinal              integer not null,     -- human-facing "v3", monotonic per doc
  parent_version_id    text,                 -- previous version
  manifest             jsonb not null,       -- { "index.html": "sha256:..", "chart.js": "sha256:.." }
  created_by_assistant text,                 -- e.g. "claude-cowork", "chatgpt"
  byte_size            bigint not null,
  title                text,
  created_at           timestamptz not null default now(),
  unique (doc_id, ordinal)
);

-- Content-addressed blobs (dedup across all docs/users)
blobs (
  sha256      text primary key,
  byte_size   bigint not null,
  storage_key text not null,                 -- key in object storage
  created_at  timestamptz not null default now()
);

-- Access grants keyed by EMAIL, not user id
shares (
  id            text primary key,            -- "shr_..."
  doc_id        text references docs(id) on delete cascade,
  email         text not null,               -- normalized; may not yet map to a user
  role          text not null check (role in ('viewer','commenter','editor')),
  state         text not null check (state in ('pending','active')),
  invited_by    text references users(id),
  bound_user_id text references users(id),   -- set on first OAuth bind
  created_at    timestamptz not null default now(),
  unique (doc_id, email)
);
create index on shares(email);

-- Comments + threads, anchored to a specific version
comments (
  id                  text primary key,       -- "cmt_..."
  doc_id              text references docs(id) on delete cascade,
  anchored_version_id text references doc_versions(id),
  parent_id           text references comments(id), -- null = thread root
  author_id           text references users(id),
  body                text not null,
  anchor              jsonb not null,         -- composite selector, see §8.1
  status              text not null check (status in ('open','resolved','orphaned')) default 'open',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index on comments(doc_id, status);

-- Per-doc network allowlist approvals (Phase 7; model early)
network_grants (
  doc_id     text references docs(id) on delete cascade,
  origin     text not null,                  -- e.g. "https://api.example.com"
  approved_by text references users(id),
  created_at timestamptz not null default now(),
  primary key (doc_id, origin)
);
```

---

## 5. Storage and versioning

**Principle:** object storage holds immutable, content-addressed bytes; Postgres holds the mutable pointers. This is git's model.

- **Blob** — every file (HTML, JS bundle, image) stored under `blobs/sha256/<hash>`. Identical bytes → same key → stored once, globally deduped.
- **Manifest** — a version is not one blob but a tree `{ path → content_hash }`, so multi-file docs work and the render origin can serve `/index.html` and `/chart.js` independently. Even when v1 inlines everything into one file, model the manifest from day one.
- **Version** — immutable record (`doc_versions`). `id` = hash of the manifest (content identity, integrity, dedup). `ordinal` = per-doc human number ("v3"). `parent_version_id` = the chain. Never mutated.
- **Refs** — the doc carries two movable pointers into the chain: `latest` (assistant's most recent `update_doc`) and `published` (what shared viewers see). This decouples iteration from sharing — the assistant can push five iterations into `latest` while collaborators keep seeing `published`; moving `published` is the "publish/share" action.

**Addressing:**
```
https://marigold.app/d/:slug              -> resolves ref:published (mutable, shareable link)
https://marigold.app/d/:slug@v3           -> a specific ordinal (frozen permalink; what a comment pins)
https://marigold.app/d/:slug@<hash>       -> exact bytes by content hash
https://<slug>-<rand>.usercontent.marigold.app/<versionId>/<path>  -> render origin (sandboxed serving)
```
The capability token (see §7) is scoped to `{doc, version}`, so the version in the render-origin path is exactly the one the viewer was authorized for.

**Why content-addressing pays off:** one-line edits store only the delta; assets dedup globally; if `update_doc` produces a manifest whose hash equals the current version's, **no-op** (no new version, no notification) — this kills spurious "the assistant regenerated and bumped everything" noise; immutability is what makes comment anchoring safe (a comment pins `ver_X`, whose bytes can never drift); "restore v3" is just pointing `published` back at it.

**Two requirements that bite if skipped:**
1. **Ingest must be deterministic.** The element-ID injection (§8.2) must produce identical output for identical input, or you defeat your own dedup (every re-run hashes differently).
2. **GC must be reference-aware.** Mark-and-sweep unreferenced blobs, but a version **a live comment pins is referenced and must never be collected**, even if ancient. Retention = "keep everything a comment touches, plus the last N, plus anything inside a time window," not "trim to last N."

---

## 6. The MCP server

The universal write path. OAuth 2.1 — the owner authorizes Marigold once; the assistant holds a token scoped to that account. Generalizable to any MCP-capable assistant (Claude, Claude Code, and increasingly others). For assistants that don't speak MCP, the same control-plane API backs a paste/upload page and (Phase 7) a browser extension.

**Tools:**

| Tool | Input | Returns | Notes |
|---|---|---|---|
| `create_doc` | `title`, `files: {path, content}[]` *(or* `html` *shorthand → `index.html`)* | `{docId, slug, url, versionId, ordinal}` | Runs ingest, stores blobs, writes v1. |
| `update_doc` | `docId`, `files[]` *or* `html` | `{versionId, ordinal, unchanged}` | **Replace in place; same URL.** No-op (`unchanged:true`) if manifest hash matches current. Moves `latest`. |
| `get_doc` | `docId` | `{metadata, url, currentHtml?}` | |
| `list_docs` | `cursor?` | `{docs[], nextCursor?}` | Owner's docs. |
| `share_doc` | `docId`, `email`, `role` | `{shareId, state}` | Writes a (possibly pending) grant + sends invite. |
| `get_comments` | `docId`, `status?` | `{comments[]}` — each with `body`, `author`, `status`, and the **anchored element/text context** | Powers the feedback loop. |
| `resolve_comment` *(optional)* | `commentId` | `{ok}` | Lets the assistant close threads it addressed. |

**Behaviors:**
- `update_doc` must preserve the doc's comment set; re-anchoring happens automatically on the new version (§8.4).
- All tools enforce that the OAuth subject owns (or has editor rights to) the target doc.

---

## 7. Rendering and security  ⚠️ highest-risk surface

Every doc is attacker-controlled code. The boundary is **origin isolation**, the same approach claude.ai uses with `claudeusercontent.com`.

**Controls:**
1. **Separate, unguessable origin per doc** — `https://<slug>-<rand>.usercontent.marigold.app`. The doc can never touch Marigold's auth cookies or same-origin data, because it isn't same-origin with the app.
2. **`<iframe sandbox>`** — `allow-scripts` (docs are interactive) but **not** `allow-same-origin` relative to the parent app. The doc runs, but isolated.
3. **Strict CSP on the doc origin** — `default-src 'self'`, `connect-src 'none'` by default. Scripts/styles inlined or served from the doc's own blobs.
4. **Interactivity vs. safety tension** — some docs legitimately need to fetch live data. Resolve with a **per-doc network allowlist** (`network_grants`) plus a viewer-facing approval prompt ("this doc wants to call `api.x.com` — allow?"), mirroring MCP tool-call approval. Default is fully sandboxed (no network).
5. **Capability tokens** — the render origin serves nothing without a short-lived signed token scoped to `{doc, version, viewer, exp}`, issued by the control plane only after a server-side ACL check. You cannot share cookies across the isolated origins (by design), so this token is how cross-origin authorization happens. Pass it via a POST→redirect that sets a token cookie scoped to the doc origin, or a one-time query param.
6. **Comment layer & all auth live in the parent (Marigold) origin only.** The untrusted iframe never sees the Marigold session or comment bodies.
7. **Sanitize app-shell-rendered metadata** — doc titles etc. shown in the parent UI must be escaped (stored-XSS into the shell).
8. **Anti-phishing** — docs are served only from the `usercontent` subdomain, never the apex app origin; pages are `noindex`; consider a subtle "user-generated content" badge/interstitial.

**Threat → mitigation summary:**

| Threat | Mitigation |
|---|---|
| Untrusted JS execution | Separate unguessable origin + iframe sandbox + CSP |
| Session/token theft | Auth & comments in parent origin only; doc origin can't reach them |
| Data exfiltration | `connect-src 'none'` default; per-doc allowlist + viewer approval |
| Unauthorized access | Server-side ACL on every fetch + render-token; bind grants to verified emails |
| Phishing on our domain | usercontent subdomain, noindex, no apex serving |
| Stored XSS into shell | Escape all doc-derived metadata in parent UI |

---

## 8. Commenting and anchoring  ⚠️ the moat

A comment does not store `x,y`. It stores a **composite anchor** resolved in priority order, in the spirit of the W3C Web Annotation Data Model.

### 8.1 Anchor shape
```json
{
  "marigoldId": "mg-3f2a",
  "css": "main > section:nth-of-type(2) .readout",
  "xpath": "/html/body/main/section[2]/div[2]",
  "textQuote": { "prefix": "Net holder ", "exact": "yield", "suffix": " = (fees" },
  "rect": { "x": 412, "y": 980, "w": 220, "h": 64, "scrollW": 1280, "scrollH": 3400 }
}
```

### 8.2 Ingest-time instrumentation
On `create_doc`/`update_doc`, parse the HTML and inject a **stable, deterministic** `data-marigold-id` on elements (deterministic so identical input → identical output → dedup holds). This is the primary, most robust anchor.

### 8.3 The anchor agent (cross-origin)
Because the doc is sandboxed and cross-origin, the parent can't reach into its DOM. Marigold injects a small **trusted** anchor agent (added at ingest, not by the doc author) that runs inside the iframe and, over `postMessage`, (a) reports element geometry, (b) reports click target + computed selectors when the viewer places a comment, (c) resolves a stored anchor to a current position on render. It only does anchor resolution and geometry — **comment bodies never enter the untrusted frame.** The parent paints pins/sidebar in its own layer over the iframe and keeps them positioned on scroll/resize.

### 8.4 Resolution and re-anchoring
- **On render:** resolve each comment's anchor in priority order — `marigoldId` → `css` → `xpath` → `textQuote` → `rect`. First hit wins; reposition the pin.
- **On new version (`update_doc`):** re-resolve every comment against the new version. Resolvable → carry forward (optionally refreshing selectors). Unresolvable → mark `orphaned`, retaining `anchored_version_id` so the UI can show "commented on v3, current is v5" and a link to that frozen version. Comments are never silently lost.

### 8.5 Threads
Root comment + replies (`parent_id`). Resolve/reopen. (Realtime sync of threads is Phase 7; until then, fetch-on-open + poll.)

---

## 9. Identity, sharing, and access control

The trick that makes it feel like Google Docs: **grants are keyed by email, not user id.**

- `share_doc(doc, email, role)` writes a `shares` row (`state='pending'` if no user yet) and sends an invite email with a link.
- The recipient opens the link → **Google OAuth** → Marigold binds their grants to the **verified** email from the OAuth ID token (trust `email_verified`; normalize Google dotted aliases and `+` tags). All pending shares for that address flip to `active` and bind to the user.
- **"Shared with me"** = a query on the signed-in user's verified emails against `shares`.
- **Roles:** `viewer` (read/interact), `commenter` (+ comment/reply), `editor` (+ may trigger updates / manage — scope minimally in v1).
- **Enforcement:** server-side ACL check on every doc fetch and on every render-token issuance. Bind to verified emails only (prevents claiming an address you don't own).

---

## 10. Control-plane REST API (web app)

Mirrors the MCP tools where relevant (so the paste/upload fallback and the web UI share logic).

```
POST   /api/docs                     create (paste/upload fallback)
PATCH  /api/docs/:id                 update in place
GET    /api/docs/:id                 metadata + resolve url
GET    /api/docs                     owned + shared-with-me
POST   /api/docs/:id/render-token    -> capability token (called before embedding the iframe)
POST   /api/docs/:id/publish         move `published` ref to a version

POST   /api/docs/:id/shares          grant access by email (+ send invite)
PATCH  /api/shares/:id               change role
DELETE /api/shares/:id               revoke

GET    /api/docs/:id/comments        list (filter by status)
POST   /api/docs/:id/comments        create (with anchor)
POST   /api/comments/:id/replies     reply
PATCH  /api/comments/:id             resolve / reopen / edit

POST   /api/docs/:id/network-grants  approve a doc's outbound origin (Phase 7)
GET    /api/invites/accept           post-OAuth binding entrypoint
/api/auth/*                          Google OAuth (Auth.js)
```

Render origin (separate service):
```
GET https://<slug>-<rand>.usercontent.marigold.app/<versionId>/<path>
    -> validate capability token, stream blob, set strict CSP + sandbox headers
```

---

## 11. Recommended tech stack

Opinionated defaults; substitute equivalents if you have reason to.

- **Web app + control-plane API:** Next.js (App Router), deployed on Vercel.
- **Database:** Postgres (Neon or Supabase). ORM: Drizzle or Prisma.
- **Object storage:** Cloudflare R2 (S3-compatible, no egress fees — good for serving blobs).
- **Auth:** Google OAuth via Auth.js (NextAuth). Use the verified email from the ID token.
- **Isolated render origin:** Cloudflare Worker on a wildcard subdomain `*.usercontent.marigold.app` — validates the capability token, streams the blob from R2, sets CSP/sandbox headers. (A Worker is a clean fit here; a small dedicated Node service is the alternative.)
- **MCP server:** TypeScript MCP SDK (`@modelcontextprotocol/sdk`), OAuth 2.1. Can run as a Next.js route handler or a separate service.
- **Anchor agent:** vanilla TypeScript, bundled small, injected at ingest; `postMessage` protocol with the parent.
- **Realtime (Phase 7):** a hosted pub/sub (Supabase Realtime, Ably, or Pusher) for live comments + presence.

---

## 12. Out of scope for v1
Real-time multiplayer editing; a version-diff/timeline UI; custom domains; analytics; org/team/SSO management; a non-MCP browser-extension capture path (Phase 7); arbitrary backend execution inside docs.

---

## 13. Sequencing (build phases)

Each phase is shippable and ordered. **Do not begin a phase until the previous phase's acceptance criteria pass.**

### Phase 0 — Foundations
**Build:** repo + Next.js app; Postgres schema from §4; R2 bucket; Google OAuth login (Auth.js); empty dashboard shell.
**Acceptance:** a user can sign in with Google and land on an empty dashboard; schema migrations apply cleanly.

### Phase 1 — Hosting + versioning (no comments, no sharing)
**Build:** content-addressed blob storage; manifest + immutable version chain + `latest`/`published` refs (§5); `create`/`update` via REST behind a simple **paste-HTML** page; the **isolated render origin** (Worker) serving a sandboxed iframe with strict CSP; **capability tokens**; a viewer page that embeds the doc.
**Acceptance:** paste HTML → get a private URL → it renders sandboxed → "update" replaces in place at the **same** URL → versions are recorded → an identical re-submit is a no-op.

### Phase 2 — MCP server
**Build:** wrap Phase 1 ingestion in an OAuth'd MCP server exposing `create_doc`, `update_doc`, `list_docs`, `get_doc`.
**Acceptance:** from Claude / Claude Code, authorize Marigold once, then create and update a doc entirely via MCP; the returned URL renders.

### Phase 3 — Identity, sharing, access control
**Build:** email-keyed `shares`; invite emails; post-OAuth **verified-email binding**; "Shared with me"; roles (viewer/commenter/editor); ACL enforcement on every fetch + render-token; `share_doc` MCP tool.
**Acceptance:** share a doc to a stranger's email → they receive an invite → sign in with Google → see it in "Shared with me" → role is enforced (e.g., a viewer cannot comment) → revocation works.

### Phase 4 — Commenting + anchoring  *(the hard part)*
**Build:** deterministic ingest-time `data-marigold-id` injection; the trusted **anchor agent** in the iframe; the `postMessage` protocol; the **parent-frame overlay** (pins + sidebar); composite-selector capture (§8.1); persistence; threads + resolve.
**Acceptance:** pin a comment to a specific element; reload — it's still anchored to the right element; an invited commenter can comment; threads + resolve work.

### Phase 5 — Re-anchoring across versions + orphans
**Build:** on `update_doc`, re-resolve every anchor against the new version (§8.4); orphan flagging with "commented on vN" UI and frozen-version links; comment permalinks pinned to `@vN`.
**Acceptance:** comment on v3 → assistant ships v5 → comment either re-anchors to the right element or is cleanly flagged orphaned with a link to v3; nothing is silently lost.

### Phase 6 — The feedback loop
**Build:** `get_comments` (+ optional `resolve_comment`) returning each comment with its anchored element/text context; the assistant reads feedback, revises, and `update_doc`s; comment state preserved across the round-trip.
**Acceptance:** a human comments → the assistant reads the comments via MCP → revises the doc → the comments survive and re-anchor; closing the loop end to end works from a real assistant session.

### Phase 7 — Polish / deferred
Realtime presence + live comment sync; version timeline + diff view ("what changed since I commented"); per-doc network allowlist approval UI; reference-aware GC + retention policy enforcement; custom domains; non-MCP browser-extension capture; analytics; org/team features.

---

## 14. Open decisions (ask the human)

1. **Commenter identity:** require Google sign-in for all commenters (recommended — keeps identity integrity and the email-binding model clean), or also allow lightweight magic-link commenters who never create an account? Tradeoff: friction vs. integrity.
2. **Default network posture for docs:** ship fully sandboxed (no outbound network) and add the allowlist+approval later, or build the approval flow in Phase 4? (Recommended: fully sandboxed first.)
3. **Render origin runtime:** Cloudflare Worker (recommended) vs. a dedicated Node service.
4. **`published` ref:** model both `latest` and `published` from Phase 1 (recommended — cheap), but when do we expose the publish/review toggle in the UI? (Suggest: data model in P1, UI in P3 alongside sharing.)
5. **Editor role semantics:** what exactly can an `editor` do in v1 beyond commenting (trigger updates? manage shares?) — scope minimally.
6. **ORM:** Drizzle vs. Prisma.
```