import { describe, expect, it } from "vitest";
import {
  applyInlineEdits,
  deinstrumentHtml,
  instrumentHtml,
  resolveAnchor,
} from "../src/instrument";

const html =
  "<!doctype html><html><body><h1>Document Title</h1><p>Hello there <b>world</b></p></body></html>";

function idOf(instrumented: string, tag: string): string {
  const m = instrumented.match(
    new RegExp(`<${tag}[^>]*data-marigold-id="([^"]+)"`),
  );
  return m?.[1] ?? "";
}

describe("instrument", () => {
  it("injects ids + the agent, deterministically", () => {
    const a = instrumentHtml(html);
    const b = instrumentHtml(html);
    expect(a).toBe(b);
    expect(a).toMatch(/data-marigold-id="mg-[0-9a-f]{10}"/);
    expect(a).toContain("/__mg/agent.js");
  });

  it("is idempotent: ids preserved, single agent tag", () => {
    const once = instrumentHtml(html);
    const twice = instrumentHtml(once);
    expect((twice.match(/data-mg-agent/g) ?? []).length).toBe(1);
    const ids = (s: string) =>
      [...s.matchAll(/data-marigold-id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids(twice)).toEqual(ids(once));
  });

  it("deinstrument strips ids + agent", () => {
    const clean = deinstrumentHtml(instrumentHtml(html));
    expect(clean).not.toContain("data-marigold-id");
    expect(clean).not.toContain("__mg/agent.js");
  });

  it("resolveAnchor: marigoldId → css → textQuote → orphan", () => {
    const inst = instrumentHtml(html);
    const h1 = idOf(inst, "h1");
    expect(h1).toMatch(/^mg-/);
    expect(resolveAnchor(inst, { marigoldId: h1 })).toBe(h1);
    expect(resolveAnchor(inst, { marigoldId: "mg-gone", css: "h1" })).toBe(h1);
    expect(
      resolveAnchor(inst, {
        marigoldId: "mg-gone",
        textQuote: { exact: "Document Title" },
      }),
    ).toBe(h1);
    expect(
      resolveAnchor(inst, {
        marigoldId: "mg-gone",
        textQuote: { exact: "does-not-exist" },
      }),
    ).toBeNull();
  });

  it("applyInlineEdits: replaces element content, output stays clean", () => {
    const inst = instrumentHtml(html);
    const h1 = idOf(inst, "h1");
    const out = applyInlineEdits(html, [
      { marigoldId: h1, html: "Edited <b>title</b>" },
    ]);
    expect(out).toContain("Edited <b>title</b>");
    expect(out).not.toContain("data-marigold-id"); // saved source is clean
    expect(out).not.toContain("__mg/agent.js");
    // unchanged structure → same id on re-instrumentation (comments re-anchor)
    expect(idOf(instrumentHtml(out), "h1")).toBe(h1);
  });

  it("applyInlineEdits: rejects unknown/invalid ids", () => {
    expect(() =>
      applyInlineEdits(html, [{ marigoldId: "mg-0000000000", html: "x" }]),
    ).toThrow(/no edits/);
    expect(() =>
      applyInlineEdits(html, [
        { marigoldId: '"] , body { }', html: "x" }, // injection attempt
      ]),
    ).toThrow(/no edits/);
  });
});
