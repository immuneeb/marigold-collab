import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
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
  updatedAt: string;
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
    updatedAt: new Date().toISOString(),
  };
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
    if (c.parentId) continue;
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
