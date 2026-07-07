import { describe, expect, it } from "vitest";
import { applyPatchOps, PatchError } from "../src/patch";
import { instrumentHtml } from "../src/instrument";

const html =
  "<!doctype html><html><body><h1>Document Title</h1><p>Hello there <b>world</b></p><ul><li>one</li><li>two</li></ul></body></html>";

function idOf(tag: string, nth = 1): string {
  const inst = instrumentHtml(html);
  const re = new RegExp(`<${tag}[^>]*data-marigold-id="([^"]+)"`, "g");
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(inst))) {
    if (++i === nth) return m[1];
  }
  return "";
}

describe("applyPatchOps", () => {
  it("replace: swaps an element's inner content, output stays clean", () => {
    const h1 = idOf("h1");
    const out = applyPatchOps(html, [
      { op: "replace", marigoldId: h1, html: "Edited <b>title</b>" },
    ]);
    expect(out).toContain("Edited <b>title</b>");
    expect(out).not.toContain("Document Title");
    expect(out).not.toContain("data-marigold-id"); // saved source is clean
    expect(out).not.toContain("__mg/agent.js");
    // unchanged structure → same id on re-instrumentation (comments re-anchor)
    expect(idOf("h1")).toBe(instrumentIdOf(out, "h1"));
  });

  it("setText: sets text content and escapes markup (injection-safe)", () => {
    const h1 = idOf("h1");
    const out = applyPatchOps(html, [
      { op: "setText", marigoldId: h1, text: "<script>alert(1)</script> & done" },
    ]);
    // The angle brackets are escaped — no live <script> element is injected.
    expect(out).not.toContain("<script>alert(1)</script>");
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain("&amp; done");
  });

  it("append: inserts markup after the target element (as a sibling)", () => {
    const p = idOf("p");
    const out = applyPatchOps(html, [
      { op: "append", marigoldId: p, html: '<section id="added">new</section>' },
    ]);
    expect(out).toContain('<section id="added">new</section>');
    // Inserted AFTER the paragraph, before the list.
    expect(out.indexOf('id="added"')).toBeGreaterThan(out.indexOf("Hello there"));
    expect(out.indexOf('id="added"')).toBeLessThan(out.indexOf("<li>one"));
  });

  it("remove: deletes the target element", () => {
    const h1 = idOf("h1");
    const out = applyPatchOps(html, [{ op: "remove", marigoldId: h1 }]);
    expect(out).not.toContain("Document Title");
    expect(out).toContain("Hello there"); // siblings untouched
  });

  it("applies multiple ops in one call", () => {
    const h1 = idOf("h1");
    const li2 = idOf("li", 2);
    const out = applyPatchOps(html, [
      { op: "replace", marigoldId: h1, html: "New Title" },
      { op: "remove", marigoldId: li2 },
    ]);
    expect(out).toContain("New Title");
    expect(out).toContain("<li>one</li>");
    expect(out).not.toContain("<li>two</li>");
  });

  it("throws PatchError listing unknown ids, and applies nothing (atomic)", () => {
    const h1 = idOf("h1");
    try {
      applyPatchOps(html, [
        { op: "replace", marigoldId: h1, html: "Should not land" },
        { op: "replace", marigoldId: "mg-0000000000", html: "x" },
      ]);
      throw new Error("expected PatchError");
    } catch (e) {
      expect(e).toBeInstanceOf(PatchError);
      const pe = e as PatchError;
      expect(pe.code).toBe("unknown_id");
      expect(pe.ids).toEqual(["mg-0000000000"]);
      expect(pe.message).toContain("mg-0000000000");
    }
  });

  it("rejects an id-injection attempt as a malformed op (never a wildcard match)", () => {
    let err: unknown;
    try {
      applyPatchOps(html, [
        { op: "replace", marigoldId: '"] , [data-marigold-id] { }', html: "x" },
      ]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PatchError);
    expect((err as PatchError).code).toBe("malformed_op");
  });

  it("rejects an empty op list and unknown op types", () => {
    expect(() => applyPatchOps(html, [])).toThrow(PatchError);
    expect(() =>
      applyPatchOps(html, [
        // @ts-expect-error — intentionally invalid op type
        { op: "frobnicate", marigoldId: idOf("h1") },
      ]),
    ).toThrow(/unknown op type/);
  });

  it("patched structure re-derives ids on re-ingest (stable anchoring)", () => {
    const h1 = idOf("h1");
    const out = applyPatchOps(html, [
      { op: "replace", marigoldId: h1, html: "Just new text" },
    ]);
    // Editing only inner content leaves the element's structural path intact,
    // so re-instrumentation assigns the same id → comments re-anchor.
    expect(instrumentIdOf(out, "h1")).toBe(h1);
  });
});

// Read the id assigned to the nth `tag` after instrumenting an arbitrary doc.
function instrumentIdOf(doc: string, tag: string, nth = 1): string {
  const inst = instrumentHtml(doc);
  const re = new RegExp(`<${tag}[^>]*data-marigold-id="([^"]+)"`, "g");
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(inst))) {
    if (++i === nth) return m[1];
  }
  return "";
}
