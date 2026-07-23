import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { type DiffChange, type DiffEntry, type DiffSummary } from "@marigold/core/diff";
import { type CommentAnchor, resolveAnchor } from "@marigold/core/instrument";
import { type InsightSummary } from "./insights";

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
  /** How a resolved comment got there (MUN-127). An AGENT resolve is only a
   * "proposed" resolution — a claim the reviewer confirms ("confirmed") or
   * rejects (reopen) in the shell. Absent on legacy resolved comments (written
   * before this shipped); those render as plain, final resolved. */
  resolution?: "proposed" | "confirmed";
  /** Negative signals: each time the reviewer reopened this comment, the
   * version whose fix they judged did NOT address it. Most recent last, capped
   * at MAX_REJECTED_FIXES. Absent until the first rejection. */
  rejectedFixes?: RejectedFix[];
}

/** A fix the reviewer rejected by reopening — the version they judged failed to
 * address the comment, when, and an optional note. */
export interface RejectedFix {
  version: number;
  note?: string;
  at: string; // ISO
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

/** Most-recent rejected-fix signals kept per comment. */
export const MAX_REJECTED_FIXES = 5;

// ── comment status transitions (MUN-127) ────────────────────────────────────
// One implementation of the proposal/confirm/reopen state machine, shared by
// the server routes and any CLI path so the two surfaces can never drift. Who
// asked matters: an agent resolve is a proposal; only the reviewer confirms it,
// and only a reviewer reopen is a negative signal.

export type StatusActor = "reviewer" | "agent";

// Each transition returns whether it actually mutated the comment, so the
// caller can skip persisting/broadcasting a no-op. Transitions are idempotent:
// re-applying a state the comment is already in changes nothing.

/** Agent resolve = a PROPOSAL. Only an open→resolved transition proposes and
 * stamps the version; re-resolving an ALREADY-resolved comment is a no-op. That
 * guard is load-bearing: without it an agent retry on a reviewer-CONFIRMED
 * thread would downgrade it back to "proposed" and overwrite resolvedAtVersion,
 * re-pointing the correction pair at a later, unrelated version. */
export function applyAgentResolve(c: LocalComment, version: number): boolean {
  if (c.status === "resolved") return false;
  c.status = "resolved";
  c.resolution = "proposed";
  c.resolvedAtVersion = version;
  return true;
}

/** Reviewer resolve — final. Upgrades an agent proposal to confirmed (keeping
 * the version the agent stamped) or, with no prior proposal, stamps now. A
 * no-op on an already-confirmed thread. */
export function applyReviewerResolve(c: LocalComment, version: number): boolean {
  if (c.status === "resolved" && c.resolution === "confirmed") return false;
  c.status = "resolved";
  c.resolution = "confirmed";
  if (typeof c.resolvedAtVersion !== "number") c.resolvedAtVersion = version;
  return true;
}

/** Agent reopen — a plain reopen (e.g. the agent re-opening its own thread).
 * Not a rejection, so it records no negative signal. No-op if already open. */
export function applyAgentReopen(c: LocalComment): boolean {
  if (c.status === "open") return false;
  c.status = "open";
  delete c.resolution;
  delete c.resolvedAtVersion;
  return true;
}

/** Reviewer reopen — the reviewer rejects the fix. Records the version whose
 * fix did NOT address the comment as a negative signal, then clears the stamp.
 * No-op if the comment is already open (so a double reopen can't record a
 * phantom second rejection or churn events). */
export function applyReviewerReopen(c: LocalComment, note?: string): boolean {
  if (c.status === "open") return false;
  c.status = "open";
  delete c.resolution;
  if (typeof c.resolvedAtVersion === "number") {
    const fix: RejectedFix = {
      version: c.resolvedAtVersion,
      at: new Date().toISOString(),
      ...(note ? { note } : {}),
    };
    c.rejectedFixes = [...(c.rejectedFixes ?? []), fix].slice(-MAX_REJECTED_FIXES);
    delete c.resolvedAtVersion;
  }
  return true;
}

/** Single entry point for a comment status change: dispatches by target status
 * and who asked. `version` is the sidecar's current version; `note` rides an
 * (optional) reviewer reopen. Returns whether the comment actually changed. */
export function applyStatusChange(
  c: LocalComment,
  status: "open" | "resolved",
  actor: StatusActor,
  version: number,
  note?: string,
): boolean {
  if (status === "resolved") {
    return actor === "agent" ? applyAgentResolve(c, version) : applyReviewerResolve(c, version);
  }
  return actor === "agent" ? applyAgentReopen(c) : applyReviewerReopen(c, note);
}

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
  /** This open thread is an "answered" Q&A thread (open, an agent reply, never
   * reopened) — it also appears as an "answered" episode. The flag lets an agent
   * dedupe the two views (MUN-139). */
  answered: boolean;
}

