import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { type DiffChange, type DiffEntry, type DiffSummary } from "@marigold/core/diff";
import { type CommentAnchor, resolveAnchor } from "@marigold/core/instrument";

export interface LocalComment {
  id: string;
  parentId: string | null;
  author: string; // "You" (browser) | "AI" (CLI reply)
  body: string;
  anchor: CommentAnchor | null;
  status: "open" | "resolved" | "orphaned";
  viaAssistant: boolean;
  createdAt: string;
  /** "overall" = doc-level feedback from the submit box — deliberately
   * anchor-less, never re-anchored/orphaned, rendered as its own card. Stored
   * as a comment so it shares the comments' durability and every read path
   * (an overallComment that only rode the round payload could be missed by
   * agents reading comments non-blockingly). */
  kind?: "overall";
  /** The sidecar version at which this comment was resolved — stamped on
   * resolve so the context digest can join a resolved comment to the change
   * that addressed it (the correction pair). Backward-compatible: absent on
   * comments resolved before this shipped. */
  resolvedAtVersion?: number;
}

/** One version bump's element-level diff, attributed and (optionally) explained
 * by the intent the agent noted for it. Mirrors the cloud version-history row
 * (core/versioning.ts) on the local surface. */
export interface LocalChange {
  version: number;
  at: string; // ISO
  actor: "You" | "AI"; // "You" = a review-shell inline edit; "AI" = a file write
  intent?: string; // "why", captured via `marigold-draft note` before the save
  summary: DiffSummary;
}

/** gzip+base64 of the last-seen draft source, so the diff base survives a
 * daemon restart (a cold daemon has no in-memory previous version). */
export interface SidecarBaseline {
  version: number;
  gz: string;
}

export interface ReviewRound {
  at: string;
  version: number;
  overallComment: string | null;
  openCommentIds: string[];
}

/**
 * The sidecar is the durable record of a review session — comments and review
 * rounds survive daemon restarts, and (like roughdraft's markdown-as-source-of-
 * truth) it's written BEFORE any handoff event fires, so feedback can't be lost
 * to a missed event. Lives next to the draft: `<file>.marigold.json`.
 */
export interface Sidecar {
  docId: string;
  title: string;
  seq: number;
  version: number;
  comments: LocalComment[];
  reviews: ReviewRound[];
  /** How many review rounds have been handed to an agent. reviews.length >
   * deliveredSeq ⇒ a round was submitted while no agent was listening; the
   * next wait delivers it immediately instead of blocking. */
  deliveredSeq: number;
  /** Element-level change history, one entry per version bump (most recent
   * last), capped at MAX_CHANGES. */
  changes: LocalChange[];
  /** Last-seen source, so a restarted daemon can still diff the next save. */
  baseline?: SidecarBaseline;
  /** "why" for the next save, set by `marigold-draft note` and consumed by the
   * next change event. */
  pendingIntent?: string;
  updatedAt: string;
}

/** Most-recent change entries retained — bounds the sidecar to a sane size. */
export const MAX_CHANGES = 200;

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function sidecarPathFor(file: string): string {
  return `${file}.marigold.json`;
}

export function docIdFor(absPath: string): string {
  return `mgl-${sha256Hex(absPath).slice(0, 10)}`;
}

export function defaultTitleFor(absPath: string): string {
  return basename(absPath).replace(/\.(html?|svg)$/i, "");
}

