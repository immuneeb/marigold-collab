import { type HTMLElement, parse } from "node-html-parser";
import {
  deinstrumentHtml,
  instrumentHtml,
  MGID_RE,
} from "./instrument";

// Patch ops — the small-payload update path. Instead of re-sending the whole
// page (update_doc / PUT), an agent sends only the elements that changed, keyed
// by the deterministic data-marigold-id the instrumentation already assigns.
// Same id machinery as applyInlineEdits, so patched structure re-derives the
// same ids on re-ingest and readers' comments re-anchor.

export type PatchOp =
  // Replace an element's INNER content (matches applyInlineEdits semantics —
  // the element, its tag and its id stay; only children change).
  | { op: "replace"; marigoldId: string; html: string }
  // Replace an element's text content. `text` is HTML-escaped, so it can never
  // inject markup (safe for untrusted feedback-driven edits).
  | { op: "setText"; marigoldId: string; text: string }
  // Insert new markup immediately AFTER the target element (as its next sibling).
  | { op: "append"; marigoldId: string; html: string }
  // Remove the target element (and its subtree).
  | { op: "remove"; marigoldId: string };

export type PatchErrorCode = "no_ops" | "malformed_op" | "unknown_id";

/** Typed failure for a patch. `ids` lists the marigoldIds that couldn't be
 * found (unknown_id), so the caller can report exactly what didn't match. */
export class PatchError extends Error {
  constructor(
    public code: PatchErrorCode,
    message: string,
    public ids: string[] = [],
  ) {
    super(message);
    this.name = "PatchError";
  }
}

const OP_TYPES = new Set(["replace", "setText", "append", "remove"]);

/** Escape a string so it renders as literal text, never markup. */
function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function validateOp(op: PatchOp, i: number): void {
  if (!op || typeof op !== "object")
    throw new PatchError("malformed_op", `op[${i}] must be an object`);
  const kind = (op as { op?: unknown }).op;
  if (typeof kind !== "string" || !OP_TYPES.has(kind))
    throw new PatchError(
      "malformed_op",
      `op[${i}] has unknown op type ${JSON.stringify(kind)} (expected replace | setText | append | remove)`,
    );
  // Same injection-safe id gate applyInlineEdits uses: only `mg-` + 10 hex ever
  // reaches a selector, so a crafted id can't break out into a CSS selector.
  if (typeof op.marigoldId !== "string" || !MGID_RE.test(op.marigoldId))
    throw new PatchError(
      "malformed_op",
      `op[${i}] (${kind}) needs a valid marigoldId (mg-xxxxxxxxxx)`,
    );
  if ((kind === "replace" || kind === "append") && typeof (op as { html?: unknown }).html !== "string")
    throw new PatchError("malformed_op", `op[${i}] (${kind}) needs an html string`);
  if (kind === "setText" && typeof (op as { text?: unknown }).text !== "string")
    throw new PatchError("malformed_op", `op[${i}] (setText) needs a text string`);
}

/**
 * Apply a sequence of element-level patch ops to doc source and return clean
 * (deinstrumented) HTML ready for updateDoc. The source is first instrumented
 * (idempotent + deterministic — ids match exactly what applyInlineEdits and the
 * viewer's agent see), every op's target is resolved BEFORE any mutation so an
 * unknown id aborts the whole patch atomically (no partial application), then
 * ops apply in order and the injected ids/agent are stripped back out.
 *
 * Throws PatchError on an empty/malformed op list or any unknown marigoldId.
 */
export function applyPatchOps(html: string, ops: PatchOp[]): string {
  if (!Array.isArray(ops) || ops.length === 0)
    throw new PatchError("no_ops", "a patch needs at least one op");
  ops.forEach(validateOp);

  const root = parse(instrumentHtml(html), { comment: true });

  // Resolve every target up front. A missing id fails the whole patch (atomic),
  // so a doc is never left half-patched by a typo in one op.
  const resolved = ops.map((op) => ({
    op,
    el: root.querySelector(`[data-marigold-id="${op.marigoldId}"]`),
  }));
  const missing = [
    ...new Set(resolved.filter((r) => !r.el).map((r) => r.op.marigoldId)),
  ];
  if (missing.length > 0)
    throw new PatchError(
      "unknown_id",
      `no element with marigoldId: ${missing.join(", ")}`,
      missing,
    );

  for (const { op, el } of resolved) {
    const node = el as HTMLElement;
    switch (op.op) {
      case "replace":
        node.set_content(op.html);
        break;
      case "setText":
        node.set_content(escapeText(op.text));
        break;
      case "append":
        node.insertAdjacentHTML("afterend", op.html);
        break;
      case "remove":
        node.remove();
        break;
    }
  }

  return deinstrumentHtml(root.toString());
}
