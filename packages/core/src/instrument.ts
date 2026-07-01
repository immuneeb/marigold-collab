import { type HTMLElement, parse } from "node-html-parser";
import { sha256Hex } from "./hash";

const AGENT_TAG = '<script src="/__mg/agent.js" data-mg-agent></script>';
const SKIP = new Set([
  "script",
  "style",
  "br",
  "hr",
  "meta",
  "link",
  "head",
  "title",
  "base",
  "html",
]);

// The composite anchor a comment stores (spec §8.1).
export interface CommentAnchor {
  marigoldId?: string | null;
  css?: string;
  xpath?: string;
  textQuote?: { prefix?: string; exact: string; suffix?: string };
  rect?: Record<string, number>;
}

function isElement(n: unknown): n is HTMLElement {
  return !!n && (n as { nodeType?: number }).nodeType === 1;
}

/**
 * Assign a stable, deterministic data-marigold-id to each content element based
 * on its structural path. Identical input → identical ids (dedup holds), and an
 * unchanged element keeps its id across versions (so comments re-anchor).
 */
function assignIds(el: HTMLElement, path: string): void {
  const counts: Record<string, number> = {};
  for (const child of el.childNodes) {
    if (!isElement(child)) continue;
    const tag = child.rawTagName?.toLowerCase();
    if (!tag) continue;
    counts[tag] = (counts[tag] ?? 0) + 1;
    const childPath = `${path}>${tag}:${counts[tag]}`;
    if (!SKIP.has(tag)) {
      if (!child.getAttribute("data-marigold-id")) {
        child.setAttribute("data-marigold-id", `mg-${sha256Hex(childPath).slice(0, 10)}`);
      }
    }
    assignIds(child, childPath);
  }
}

/** Inject stable element ids + the anchor-agent script tag. Idempotent + deterministic. */
export function instrumentHtml(html: string): string {
  const root = parse(html, { comment: true });
  const body = root.querySelector("body") ?? root;
  assignIds(body, "r");

  for (const s of root.querySelectorAll("script[data-mg-agent]")) s.remove();
  const target = root.querySelector("body") ?? root;
  target.insertAdjacentHTML("beforeend", AGENT_TAG);

  return root.toString();
}

/** Strip Marigold's injected ids + agent so the assistant sees clean HTML (get_doc). */
export function deinstrumentHtml(html: string): string {
  const root = parse(html, { comment: true });
  for (const el of root.querySelectorAll("[data-marigold-id]"))
    el.removeAttribute("data-marigold-id");
  for (const s of root.querySelectorAll("script[data-mg-agent]")) s.remove();
  return root.toString();
}

/**
 * Resolve a comment anchor against a version's (instrumented) HTML, in priority
 * order marigoldId → css → textQuote. Returns the resolving element's id, or
 * null if it can't be found (→ orphan). Used for server-side re-anchoring (P5).
 */
export function resolveAnchor(html: string, anchor: CommentAnchor): string | null {
  const root = parse(html, { comment: true });

  if (anchor.marigoldId) {
    const el = root.querySelector(`[data-marigold-id="${anchor.marigoldId}"]`);
    if (el) return anchor.marigoldId;
  }
  if (anchor.css) {
    try {
      const el = root.querySelector(anchor.css);
      const id = el?.getAttribute("data-marigold-id");
      if (id) return id;
    } catch {
      /* invalid selector — fall through */
    }
  }
  if (anchor.textQuote?.exact && anchor.textQuote.exact.length >= 8) {
    const needle = anchor.textQuote.exact.replace(/\s+/g, " ").trim();
    for (const el of root.querySelectorAll("[data-marigold-id]")) {
      const t = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (t.includes(needle)) {
        const id = el.getAttribute("data-marigold-id");
        if (id) return id;
      }
    }
  }
  return null;
}
