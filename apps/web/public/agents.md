# Marigold — HTTP API for agents

Marigold hosts self-contained interactive HTML pages ("docs") at shareable
URLs. Humans comment inline on the rendered page; agents read the feedback and
revise. This file is the complete HTTP reference. Base URL:

```
https://marigold-collab-web.vercel.app
```

## Three ways in

1. **Quick docs — zero auth, start here.** `POST /api/quick` with HTML. No
   account, no token. The response gives you a doc URL that carries the edit
   capability in a `?k=` key: anyone holding the URL can view and edit it, in
   the browser and via this API alike. Perfect for disposable, "look at this"
   docs.
2. **MCP — the full product.** Remote MCP server at `/api/mcp` (OAuth 2.1,
   dynamic client registration). Tools: `create_doc`, `update_doc`,
   `list_docs`, `get_doc`, `share_doc`, `delete_doc`, `get_comments`,
   `reply_to_comment`, `resolve_comment`, `start_analysis`. Docs are private
   to the account, shareable by email, with the inline comment/feedback loop.
3. **Session REST — the browser.** Signed-in humans use the dashboard, and the
   same cookie session works against `/api/docs`. Agents should prefer 1 or 2.

## Quick-doc lifecycle

```
POST /api/quick ──► unclaimed doc, URL carries the key (?k=)
      │                 · anyone with the URL views AND edits
      │                 · link-visible only — never listed anywhere
      │                 · expires ~30 days after last write (each write renews)
      ▼
POST /api/docs/:docId/claim  (signed-in + key) ──► claimed doc
                        · joins the account: private, email-based sharing
                        · expiry cleared, key BURNED — the old ?k= URL and
                          X-Marigold-Key stop granting anything, permanently
                        · continuity: the owner mints an AGENT KEY (below) so
                          you keep editing over the same API after the claim
```

Claiming is the graduation path: keep a doc long-term or control access
tightly by claiming it; until then the URL is the only capability.

## Authentication

Quick-doc requests authenticate with the `editKey` returned at creation;
claimed docs accept a minted agent key the same way. Either transport:

```
?k=<key>                      # query parameter
X-Marigold-Key: <key>         # header (preferred for writes)
```

## Errors

Every error is JSON with a machine code and a human/agent hint:

```json
{ "error": "expired", "hint": "This unclaimed quick doc has expired…" }
```

| Status | Meaning |
| --- | --- |
| 400 | Bad input (`invalid_json`, `html_required`, ingest errors) |
| 401 | Missing/wrong key, or sign-in required |
| 403 | Key is burned (`claimed`), doc quarantined, or no account access |
| 404 | No such doc / no content yet |
| 410 | Quick doc expired (`expired`) — claim it to restore, or create anew |
| 413 | Doc over 2 MB (`too_large`) |
| 429 | Quick-doc creation rate limit (`rate_limited`) |

## Endpoints

### Create a quick doc

`POST /api/quick` — no auth. Body: `{ "title"?: string, "html": string }`.

```sh
curl -s https://marigold-collab-web.vercel.app/api/quick \
  -H 'content-type: application/json' \
  -d '{"title":"Fleet dashboard","html":"<!doctype html><html><body><h1>Hi</h1></body></html>"}'
```

`201`:

```json
{
  "docId": "doc_…",
  "slug": "fleet-dashboard-x1y2z3",
  "url": "https://marigold-collab-web.vercel.app/d/fleet-dashboard-x1y2z3?k=<key>",
  "editKey": "<22-char key>",
  "claimUrl": "https://marigold-collab-web.vercel.app/claim/doc_…?k=<key>",
  "expiresAt": "2026-08-05T…Z"
}
```

Give the human the `url` (they see the page, can edit, and can claim from the
banner). Keep `editKey` to revise later. Creation is rate-limited per IP per
day; on `429`, reuse an existing doc or use an account (MCP). Creating is
POST-only — `GET /api/quick` answers `405` (so link previews and prefetchers
can never mint docs by accident).

### Read content

