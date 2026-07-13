import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { instrumentHtml } from "@marigold/core/instrument";
import {
  docIdFor,
  isFullDocument,
  loadSidecar,
  prepareHtml,
  reanchorComments,
  saveSidecar,
  wrapFragment,
  type LocalComment,
} from "../src/store";

function comment(anchor: LocalComment["anchor"], status: LocalComment["status"] = "open"): LocalComment {
  return {
    id: "c1",
    parentId: null,
    author: "You",
    body: "test",
    anchor,
    status,
    viaAssistant: false,
    createdAt: new Date().toISOString(),
  };
}

describe("fragment handling", () => {
  it("detects full documents", () => {
    expect(isFullDocument("<!doctype html><html><body>x</body></html>")).toBe(true);
    expect(isFullDocument("<html lang='en'>x</html>")).toBe(true);
    expect(isFullDocument("<h1>Hello</h1><p>fragment</p>")).toBe(false);
    expect(isFullDocument('<svg viewBox="0 0 10 10"><rect/></svg>')).toBe(false);
  });

  it("wraps fragments deterministically (stable ids across identical input)", () => {
    const frag = "<h1>Title</h1><p>Body text here</p>";
    const a = instrumentHtml(prepareHtml(frag, "T"));
    const b = instrumentHtml(prepareHtml(frag, "T"));
    expect(a).toBe(b);
    expect(a).toContain("data-marigold-id");
    expect(a).toContain("mg-wrap");
  });

  it("wraps svg sources so they render inline and get ids", () => {
    const svg = '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40"></circle></svg>';
    const out = instrumentHtml(wrapFragment(svg, "diagram"));
    expect(out).toContain("<svg");
    expect(out.match(/data-marigold-id/g)!.length).toBeGreaterThanOrEqual(2);
  });
});

describe("reanchorComments", () => {
  const v1 = instrumentHtml("<h1>Alpha</h1><p>The quick brown fox jumps over the dog</p>");
  const idOf = (html: string, tag: string) =>
    new RegExp(`<${tag} data-marigold-id="(mg-[0-9a-f]{10})"`).exec(html)?.[1] ??
    new RegExp(`<${tag}[^>]*data-marigold-id="(mg-[0-9a-f]{10})"`).exec(html)![1]!;

  it("keeps a stable id across an unrelated edit", () => {
    const pid = idOf(v1, "p");
    const c = comment({ marigoldId: pid, textQuote: { exact: "quick brown fox" } });
    const v2 = instrumentHtml("<h1>Alpha CHANGED</h1><p>The quick brown fox jumps over the dog</p>");
    reanchorComments([c], v2);
    expect(c.status).toBe("open");
    expect(c.anchor!.marigoldId).toBe(pid);
  });

  it("orphans when the anchored element disappears", () => {
    const pid = idOf(v1, "p");
    const c = comment({ marigoldId: pid, textQuote: { exact: "totally gone sentence" } });
    const v2 = instrumentHtml("<h1>Alpha</h1>");
    reanchorComments([c], v2);
    expect(c.status).toBe("orphaned");
  });

  it("recovers an orphan via text quote and refreshes the id", () => {
    const c = comment(
      { marigoldId: "mg-dead000000", textQuote: { exact: "quick brown fox jumps" } },
      "orphaned",
    );
    const changed = reanchorComments([c], v1);
    expect(changed).toBe(true);
    expect(c.status).toBe("open");
    expect(c.anchor!.marigoldId).toMatch(/^mg-[0-9a-f]{10}$/);
  });
});

describe("sidecar", () => {
  it("round-trips and derives a stable docId from the path", () => {
    const dir = mkdtempSync(join(tmpdir(), "mgl-"));
    const file = join(dir, "draft.html");
    writeFileSync(file, "<p>x</p>");
    const sc = loadSidecar(file);
    expect(sc.docId).toBe(docIdFor(file));
    sc.comments.push(comment(null));
    saveSidecar(file, sc);
    const again = loadSidecar(file);
    expect(again.comments).toHaveLength(1);
    expect(again.docId).toBe(sc.docId);
  });
});