/** One comment in an episode's thread (the root or a reply). */
export interface EpisodeComment {
  id: string;
  author: string;
  body: string;
  anchoredText: string | null;
  byAssistant: boolean;
}

/** One attempt at addressing the thread: either the standing resolve stamp or a
 * fix the reviewer later reopened. Each carries the change at/after its version
 * (before/after samples included) so the reader can see what was actually done.
 * Interpret the FULL chain — a reopen may be a follow-up refinement, not a
 * rejection; only the whole episode says which. */
export interface EpisodeAttempt {
  kind: "resolved" | "rejected";
  version: number;
  at?: string;
  note?: string;
  change: ChangeView | null;
}

/** A review episode: one comment thread with its full chain, every attempt at
 * addressing it, and where it landed. Replaces the older correction/rejected-fix
 * split (MUN-135) — the raw RejectedFix storage on a comment is unchanged; only
 * this served framing is new. The unit an agent distills an insight from. */
export interface Episode {
  threadId: string;
  anchoredText: string | null;
  kind: "overall" | null;
  status: string;
  /** Where the thread landed. "answered" (MUN-139) = an open thread the agent
   * replied to but that was never resolved (a Q&A thread) — synthesizable
   * learning like any other outcome; only applies while open (a later resolve/
   * reopen follows the confirmed/proposed/open states). */
  terminalState: "confirmed" | "proposed" | "open" | "answered";
  reopenCount: number;
  /** Newest comment time in the thread (root or reply) — the recency tiebreak
   * for episode ordering, so a freshly answered Q&A isn't buried at the cap. */
  lastActivityAt: string;
  comments: EpisodeComment[];
  attempts: EpisodeAttempt[];
}

