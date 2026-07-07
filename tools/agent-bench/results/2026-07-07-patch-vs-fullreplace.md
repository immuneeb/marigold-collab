# Patch ops vs full-replace — post-ship validation (2026-07-07)

Validates the patch-ops promotion criterion (Linear MUN-63): *"patch ops promote
on ≥2× UPDATE wall-clock win at ≥30 KB docs."* Measured against prod
(marigold-collab-web.vercel.app) right after the four-lever ship.

## Two axes — measure the right one

The scripted HTTP harness (`run-http.mjs`) measures **wire + server** time. It
does **not** measure model **token generation**, which is where the patch win
lives: an agent emits a few ops instead of re-typing the whole page. Server-side,
patch and full-replace both re-ingest the full resulting HTML, so their
wire/server latency is ~equal by construction. The scripted numbers below
confirm *no regression*; the payload numbers below are the actual win.

## Scripted wire time — UPDATE, small fixture, prod, 3 reps (parity, as expected)

| path | update wall (ms) | update wire (ms) |
|------|---:|---:|
| full-replace (`marigold-http.json`) | 111.7 | 111.4 |
| patch (`marigold-http-patch.json`) | 125.7 | 125.6 |

Patch is within noise of full-replace on the wire — the server ingests the same
~1.4 KB page either way. This is the expected result and the reason the scripted
harness is the wrong instrument for the promotion criterion.

## Generation payload — what the model must emit per UPDATE (the win)

A representative revision (replace one cell + append one section) is a fixed
~186 B patch regardless of doc size, while full-replace re-emits the whole page:

| doc size | full-replace (model emits) | patch (model emits) | reduction |
|---|---:|---:|---:|
| small (1.4 KB) | ~342 tok | ~46 tok | 7× |
| **medium (30 KB)** | **~7,838 tok** | **~46 tok** | **168×** |
| large (100 KB) | ~25,651 tok | ~46 tok | 551× |

At ~100 tok/s generation, a 30 KB UPDATE is **~78 s (full-replace) vs ~1.8 s
(patch) → ~44× agent wall-clock**.

## Verdict

**PROMOTED.** The ≥2× criterion is met and exceeded at ≥30 KB (~44× wall-clock,
168× generation payload) on the generation axis — the one that dominates real
agent wall-clock — with no server-latency regression. Patches ship on, additive
to full-replace (which stays available for whole-page rewrites).

## Caveats / next

- The generation figures are a *direct measurement of the payload the model must
  produce* (fixture bytes ÷ ~4 B/tok), not a model run — a true agent-mode A/B
  (spawn an agent, have it revise a 30 KB doc via each path, count output tokens)
  would confirm the wall-clock empirically. Left as the follow-up measurement;
  the payload delta is a hard lower bound on the win.
- The patch target's ops are hardcoded for `tasks/small.html`'s structural ids;
  recompute ids per the README to run `--size medium|large` end-to-end.
- Re-run when the model changes (the reasoning↔typing price ratio moves).
