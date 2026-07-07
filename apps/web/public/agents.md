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
```

Claiming is the graduation path: keep a doc long-term or control access
tightly by claiming it; until then the URL is the only capability.

## Authentication

Quick-doc requests authenticate with the `editKey` returned at creation,
passed either way:

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
edit it and PUT it back.

### Replace content

`PUT /api/docs/:docId/content` — quick key only, unclaimed + unexpired docs.
Full-page replacement; versioning and comment re-anchoring run as normal.
Body: `{ "html": string, "title"?: string }`.

```sh
curl -s -X PUT "https://marigold-collab-web.vercel.app/api/docs/doc_…/content" \
  -H 'content-type: application/json' \
  -H 'X-Marigold-Key: <key>' \
  -d '{"html":"<!doctype html><html><body><h1>v2</h1></body></html>"}'
```

`200`: `{ "versionId": "ver_…", "ordinal": 4, "unchanged": false, "expiresAt": "…" }`

`unchanged: true` means the content was byte-identical — no new version. Each
successful write renews the 30-day expiry. Once a doc is claimed, PUT returns
`403 claimed` — the owner edits through their account (MCP or dashboard).

### Claim (graduate) a doc

`POST /api/docs/:docId/claim` — requires **both** a signed-in session (cookie)
and the quick key. Browsers just open the `claimUrl`, which routes through
sign-in and confirms. `200`:

```json
{ "ok": true, "docId": "doc_…", "url": "…/d/<slug>", "dashboardUrl": "…/" }
```

The doc becomes a standard private owned doc; the key is burned; expiry is
cleared. Claiming also rescues an expired doc that hasn't been purged yet.

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
- Comments and the feedback loop (assign-to-AI, replies, resolve) live in the
  account model — connect via MCP (`/api/mcp`) to read and address feedback.