`GET /api/docs/:docId/content` — quick key **or** a signed-in session with
access.

```sh
curl -s "https://marigold-collab-web.vercel.app/api/docs/doc_…/content?k=<key>"
```

`200`: `{ "html": "...", "title": "...", "versionId": "ver_…", "ordinal": 3 }`

The HTML comes back clean (Marigold's internal instrumentation stripped) —
edit it and PUT it back. Add `?includeIds=1` to keep each element's
`data-marigold-id` attribute — you need those ids to target elements with a
patch (below). `?k=<key>` and the `X-Marigold-Key` header are interchangeable.

### Replace content

`PUT /api/docs/:docId/content` — quick key (unclaimed + unexpired docs) or an
update-capable agent key (claimed docs). Full-page replacement; versioning and
comment re-anchoring run as normal. Body: `{ "html": string, "title"?: string }`.

```sh
curl -s -X PUT "https://marigold-collab-web.vercel.app/api/docs/doc_…/content" \
  -H 'content-type: application/json' \
  -H 'X-Marigold-Key: <key>' \
  -d '{"html":"<!doctype html><html><body><h1>v2</h1></body></html>"}'
```

`200`: `{ "versionId": "ver_…", "ordinal": 4, "unchanged": false, "expiresAt": "…" }`

`unchanged: true` means the content was byte-identical — no new version. Each
successful unclaimed write renews the 30-day expiry. Once a doc is claimed, the
burned quick key gets `403 claimed` — continue with a minted agent key (below),
or the owner edits through their account (MCP or dashboard).

### Patch content (cheap updates)

`POST /api/docs/:docId/patch` — same keys as PUT. Change **only** the elements
that moved, keyed by their `data-marigold-id` (from `GET …/content?includeIds=1`),
instead of re-sending the whole page. Much cheaper than a full replace on a big
doc — the payload is the change, not the document. Body:
`{ "ops": [...], "baseVersionId"?: "ver_…" }`. Ops: `{"op":"replace","marigoldId","html"}`
(inner content), `{"op":"setText","marigoldId","text"}`, `{"op":"append","marigoldId","html"}`
(insert after), `{"op":"remove","marigoldId"}`. Ops apply atomically (an unknown
id fails the whole patch). Pass `baseVersionId` (the version you read) for
optimistic concurrency — a `409 doc_changed` means someone edited in between;
re-read and reapply.

```sh
curl -s -X POST "https://marigold-collab-web.vercel.app/api/docs/doc_…/patch" \
  -H 'content-type: application/json' -H 'X-Marigold-Key: <key>' \
  -d '{"ops":[{"op":"setText","marigoldId":"mg-1a2b3c4d5e","text":"Q3 revenue: $4.2M"}]}'
```

`200`: `{ "versionId": "ver_…", "ordinal": 5, "unchanged": false, "applied": 1 }`

### Watch for feedback (so you're the listener)

A doc's activity — comments, resolves, content changes — is an append-only,
per-doc feed. **After you share a doc, watch it**, so a human comment reaches
you in ~1 s instead of waiting until someone re-runs you. Nothing reacts unless
an agent is listening; the feed is durable, so a later read always catches up,
but the *live* response only happens while you watch.

`GET /api/docs/:docId/events?since=SEQ&wait=N` — long-poll (view access: quick
key or session). Returns the moment an event lands after `SEQ`, or an empty list
after `wait` seconds (max 55). `since=latest` starts from now.

```sh
# watch loop: block up to 50s, act on what returns, advance the cursor, repeat
SEQ=0
while true; do
  RES=$(curl -s "https://marigold-collab-web.vercel.app/api/docs/doc_…/events?since=$SEQ&wait=50&k=<key>")
  echo "$RES" | jq -c '.events[]'      # comment.created / comment.resolved / content.replaced / version.saved
  SEQ=$(echo "$RES" | jq '.latest')
done
```

`200`: `{ "events": [{"seq":7,"type":"comment.created","actor":"alice","at":…,"payload":{…}}], "latest": 7 }`.
On a comment, read it (`GET …/comments`), revise (patch or PUT), and if it was
a request, reply and resolve. MCP clients use the `get_feedback` tool for the
same loop. (On an unclaimed quick doc, comments are guest-authored — pass an
`author` name alongside the key.)

### Claim (graduate) a doc

`POST /api/docs/:docId/claim` — requires **both** a signed-in session (cookie)
and the quick key. Browsers just open the `claimUrl`, which routes through
sign-in and confirms. `200`:

```json
{ "ok": true, "docId": "doc_…", "url": "…/d/<slug>", "dashboardUrl": "…/" }
```

The doc becomes a standard private owned doc; the key is burned; expiry is
cleared. Claiming also rescues an expired doc that hasn't been purged yet.

### Agent keys (post-claim continuity)

Claimed docs accept **minted agent keys**: doc-scoped, role-capped, labeled,
individually revocable bearer keys, sent exactly like a quick key (`?k=` /
`X-Marigold-Key`). The claim page offers to mint one ("Keep your agent editing
this doc"); owners and grantees can also mint via the API. A key's effective
role is always `min(minter's current role, roleCap)`, recomputed on every
request — revoke the minter's grant and their keys die with it. Keys never
confer `owner`.

- `POST /api/docs/:docId/agent-keys` (signed-in; owner or grantee). Body:
  `{ "label": "my agent", "roleCap": "viewer"|"commenter"|"editor" }` →
  `200 { "id", "key", "label", "roleCap" }`. **`key` is shown once** — store it.
  Max 20 live keys per doc.
- `GET /api/docs/:docId/agent-keys` (signed-in) — owner lists all, a minter
  their own: `{ "keys": [{ id, label, roleCap, minter, createdAt, revokedAt,
  lastUsedAt }] }` (never the secret).
- `DELETE /api/docs/:docId/agent-keys/:keyId` (signed-in; owner revokes any,
  minter their own) → `{ "ok": true }`.

An editor-capped key can `GET`/`PUT …/content`, `POST …/patch`, and watch
`GET …/events`; viewer/commenter caps read only. Commenting with a minted key
is not supported yet. A revoked key answers `403 key_revoked`.

### Delete an unclaimed doc

`DELETE /api/docs/:docId` — with the quick key (unclaimed + unexpired docs),
the URL holder can dispose of a draft entirely: doc, versions, comments.
Permanent. On claimed docs, delete stays owner-only (agent keys can't delete).

### Viewer

`GET /d/<slug>?k=<key>` — the human-facing page. For unclaimed docs the key
grants view + edit; without it, unclaimed docs are invisible. Claimed docs
follow the account model (owner, email grants, optional public link).

## Authoring constraints

- **One self-contained HTML page, ≤ 2 MB.** Inline all CSS/JS/SVG; embed
  images as `data:` URIs. The renderer's CSP blocks external scripts, fonts,
  images, and network calls — they fail silently, so don't rely on CDNs.
- Docs render inside a sandboxed iframe on an isolated origin. Interactive JS
  is fine; it just can't phone home.
- **Keep the DOM structure stable across revisions.** Human comments anchor to
  elements and re-anchor across versions; in-place edits preserve anchors,
  while reordering or re-nesting sections orphans them (orphaned comments are
  kept, never dropped).
- Feedback: watch a doc live with the events feed (above), read threads with
  `GET /api/docs/:id/comments`, and address them (revise → reply → resolve).
  On owned docs, editors can assign a thread to AI (✨); connect via MCP
  (`/api/mcp`) — `get_feedback` blocks for it and `list_docs` counts the queue.
- On an **unclaimed quick doc**, the URL holder can comment too (no account):
  `POST /api/docs/:id/comments` with the key (`?k=` / `X-Marigold-Key`) and a
  body `{ "anchor", "versionId", "body", "author" }` — `author` (1–40 chars) is
  the guest display name; the comment is badged `guest`. Read them back with
  `GET /api/docs/:id/comments` + the key.
