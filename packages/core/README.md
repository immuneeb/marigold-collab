# @marigold/core (OSS subset)

The shared anchoring engine and methodology packs, bundled into the
`marigold-draft` CLI at build time:

- `instrument.ts` — deterministic `data-marigold-id` instrumentation (element
  IDs are hashes of structural paths, so unchanged elements keep their IDs
  across revisions), composite comment anchors, and `resolveAnchor`'s
  `marigoldId → css → textQuote` fallback chain.
- `agent-src.ts` — the in-page agent injected into the review shell: captures
  anchors when you comment, streams element rects for overlay drawing.
- `principles.ts` — the "Marigold Way" methodology + doc-mode posture packs
  served by `marigold-draft principles`.

This is the same engine hosted Marigold runs server-side, published here as
the OSS subset of the internal package (the hosted service's versioning, ACL,
and storage modules are not part of the open-source release).
