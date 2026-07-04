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

## Doc modes — objective-shaped UIs (next)

First-principles frame: a doc session is a human, an artifact, and an
objective — so the right UI follows from **what the session must produce**.
Seven output types cover the productivity space (taxonomy seeded by Thariq's
"The Unreasonable Effectiveness of HTML", saved in `Strategy & Roadmap/`):

| Mode | The session produces | Sample UIs |
|---|---|---|
| **Learn** *(shipped)* | a mental model | layered explainer: causal-chain outline, master "you are here" diagram, prediction + retrieval prompts |
| **Judge** | verdicts on existing work | one artifact (spec/plan/PR): rendered inline with margin annotations, severity color-coding, per-section sign-off. Many items: keep/kill swipe queue, one evidence card at a time |
| **Decide** | a selection + rationale | few options × many criteria: trade-off matrix with weight sliders; visual variants: side-by-side gallery (grid of labeled mockups); tacit criteria: pairwise "this or that" picker that infers the ranking |
| **Organize** | an arrangement of items | 2 buckets: swipe left/right; k states: kanban card drag; priority: drag-to-rank list; 2 dimensions: drag cards on an impact/effort canvas; time: timeline/calendar drag |
| **Tune** | parameter values | perceptual values (easing, color, spacing): sliders/knobs with live preview; structured config: form with dependency warnings; prompts/copy: editor with sample inputs re-rendering live |
| **Do** | a completed procedure | runbook: prerequisites check, stepper with persisted progress (localStorage), copy-paste command blocks, branch points ("if the build fails, jump to §4"), explicit definition of done |
| **Track** | an updated picture | "what changed since you last looked" first, metric tiles with takeaway titles, exception highlighting, incident timeline |

The interaction idiom follows from the *type* of the output, independent of
domain: boolean → swipe/toggle; enum → columns or segmented control; total
order → drag-to-rank; scalar → slider; 2D position → draggable canvas; set
membership → multi-select; located verdict → anchored comment; completion →
checkbox/stepper; free text → inline-editable region. An author agent that
knows this mapping can improvise a fit-for-purpose UI for any task instead
of defaulting to prose.

Marigold-native invariants, whatever the mode:

- **Structured exit.** Every manipulation must end as machine-readable state
  the AI can act on. v1: a "send to AI" button that serializes the result
  (ordering, buckets, values, checked steps) into a comment assigned to AI —
  the loop Thariq closes with copy-paste, closed natively. Later: a
  dedicated MCP write-back tool for widget state.
- **Guided defaults.** The doc arrives pre-sorted / pre-scored / pre-filled
  with the AI's best guess; the human corrects rather than starting cold.
- **Modes compose.** A Decide doc embeds a Learn layer per option; a Judge
  doc yields per-section verdicts; a Do doc ends in a Track view. Modes are
  posture packs + widget recipes in `packages/core/src/principles.ts` (the
  `LEARN_POSTURE` pattern), selected via `mode` on `start_analysis` — not
  separate products.

Suggested build order: **Judge** first (reuses commenting end to end; review
is the highest-frequency team use case), then **Organize** (forces the
structured-exit primitive into existence), then **Do**, **Decide**, **Tune**,
**Track**.

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