export function loadSidecar(absPath: string, title?: string): Sidecar {
  try {
    const raw = JSON.parse(readFileSync(sidecarPathFor(absPath), "utf8")) as Sidecar;
    if (raw && raw.docId && Array.isArray(raw.comments)) {
      if (title) raw.title = title;
      // Migration: pre-deliveredSeq sidecars were written when delivery was
      // always live — treat existing rounds as already handed over.
      if (typeof raw.deliveredSeq !== "number") raw.deliveredSeq = raw.reviews?.length ?? 0;
      // Migration: pre-change-history sidecars load with an empty history.
      if (!Array.isArray(raw.changes)) raw.changes = [];
      return raw;
    }
  } catch {
    /* missing or corrupt — start fresh */
  }
  return {
    docId: docIdFor(absPath),
    title: title ?? defaultTitleFor(absPath),
    seq: 0,
    version: 0,
    comments: [],
    reviews: [],
    deliveredSeq: 0,
    changes: [],
    updatedAt: new Date().toISOString(),
  };
}

/** Encode a draft source as the diff baseline (gzip+base64), tagged with the
 * version it represents. */
export function encodeBaseline(source: string, version: number): SidecarBaseline {
  return { version, gz: gzipSync(Buffer.from(source, "utf8")).toString("base64") };
}

/** Recover the baseline source, or null if absent/corrupt (diffing just skips). */
export function decodeBaseline(baseline: SidecarBaseline | undefined): string | null {
  if (!baseline?.gz) return null;
  try {
    return gunzipSync(Buffer.from(baseline.gz, "base64")).toString("utf8");
  } catch {
    return null;
  }
}

/** Append a change and keep only the most recent MAX_CHANGES entries. */
export function pushChange(sc: Sidecar, change: LocalChange): void {
  sc.changes.push(change);
  if (sc.changes.length > MAX_CHANGES) sc.changes = sc.changes.slice(-MAX_CHANGES);
}

export function saveSidecar(absPath: string, sc: Sidecar): void {
  sc.updatedAt = new Date().toISOString();
  writeFileSync(sidecarPathFor(absPath), JSON.stringify(sc, null, 2) + "\n");
}

/** Full HTML documents are served as-is; fragments (and .svg sources) get a
 * deterministic neutral wrapper — same input, same wrapper, so instrumented
 * ids stay stable across revisions. */
export function isFullDocument(src: string): boolean {
  return /<!doctype\s|<html[\s>]/i.test(src);
}

export const WRAP_MAIN_CLASS = "mg-wrap";

