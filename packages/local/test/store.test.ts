import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { instrumentHtml } from "@marigold/core/instrument";
import { diffInstrumented } from "@marigold/core/diff";
import {
  buildContext,
  buildHistory,
  decodeBaseline,
  docIdFor,
  encodeBaseline,
  isFullDocument,
  loadSidecar,
  prepareHtml,
  pushChange,
  reanchorComments,
  saveSidecar,
  trimSummary,
  wrapFragment,
  MAX_CHANGES,
  type LocalChange,
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
    expect(sc.changes).toEqual([]); // fresh sidecars carry an empty history
    sc.comments.push(comment(null));
    saveSidecar(file, sc);
    const again = loadSidecar(file);
    expect(again.comments).toHaveLength(1);
    expect(again.docId).toBe(sc.docId);
  });

  it("loads a pre-change-history sidecar with an empty changes list", () => {
    const dir = mkdtempSync(join(tmpdir(), "mgl-"));
    const file = join(dir, "old.html");
    writeFileSync(file, "<p>x</p>");
    // A sidecar written before this feature has no `changes` field.
    writeFileSync(
      `${file}.marigold.json`,
      JSON.stringify({ docId: "mgl-old", title: "Old", seq: 0, version: 3, comments: [], reviews: [] }),
    );
    const sc = loadSidecar(file);
    expect(sc.changes).toEqual([]);
    expect(sc.version).toBe(3);
  });

  it("round-trips changes[] and the gzip baseline through save/load", () => {
    const dir = mkdtempSync(join(tmpdir(), "mgl-"));
    const file = join(dir, "hist.html");
    const source = "<h1>Alpha</h1><p>The quick brown fox jumps over the lazy dog.</p>";
    writeFileSync(file, source);
    const sc = loadSidecar(file);
    const change: LocalChange = {
      version: 2,
      at: new Date().toISOString(),
      actor: "AI",
      intent: "tighten the intro",
      summary: diffInstrumented(source, "<h1>Alpha</h1><p>The lazy dog sleeps.</p>"),
    };
    pushChange(sc, change);
    sc.baseline = encodeBaseline(source, 1);
    saveSidecar(file, sc);

    const again = loadSidecar(file);
    expect(again.changes).toHaveLength(1);
    expect(again.changes[0]!.intent).toBe("tighten the intro");
    expect(again.changes[0]!.actor).toBe("AI");
    expect(again.changes[0]!.summary.stats.changed).toBeGreaterThan(0);
    expect(decodeBaseline(again.baseline)).toBe(source); // gzip survived the round-trip
  });

  it("pushChange caps the history at MAX_CHANGES (most recent kept)", () => {
    const dir = mkdtempSync(join(tmpdir(), "mgl-"));
    const file = join(dir, "cap.html");
    writeFileSync(file, "<p>x</p>");
    const sc = loadSidecar(file);
    const empty = diffInstrumented("<p>a</p>", "<p>b</p>");
    for (let v = 1; v <= MAX_CHANGES + 5; v++) {
      pushChange(sc, { version: v, at: new Date().toISOString(), actor: "AI", summary: empty });
    }
    expect(sc.changes).toHaveLength(MAX_CHANGES);
    expect(sc.changes[0]!.version).toBe(6); // oldest 5 dropped
    expect(sc.changes.at(-1)!.version).toBe(MAX_CHANGES + 5);
  });
});

describe("trimSummary", () => {
  it("caps each list to the sample size, keeps true stats, and flags truncation", () => {
    const before = Array.from({ length: 10 }, (_, i) => `<p>original paragraph number ${i}</p>`).join("");
    const after = Array.from({ length: 10 }, (_, i) => `<p>rewritten paragraph number ${i}</p>`).join("");
    const full = diffInstrumented(before, after);
    expect(full.stats.changed).toBe(10); // every paragraph changed

    const trimmed = trimSummary(full);
    expect(trimmed.changed.length).toBe(6); // capped to CHANGE_SAMPLE
    expect(trimmed.stats.changed).toBe(10); // true count preserved
    expect(trimmed.truncated).toBe(true);
  });

  it("leaves a small summary untouched and unflagged", () => {
    const full = diffInstrumented("<p>one two three</p>", "<p>one two four</p>");
    const trimmed = trimSummary(full);
    expect(trimmed.changed.length).toBe(1);
    expect(trimmed.truncated).toBeUndefined();
  });
});

describe("history + context digest", () => {
  const change = (version: number, actor: "You" | "AI", intent?: string): LocalChange => ({
    version,
    at: new Date().toISOString(),
    actor,
    ...(intent ? { intent } : {}),
    summary: diffInstrumented("<h1>A</h1><p>old text</p>", "<h1>A</h1><p>new text</p>"),
  });

  it("buildHistory returns most-recent-first, capped at the limit", () => {
    const dir = mkdtempSync(join(tmpdir(), "mgl-"));
    const file = join(dir, "h.html");
    writeFileSync(file, "<p>x</p>");
    const sc = loadSidecar(file);
    pushChange(sc, change(1, "AI"));
    pushChange(sc, change(2, "You"));
    pushChange(sc, change(3, "AI", "why v3"));
    const hist = buildHistory(sc, 2);
    expect(hist.map((h) => h.version)).toEqual([3, 2]);
    expect(hist[0]!.intent).toBe("why v3");
    expect(hist[0]!.diffStats.changed).toBeGreaterThan(0);
  });

  it("buildContext pairs a resolved comment with the change at/after its version", () => {
    const dir = mkdtempSync(join(tmpdir(), "mgl-"));
    const file = join(dir, "c.html");
    writeFileSync(file, "<p>x</p>");
    const sc = loadSidecar(file);
    const openC = comment({ textQuote: { exact: "still open" } }, "open");
    openC.id = "c1";
    const resolvedC = comment({ textQuote: { exact: "was fixed" } }, "resolved");
    resolvedC.id = "c2";
    resolvedC.resolvedAtVersion = 3;
    sc.comments.push(openC, resolvedC);
    pushChange(sc, change(2, "AI"));
    pushChange(sc, change(3, "AI", "the fix"));

    const ctx = buildContext(sc);
    expect(ctx.openComments.map((c) => c.id)).toEqual(["c1"]);
    expect(ctx.openComments[0]!.anchoredText).toBe("still open");
    expect(ctx.corrections).toHaveLength(1);
    expect(ctx.corrections[0]!.comment.id).toBe("c2");
    expect(ctx.corrections[0]!.change!.version).toBe(3);
    expect(ctx.corrections[0]!.change!.intent).toBe("the fix");
  });
});
