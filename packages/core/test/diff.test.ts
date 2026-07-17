import { describe, expect, it } from "vitest";
import { diffInstrumented, isEmptyDiff } from "../src/diff";
import { instrumentHtml } from "../src/instrument";

const page = (body: string) =>
  `<!doctype html><html><body>${body}</body></html>`;

function idOf(html: string, tag: string, nth = 0): string {
  const re = new RegExp(`<${tag}[^>]*data-marigold-id="([^"]+)"`, "g");
  const ids: string[] = [];
  for (const m of html.matchAll(re)) ids.push(m[1]!);
  return ids[nth] ?? "";
}

describe("diffInstrumented", () => {
  it("returns an empty diff for identical content", () => {
    const html = page("<h1>Title</h1><p>Hello <b>world</b></p>");
    const d = diffInstrumented(html, html);
    expect(isEmptyDiff(d)).toBe(true);
    expect(d.stats).toEqual({ added: 0, removed: 0, changed: 0 });
  });

  it("reports a text edit as the deepest changed element only", () => {
    const before = page("<section><h1>Title</h1><p>Old text</p></section>");
    const after = page("<section><h1>Title</h1><p>New text</p></section>");
    const d = diffInstrumented(before, after);
    expect(d.stats).toEqual({ added: 0, removed: 0, changed: 1 });
    const c = d.changed[0]!;
    expect(c.tag).toBe("p");
    expect(c.before).toBe("Old text");
    expect(c.after).toBe("New text");
    // The <section>'s subtree changed too, but it is explained by the <p>.
    expect(d.changed.map((x) => x.tag)).not.toContain("section");
  });

  it("reports an inserted subtree as one topmost add", () => {
    const before = page("<h1>Title</h1>");
    const after = page(
      "<h1>Title</h1><section><h2>New</h2><p>Body</p></section>",
    );
    const d = diffInstrumented(before, after);
    expect(d.stats.added).toBe(1);
    expect(d.added[0]!.tag).toBe("section");
    expect(d.stats.removed).toBe(0);
  });

  it("reports a removed subtree as one topmost remove", () => {
    const before = page(
      "<h1>Title</h1><section><h2>Old</h2><p>Body</p></section>",
    );
    const after = page("<h1>Title</h1>");
    const d = diffInstrumented(before, after);
    expect(d.stats.removed).toBe(1);
    expect(d.removed[0]!.tag).toBe("section");
  });

  it("keys entries by the same ids instrumentation assigns", () => {
    const before = page("<h1>Title</h1><p>Old</p>");
    const after = page("<h1>Title</h1><p>New</p>");
    const d = diffInstrumented(before, after);
    expect(d.changed[0]!.id).toBe(idOf(instrumentHtml(after), "p"));
  });

  it("an appended sibling doesn't mark unchanged siblings as changed", () => {
    const before = page("<p>One</p>");
    const after = page("<p>One</p><p>Two</p>");
    const d = diffInstrumented(before, after);
    // Structural ids are positional: <p>One is p:1 on both sides → unchanged.
    expect(d.stats.changed).toBe(0);
    expect(d.stats.added).toBe(1);
    expect(d.added[0]!.text).toBe("Two");
  });

  it("caps entry lists but keeps true counts in stats", () => {
    const many = (n: number, txt: string) =>
      page(Array.from({ length: n }, (_, i) => `<p>${txt} ${i}</p>`).join(""));
    const d = diffInstrumented(many(60, "old"), many(60, "new"));
    expect(d.stats.changed).toBe(60);
    expect(d.changed.length).toBe(40);
    expect(d.truncated).toBe(true);
  });
});