export interface ContextDigest {
  /** Owner-level insights (machine-level), served first. Empty from the pure
   * `buildContext`; the daemon layers them in (dirty-first, capped). */
  insights: InsightSummary[];
  openComments: OpenCommentView[];
  recentChanges: ChangeView[];
  episodes: Episode[];
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

/** The earliest recorded change at or after `version` — the edit that most
 * likely carried out the attempt stamped at that version. */
function changeAtOrAfter(sc: Sidecar, version: number): ChangeView | null {
  const match = sc.changes.filter((ch) => ch.version >= version).sort((a, b) => a.version - b.version)[0];
  return match ? summarizeChange(match) : null;
}

/** The thread-root comment id a given comment belongs to (itself if a root). */
export function rootIdOf(sc: Sidecar, commentId: string): string | null {
  const c = sc.comments.find((x) => x.id === commentId);
  if (!c) return null;
  return c.parentId ?? c.id;
}

/** True if the thread has at least one agent (viaAssistant) reply. */
function hasAssistantReply(sc: Sidecar, rootId: string): boolean {
  return sc.comments.some((c) => c.parentId === rootId && c.viaAssistant);
}

/** A Q&A thread that's "answered" (MUN-139): open, the agent replied, and it was
 * never reopened. A reopen (rejectedFixes) means the reviewer rejected a fix and
 * the thread still needs work — so a reopened thread with an earlier agent reply
 * stays plain "open", not "answered". */
function isAnsweredThread(sc: Sidecar, root: LocalComment): boolean {
  return root.status === "open" && !root.rejectedFixes?.length && hasAssistantReply(sc, root.id);
}

/** Build one episode per comment thread — the full chain, every attempt, and
 * where it landed. Ordered learning-richest first (most reopens, then most
 * attempts) so a capped read keeps the episodes worth distilling. */
export function buildEpisodes(sc: Sidecar): Episode[] {
  const roots = sc.comments.filter((c) => !c.parentId);
  return roots
    .map((root): Episode => {
      const chain = [root, ...sc.comments.filter((c) => c.parentId === root.id)];
      const comments: EpisodeComment[] = chain.map((c) => ({
        id: c.id,
        author: c.author,
        body: c.body,
        anchoredText: anchoredTextOf(c),
        byAssistant: c.viaAssistant,
      }));
      // Attempts in chronological order: each reopened fix happened before the
      // current standing resolve stamp (a reopen clears the stamp; a re-resolve
      // sets a fresh one), so rejected entries first, the standing stamp last.
      const attempts: EpisodeAttempt[] = [];
      for (const rf of root.rejectedFixes ?? []) {
        attempts.push({
          kind: "rejected",
          version: rf.version,
          at: rf.at,
          ...(rf.note ? { note: rf.note } : {}),
          change: changeAtOrAfter(sc, rf.version),
        });
      }
      if (typeof root.resolvedAtVersion === "number") {
        attempts.push({ kind: "resolved", version: root.resolvedAtVersion, change: changeAtOrAfter(sc, root.resolvedAtVersion) });
      }
      // Resolved → confirmed/proposed. Otherwise an OPEN thread the agent
      // replied to and that was never reopened is "answered" — a Q&A outcome
      // worth synthesizing; anything else (incl. a reopened thread) stays "open".
      let terminalState: Episode["terminalState"];
      if (root.status === "resolved") {
        terminalState = root.resolution === "proposed" ? "proposed" : "confirmed";
      } else if (isAnsweredThread(sc, root)) {
        terminalState = "answered";
      } else {
        terminalState = "open";
      }
      const lastActivityAt = chain.reduce((max, c) => (c.createdAt > max ? c.createdAt : max), root.createdAt);
      return {
        threadId: root.id,
        anchoredText: anchoredTextOf(root),
        kind: root.kind ?? null,
        status: root.status,
        terminalState,
        reopenCount: (root.rejectedFixes ?? []).length,
        lastActivityAt,
        comments,
        attempts,
      };
    })
    // Learning-richest first (most reopens, then most attempts), then most
    // recent activity so a freshly answered Q&A isn't sorted behind stale threads.
    .sort(
      (a, b) =>
        b.reopenCount - a.reopenCount ||
        b.attempts.length - a.attempts.length ||
        (a.lastActivityAt < b.lastActivityAt ? 1 : a.lastActivityAt > b.lastActivityAt ? -1 : 0),
    );
}

/** The digest an agent reads to catch up on a draft: what's still open, what
 * recently changed, and one episode per thread (chain + attempts + outcome).
 * Pure over the sidecar — `insights` is empty here; the daemon layers in the
 * machine-level insights (and filters episodes to the unsynthesized ones). */
export function buildContext(sc: Sidecar): ContextDigest {
  // Every open root is surfaced (guaranteed surface — the daemon's doc-listing
  // count counts the same set). Answered Q&A threads carry an `answered` flag
  // and ALSO appear as "answered" episodes; the flag lets agents dedupe.
  const openComments = sc.comments
    .filter((c) => !c.parentId && c.status !== "resolved")
    .map((c) => ({
      id: c.id,
      author: c.author,
      body: c.body,
      status: c.status,
      kind: c.kind ?? null,
      anchoredText: anchoredTextOf(c),
      answered: isAnsweredThread(sc, c),
    }));

  const recentChanges = buildHistory(sc, CONTEXT_CHANGES);
  const episodes = buildEpisodes(sc);

  return { insights: [], openComments, recentChanges, episodes };
}
