// Theme packs — decorative CSS lives on the server, not the model.
//
// Today the assistant regenerates a doc's whole HTML (styles + scaffold +
// content) on every create. Themes let it send *semantic body content* plus a
// theme name; the server inlines the theme's stylesheet into a full,
// self-contained page at ingest (`wrapWithTheme`). The stored doc is still ONE
// self-contained HTML page — no CDN/font/image URLs (CSP blocks them), just an
// inline <style>. Raw full-HTML authoring stays the untouched escape hatch.
//
// A theme is pinned per doc (docs.theme + docs.themeVersion): once a doc is
// themed, updates can be content-only and the server re-wraps with the same
// theme. Bump a theme's `version` whenever its CSS changes so the pin records
// which stylesheet produced the stored page.

export interface Theme {
  /** Stable id the agent passes (docs.theme). */
  id: string;
  /** Integer, bumped whenever `css` changes (docs.themeVersion pins it). */
  version: number;
  /** Self-contained stylesheet inlined into the page's <style>. */
  css: string;
  /** Optional extra <head> markup (self-contained only). */
  headExtra?: string;
}

/** Thrown when a caller names a theme that isn't in the registry. */
export class ThemeError extends Error {
  constructor(
    public code:
      | "unknown_theme"
      // themed authoring contract violations (surfaced as 400s by callers):
      | "content_required" // theme given but no/empty content to wrap
      | "content_needs_theme" // content given but no theme to wrap it in
      | "theme_conflicts_with_html", // theme given together with html/files
    message: string,
    /** The ids a caller may choose from, for a self-correcting error. */
    public validThemeIds: string[],
  ) {
    super(message);
    this.name = "ThemeError";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// marigold-clean — a warm, borderless system-font article. Readable measure,
// marigold-amber accent, light/dark via prefers-color-scheme.
// ─────────────────────────────────────────────────────────────────────────────

const CLEAN_CSS = `:root {
  color-scheme: light dark;
  --bg: #fffdf7;
  --fg: #1f2328;
  --muted: #5b6169;
  --accent: #bd7c0a;
  --border: #ece6d8;
  --code-bg: #f5f1e6;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #16181c;
    --fg: #e6e7e9;
    --muted: #9aa1ab;
    --accent: #e7a93b;
    --border: #2a2d33;
    --code-bg: #22252b;
  }
}
* { box-sizing: border-box; }
html { background: var(--bg); }
body {
  margin: 0 auto;
  max-width: 44rem;
  padding: 3rem 1.5rem 6rem;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-size: 1.0625rem;
  line-height: 1.65;
  color: var(--fg);
  background: var(--bg);
  -webkit-text-size-adjust: 100%;
  text-rendering: optimizeLegibility;
}
h1, h2, h3, h4, h5, h6 {
  line-height: 1.25;
  font-weight: 650;
  letter-spacing: -0.01em;
  margin: 2.4em 0 0.6em;
}
h1 { font-size: 2rem; margin-top: 0; letter-spacing: -0.02em; }
h2 { font-size: 1.4rem; padding-bottom: 0.3rem; border-bottom: 1px solid var(--border); }
h3 { font-size: 1.15rem; }
h4 { font-size: 1rem; }
p, ul, ol, blockquote, table, pre, figure { margin: 0 0 1.1rem; }
:where(h1, h2, h3, h4) + * { margin-top: 0; }
a { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; text-decoration-thickness: 1px; }
a:hover { text-decoration-thickness: 2px; }
strong { font-weight: 650; }
em { font-style: italic; }
ul, ol { padding-left: 1.4rem; }
li { margin: 0.3rem 0; }
li > ul, li > ol { margin: 0.3rem 0; }
blockquote {
  margin-left: 0;
  padding: 0.2rem 0 0.2rem 1.1rem;
  border-left: 3px solid var(--accent);
  color: var(--muted);
}
code {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 0.9em;
  background: var(--code-bg);
  padding: 0.12em 0.38em;
  border-radius: 4px;
}
pre {
  background: var(--code-bg);
  padding: 1rem 1.1rem;
  border-radius: 8px;
  overflow-x: auto;
  border: 1px solid var(--border);
}
pre code { background: none; padding: 0; font-size: 0.875rem; line-height: 1.55; }
table { border-collapse: collapse; font-size: 0.95rem; display: block; overflow-x: auto; }
th, td { text-align: left; padding: 0.55rem 0.7rem; border-bottom: 1px solid var(--border); }
th { font-weight: 650; border-bottom: 2px solid var(--border); }
img, svg, video, canvas { max-width: 100%; height: auto; }
hr { border: none; border-top: 1px solid var(--border); margin: 2.5rem 0; }
figcaption { color: var(--muted); font-size: 0.875rem; margin-top: 0.5rem; }
:where(details) {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 0.6rem 1rem;
  margin: 0 0 1.1rem;
}
summary { cursor: pointer; font-weight: 650; }`;

// ─────────────────────────────────────────────────────────────────────────────
// marigold-slate — a cool "report on paper" look. Serif display headings, a
// slate-blue accent, content set on a bordered surface card over a tinted page.
// ─────────────────────────────────────────────────────────────────────────────

const SLATE_CSS = `:root {
  color-scheme: light dark;
  --bg: #eef1f5;
  --surface: #ffffff;
  --fg: #232a33;
  --muted: #5f6b7a;
  --accent: #3f6cd0;
  --border: #dde2ea;
  --code-bg: #eef1f5;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0e1216;
    --surface: #171d24;
    --fg: #dfe4ea;
    --muted: #94a1b1;
    --accent: #7aa0ff;
    --border: #26303a;
    --code-bg: #1d252e;
  }
}
* { box-sizing: border-box; }
html { background: var(--bg); }
body {
  margin: clamp(0px, 4vw, 2.5rem) auto;
  max-width: 48rem;
  padding: 3.25rem clamp(1.25rem, 5vw, 3.5rem) 4rem;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-size: 1.0625rem;
  line-height: 1.7;
  color: var(--fg);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05), 0 10px 34px rgba(0, 0, 0, 0.05);
  -webkit-text-size-adjust: 100%;
  text-rendering: optimizeLegibility;
}
h1, h2, h3, h4, h5, h6 {
  font-family: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif;
  line-height: 1.2;
  font-weight: 600;
  color: var(--fg);
  margin: 2.2em 0 0.55em;
}
h1 { font-size: 2.1rem; margin-top: 0; letter-spacing: -0.01em; }
h2 { font-size: 1.5rem; }
h2::before {
  content: "";
  display: block;
  width: 2.2rem;
  height: 3px;
  background: var(--accent);
  border-radius: 2px;
  margin-bottom: 0.7rem;
}
h3 { font-size: 1.2rem; }
h4 { font-size: 1.02rem; }
p, ul, ol, blockquote, table, pre, figure { margin: 0 0 1.15rem; }
:where(h1, h2, h3, h4) + * { margin-top: 0; }
a { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; text-decoration-thickness: 1px; }
a:hover { text-decoration-thickness: 2px; }
strong { font-weight: 700; }
em { font-style: italic; }
ul, ol { padding-left: 1.4rem; }
li { margin: 0.35rem 0; }
li::marker { color: var(--accent); }
blockquote {
  margin: 0 0 1.15rem;
  padding: 0.6rem 1.1rem;
  border-left: 3px solid var(--accent);
  background: var(--code-bg);
  border-radius: 0 6px 6px 0;
  color: var(--muted);
}
code {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 0.9em;
  background: var(--code-bg);
  padding: 0.12em 0.38em;
  border-radius: 4px;
}
pre {
  background: var(--code-bg);
  padding: 1rem 1.1rem;
  border-radius: 8px;
  overflow-x: auto;
  border: 1px solid var(--border);
}
pre code { background: none; padding: 0; font-size: 0.875rem; line-height: 1.55; }
table { border-collapse: collapse; font-size: 0.95rem; display: block; overflow-x: auto; }
th, td { text-align: left; padding: 0.55rem 0.75rem; border-bottom: 1px solid var(--border); }
th { font-weight: 700; background: var(--code-bg); border-bottom: 2px solid var(--border); }
img, svg, video, canvas { max-width: 100%; height: auto; }
hr { border: none; border-top: 1px solid var(--border); margin: 2.5rem 0; }
figcaption { color: var(--muted); font-size: 0.875rem; margin-top: 0.5rem; }
:where(details) {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 0.6rem 1rem;
  margin: 0 0 1.15rem;
}
summary { cursor: pointer; font-weight: 700; }`;

/**
 * The built-in theme registry. Add a theme here (and cover it in
 * test/themes.test.ts); bump a theme's `version` whenever its CSS changes.
 */
export const themeRegistry: Readonly<Record<string, Theme>> = Object.freeze({
  "marigold-clean": {
    id: "marigold-clean",
    version: 1,
    css: CLEAN_CSS,
  },
  "marigold-slate": {
    id: "marigold-slate",
    version: 1,
    css: SLATE_CSS,
  },
});

/** Metadata for every built-in theme (surfaced to agents; no CSS payload). */
export function listThemes(): Array<{ id: string; version: number }> {
  return Object.values(themeRegistry).map((t) => ({ id: t.id, version: t.version }));
}

/** Look up a theme by id, or throw a ThemeError listing the valid ids. */
export function getTheme(id: string): Theme {
  const theme = themeRegistry[id];
  if (!theme) {
    const valid = Object.keys(themeRegistry);
    throw new ThemeError(
      "unknown_theme",
      `unknown theme "${id}"; valid themes: ${valid.join(", ")}`,
      valid,
    );
  }
  return theme;
}

/**
 * Wrap agent-supplied body content in a theme's stylesheet, producing one
 * fully self-contained `<!doctype html>` page. `content` is the body's inner
 * HTML the agent authored; the returned page inlines the theme CSS in a
 * `<style>` and references no external assets. Throws ThemeError on an unknown
 * theme. The result flows through the normal ingest/instrument pipeline.
 */
export function wrapWithTheme(content: string, themeId: string): string {
  const theme = getTheme(themeId);
  const head = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style>\n${theme.css}\n</style>`,
    theme.headExtra ?? "",
  ]
    .filter(Boolean)
    .join("\n");
  return `<!doctype html>\n<html lang="en">\n<head>\n${head}\n</head>\n<body>\n${content}\n</body>\n</html>\n`;
}
