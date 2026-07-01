# Roadmap

## Shipped

- **P0 Foundations** — monorepo, Postgres schema, Google auth, dashboard.
- **P1 Hosting + versioning** — content-addressed ingest, immutable version
  chain, EdDSA capability tokens, isolated sandboxed render origin.
- **P2 MCP server** — OAuth 2.1 AS (DCR + PKCE) + `create/update/list/get_doc`.
- **P3 Identity + sharing** — email-keyed shares, verified-email binding,
  "Shared with me", roles + ACL, quarantine kill switch.
- **P4 Commenting + anchoring** — deterministic `data-marigold-id` injection,
  trusted anchor agent in the sandboxed iframe, parent-frame overlay (pins +
  threaded sidebar), composite anchors (marigoldId → css → xpath → textQuote →
  rect).
- **P5 Re-anchoring** — comments re-resolve across versions; survivors carry
  forward, unresolvable ones are flagged orphaned (never silently lost).
- **P6 Feedback loop** — `get_comments` / `resolve_comment` MCP tools; the
  assistant reads feedback, revises, comments re-anchor. `get_doc` returns
  clean (de-instrumented) HTML.
- **P7 (subset)** — per-doc network allowlist: owner approves outbound origins,
  render relaxes `connect-src` for that doc only.
- **Public landing page + how-to.**

## Deferred (P7 heavy items)

- **Realtime comment sync + presence** — currently fetch-on-open + 5s poll;
  needs a pub/sub (Ably / Pusher / Supabase Realtime).
- **Version-diff UI** — "what changed since I commented."
- **Reference-aware GC + retention** — nothing is collected yet; a
  comment-pinned version must never be GC'd.
- **Custom domains** — restores per-doc unguessable subdomains + a fully
  stateless render origin (see DEPLOY.md).
- **Dynamic in-doc network approval prompt** — v1 uses owner pre-approval in
  Manage; a viewer-facing "this doc wants to call X — allow?" is future work.
- **Browser-extension capture, analytics, org/team/SSO.**

## Pre-scale hardening (from the reviews)

- Per-account rate limits + doc/byte quotas (kill switch already ships).
- Read-only DB role for the render project.
- Real invite emails (add `RESEND_API_KEY`).
