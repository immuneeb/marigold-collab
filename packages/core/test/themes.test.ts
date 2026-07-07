import { describe, expect, it } from "vitest";
import { config } from "../src/env";
import { ingest } from "../src/ingest";
import {
  getTheme,
  listThemes,
  ThemeError,
  themeRegistry,
  wrapWithTheme,
} from "../src/themes";

const CONTENT = "<h1>Hello</h1><p>Body text with a distinctive marker phrase.</p>";
const themeIds = Object.keys(themeRegistry);

describe("themes", () => {
  it("lists the built-in themes with their versions", () => {
    const list = listThemes();
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list.map((t) => t.id)).toContain("marigold-clean");
    expect(list.map((t) => t.id)).toContain("marigold-slate");
    for (const t of list) expect(Number.isInteger(t.version)).toBe(true);
  });

  it("getTheme returns the registered theme", () => {
    const t = getTheme("marigold-clean");
    expect(t.id).toBe("marigold-clean");
    expect(t.css.length).toBeGreaterThan(0);
  });

  it("getTheme throws a ThemeError listing valid ids for an unknown theme", () => {
    try {
      getTheme("does-not-exist");
      throw new Error("expected getTheme to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ThemeError);
      const err = e as ThemeError;
      expect(err.code).toBe("unknown_theme");
      expect(err.validThemeIds).toEqual(themeIds);
      expect(err.message).toContain("marigold-clean");
    }
  });

  it("wrapWithTheme throws for an unknown theme", () => {
    expect(() => wrapWithTheme(CONTENT, "nope")).toThrowError(ThemeError);
  });

  describe.each(themeIds)("theme %s", (id) => {
    const page = wrapWithTheme(CONTENT, id);

    it("produces a self-contained doctype page containing the content", () => {
      expect(page.trimStart().toLowerCase().startsWith("<!doctype html>")).toBe(true);
      expect(page).toContain("<style>");
      expect(page).toContain(CONTENT);
      // The theme's own stylesheet is inlined.
      expect(page).toContain(themeRegistry[id].css);
    });

    it("references no external assets (CSP would block them)", () => {
      // No external stylesheets, scripts, fonts, or CDN/@import references.
      expect(page).not.toMatch(/<link\b/i);
      expect(page).not.toMatch(/@import/i);
      expect(page).not.toMatch(/src\s*=\s*["']https?:/i);
      expect(page).not.toMatch(/href\s*=\s*["']https?:/i);
      // url(...) only ever points at data: URIs, never remote hosts.
      const urls = page.match(/url\(([^)]*)\)/gi) ?? [];
      for (const u of urls) expect(u).toMatch(/url\(\s*["']?(data:|#)/i);
    });

    it("passes ingest (index.html manifest, under the byte cap)", () => {
      const r = ingest({ html: page });
      expect(Object.keys(r.manifest)).toEqual(["index.html"]);
      expect(r.byteSize).toBeLessThanOrEqual(config.maxDocBytes);
      // The agent's content survives instrumentation intact.
      const stored = new TextDecoder().decode(
        r.files.find((f) => f.path === "index.html")!.bytes,
      );
      expect(stored).toContain("Hello");
      expect(stored).toContain("distinctive marker phrase");
    });
  });
});