export function wrapFragment(src: string, title: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { margin: 0; background: #fffdf7; color: #1c1917; font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main.${WRAP_MAIN_CLASS} { max-width: 760px; margin: 0 auto; padding: 40px 24px 80px; }
</style>
</head>
<body>
<main class="${WRAP_MAIN_CLASS}">
${src}
</main>
</body>
</html>`;
}

export function prepareHtml(src: string, title: string): string {
  return isFullDocument(src) ? src : wrapFragment(src, title);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Re-anchor every root comment against a new version's instrumented HTML —
 * same policy as prod (core/versioning.ts): resolvable → carry forward with a
 * refreshed marigoldId (recovering orphans), open+unresolvable → orphaned.
 * Returns true if anything changed.
 */
export function reanchorComments(comments: LocalComment[], instrumentedHtml: string): boolean {
  let changed = false;
  for (const c of comments) {
    if (c.parentId || c.kind === "overall") continue;
    const anchor = c.anchor ?? {};
    const rid = resolveAnchor(instrumentedHtml, anchor);
    if (rid) {
      if (anchor.marigoldId !== rid || c.status === "orphaned") changed = true;
      c.anchor = { ...anchor, marigoldId: rid };
      if (c.status === "orphaned") c.status = "open";
    } else if (c.status === "open") {
      c.status = "orphaned";
      changed = true;
    }
  }
  return changed;
}

// ── history + context digest ────────────────────────────────────────────────
// Shared by the CLI (`context`/`get_history`) and the local MCP server, so both
// surfaces speak one shape. Pure functions over the sidecar.

/** How many changed/added/removed elements each change view carries inline. */
const CHANGE_SAMPLE = 6;
/** How many recent changes the context digest includes. */
const CONTEXT_CHANGES = 10;

/** Trim a diff summary down to what any consumer actually reads (CHANGE_SAMPLE
 * entries per list) before it's persisted in a change entry — the stored
 * history stays a few KB instead of the full 40×3-entry payload. `stats` keeps
 * the true counts; `truncated` is set if trimming (or the diff's own cap)
 * dropped entries. */
export function trimSummary(s: DiffSummary): DiffSummary {
  const added = s.added.slice(0, CHANGE_SAMPLE);
  const removed = s.removed.slice(0, CHANGE_SAMPLE);
  const changed = s.changed.slice(0, CHANGE_SAMPLE);
  const trimmed =
    added.length < s.added.length ||
    removed.length < s.removed.length ||
    changed.length < s.changed.length;
  return {
    added,
    removed,
    changed,
    stats: s.stats,
    ...(s.truncated || trimmed ? { truncated: true } : {}),
  };
}

/** A change flattened for reading: the stats plus a few sample elements. */
export interface ChangeView {
  version: number;
  at: string;
  actor: "You" | "AI";
  intent?: string;
  diffStats: DiffSummary["stats"];
  added: DiffEntry[];
  removed: DiffEntry[];
  changed: DiffChange[];
  truncated?: boolean;
}

export interface OpenCommentView {
  id: string;
  author: string;
  body: string;
  status: string;
  kind: "overall" | null;
  anchoredText: string | null;
}

/** A resolved comment joined to the change that (likely) addressed it. */
export interface CorrectionView {
  comment: { id: string; body: string; anchoredText: string | null };
  resolvedAtVersion: number;
  change: ChangeView | null;
}

export interface ContextDigest {
  openComments: OpenCommentView[];
  recentChanges: ChangeView[];
  corrections: CorrectionView[];
}

function anchoredTextOf(c: LocalComment): string | null {
  return c.anchor?.textQuote?.exact ?? null;
}

export function summarizeChange(c: LocalChange): ChangeView {
  return {
    version: c.version,
    at: c.at,
    actor: c.actor,
    ...(c.intent ? { intent: c.intent } : {}),
    diffStats: c.summary.stats,
    added: c.summary.added.slice(0, CHANGE_SAMPLE),
    removed: c.summary.removed.slice(0, CHANGE_SAMPLE),
    changed: c.summary.changed.slice(0, CHANGE_SAMPLE),
    ...(c.summary.truncated ? { truncated: true } : {}),
  };
}

/** Recent changes, most recent first, capped at `limit`. */
export function buildHistory(sc: Sidecar, limit = 50): ChangeView[] {
  return sc.changes
    .slice(-Math.max(0, limit))
    .reverse()
    .map(summarizeChange);
}

/** The digest an agent reads to catch up on a draft: what's still open, what
 * recently changed, and which resolved comments map to which correction. */
export function buildContext(sc: Sidecar): ContextDigest {
  const openComments = sc.comments
    .filter((c) => !c.parentId && c.status !== "resolved")
    .map((c) => ({
      id: c.id,
      author: c.author,
      body: c.body,
      status: c.status,
      kind: c.kind ?? null,
      anchoredText: anchoredTextOf(c),
    }));

  const recentChanges = buildHistory(sc, CONTEXT_CHANGES);

  // A correction is the earliest change at or after the version a comment was
  // resolved at — the edit that most likely addressed the note.
  const corrections: CorrectionView[] = sc.comments
    .filter((c) => !c.parentId && c.status === "resolved" && typeof c.resolvedAtVersion === "number")
    .map((c) => {
      const at = c.resolvedAtVersion!;
      const match = sc.changes
        .filter((ch) => ch.version >= at)
        .sort((a, b) => a.version - b.version)[0];
      return {
        comment: { id: c.id, body: c.body, anchoredText: anchoredTextOf(c) },
        resolvedAtVersion: at,
        change: match ? summarizeChange(match) : null,
      };
    });

  return { openComments, recentChanges, corrections };
}
