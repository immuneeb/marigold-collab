# Agent-mode generation A/B — patch vs full-replace (2026-07-07, prod)

The scripted harness measures wire+server (parity for patch vs full-replace, since
the server re-ingests the full page either way). This is the OTHER axis: an agent
actually revising a doc, so the clock includes the model **emitting** the payload —
the dominant real-world cost. N=3 medians against `marigold-collab-web.vercel.app`,
admin-token bypass on the create cap.

## Method
Per rep: create a fresh quick doc seeded with the fixture; make the identical
visible change two ways — (A) re-emit the WHOLE updated page and PUT
`/content`, (B) emit one patch and POST `/patch`. `t0` stamped before emitting,
`t1` after the write response, so `t1−t0` brackets model token-generation +
one round-trip + the write. The full-replace page was genuinely re-typed each
rep, not echoed from disk.

## Results

| doc | full-replace wall | patch wall | wall speedup | full tokens | patch tokens | token reduction |
|---|---:|---:|---:|---:|---:|---:|
| 30 KB | 103.1 s (103086 ms) | 7.9 s (7871 ms) | **13.1×** | ~8,486 | ~56 | **152×** |
| 100 KB | 318.1 s / 5.3 min (318119 ms) | 8.7 s (8748 ms) | **36.4×** | ~28,409 | ~56 | **507×** |

Raw reps (ms):
- 30 KB full [105823, 102087, 103086] · patch [10712, 7871, 7293]
- 100 KB full [325063, 318119, 317361] · patch [8748, 10159, 7725]

## Findings
1. **Patch latency is document-size-independent** (~8 s at both 30 KB and 100 KB);
   full-replace scales ~linearly with the page (103 s → 318 s as bytes ~3×).
   Patch cost tracks the size of the *change*; full-replace tracks the size of the
   *document*. This is the core scaling result.
2. The ~8 s patch floor is almost entirely fixed harness/turn overhead (56 tokens
   generate in < 1 s), so the reported speedups are **conservative** — the pure
   generation gap is larger.
3. Re-emitting the 100 KB page by hand drifted duplicated tables in (actual
   105–107 KB vs 103 KB seed) — the realistic "full-replace silently corrupts
   unchanged content" failure that patch structurally avoids. A correctness win,
   not just latency.

## Caveats
- N=3, single machine; both arms include model reasoning overhead.
- tiktoken unavailable offline → tokens approximated at 3.7 B/tok; real cl100k on
  dense HTML is ~4–4.3 B/tok, so token reductions are slightly understated.
- Companion: `2026-07-07-patch-vs-fullreplace.md` (scripted wire parity) and
  `2026-07-07-*-marigold-http-*` (per-op door latency, 5 reps).

## Theme create (companion measurement, prod)
Agent emitted 555 B of content (~150 tok); server produced the full 3,421 B
self-contained page — agent typed **16%** of the stored doc, theme supplied the
rest (scaffold + CSS) for free; page self-contained, zero external refs.
