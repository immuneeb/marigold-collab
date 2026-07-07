#!/usr/bin/env node
// gen-fixtures.mjs — deterministic content fixtures for the agent-latency bench.
//
// Emits into tasks/: {small,medium,large}.{html,md} + {size}.revision.json.
// Output is fully deterministic (no Date, no randomness) so runs stay
// comparable across time and machines. Sizes are matched PER FORMAT (bytes on
// the wire are the latency-relevant control), so small.html and small.md carry
// equivalent-shaped but not byte-identical content.
//
// Usage: node gen-fixtures.mjs

import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "tasks");

const SIZES = { small: 1024, medium: 30 * 1024, large: 100 * 1024 };

// Sentinel tokens the runner keys on. Unique, whitespace-immune (they survive
// any markdown/table canonicalization a target might apply on read-back).
const T_PENDING = "status-pending-rev0";
const T_DONE = "status-done-rev1";
const T_APPEND = "bench-update-1";
const T_END = "bench-fixture-end";

// ---------------------------------------------------------------------------
// Deterministic prose
// ---------------------------------------------------------------------------

const WORDS = [
  "latency", "anchor", "version", "render", "publish", "review", "comment",
  "iterate", "shareable", "capability", "immutable", "content", "addressed",
  "viewer", "feedback", "revision", "schema", "payload", "baseline", "harness",
  "measure", "phase", "wire", "wall", "clock", "agent", "assistant",
  "document", "section", "table", "durable", "cold", "steady", "state",
  "promote", "criterion", "threshold", "quick", "start", "door",
];

const word = (i) => WORDS[((i % WORDS.length) + WORDS.length) % WORDS.length];

function sentence(seed, len) {
  const parts = [];
  for (let i = 0; i < len; i++) parts.push(word(seed * 7 + i * 3 + 1));
  const s = parts.join(" ");
  return s.charAt(0).toUpperCase() + s.slice(1) + ".";
}

function paragraph(seed) {
  const out = [];
  for (let i = 0; i < 4; i++) out.push(sentence(seed * 5 + i, 6 + ((seed + i) % 5)));
  return out.join(" ");
}

const num = (seed, col) => ((seed * 37 + col * 11) % 900) + 100;

// ---------------------------------------------------------------------------
// Shared content model
// ---------------------------------------------------------------------------

const title = (size) => `Launch Plan — agent-bench ${size} fixture`;

const INTRO =
  "Deterministic benchmark fixture. This document simulates an " +
  "assistant-authored launch plan: an answer-first summary, a status table " +
  "the revision step mutates, and filler sections sized to the target " +
  "payload. Do not hand-edit; regenerate with gen-fixtures.mjs.";

const STATUS_ROWS = [
  ["Draft launch narrative", "complete", "maya"],
  ["Fact-check pricing", T_PENDING, "ops"],
  ["Legal review", "in-progress", "sam"],
  ["Publish shareable doc", "queued", "agent"],
];

const FOOTER = `End of fixture. ${T_END}.`;

function fillerSection(k) {
  return {
    heading: `Section ${k}: ${word(k * 5)} ${word(k * 5 + 2)}`,
    paras: [paragraph(k * 3 + 1), paragraph(k * 3 + 2)],
    table:
      k % 3 === 0
        ? {
            headers: ["Metric", "Q1", "Q2", "Q3"],
            rows: [1, 2, 3, 4].map((r) => [
              `${word(k * 11 + r)} ${word(k * 11 + r + 4)}`,
              String(num(k + r, 1)),
              String(num(k + r, 2)),
              String(num(k + r, 3)),
            ]),
          }
        : null,
  };
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

const CSS =
  ":root{color-scheme:light dark}" +
  "body{font:16px/1.6 system-ui,sans-serif;margin:0;background:#faf7f2;color:#1a1a1a}" +
  "main{max-width:720px;margin:0 auto;padding:2rem 1.25rem}" +
  "h1{font-size:1.6rem;border-bottom:3px solid #e8a33d;padding-bottom:.4rem}" +
  "h2{font-size:1.15rem;margin-top:2rem}" +
  "table{border-collapse:collapse;width:100%;margin:1rem 0}" +
  "th,td{border:1px solid #d8d2c6;padding:.45rem .6rem;text-align:left}" +
  "th{background:#f3ecdf}";

function htmlTable(headers, rows, benchRow) {
  const head = `<tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr>`;
  const body = rows
    .map((r) =>
      `<tr>${r
        .map((c, i) =>
          benchRow && c === T_PENDING && i === 1
            ? `<td data-bench="rev-target">${c}</td>`
            : `<td>${c}</td>`,
        )
        .join("")}</tr>`,
    )
    .join("\n");
  return `<table>\n${head}\n${body}\n</table>`;
}

function renderHtml(size, sections) {
  const parts = [
    "<!doctype html>",
    '<html lang="en">',
    `<head><meta charset="utf-8"><title>${title(size)}</title><style>${CSS}</style></head>`,
    "<body>",
    "<main>",
    `<h1>${title(size)}</h1>`,
    `<p>${INTRO}</p>`,
    "<h2>Status</h2>",
    htmlTable(["Task", "Status", "Owner"], STATUS_ROWS, true),
  ];
  for (const s of sections) {
    parts.push(`<h2>${s.heading}</h2>`);
    for (const p of s.paras) parts.push(`<p>${p}</p>`);
    if (s.table) parts.push(htmlTable(s.table.headers, s.table.rows, false));
  }
  parts.push(`<p class="footer">${FOOTER}</p>`, "</main>", "</body>", "</html>");
  return parts.join("\n") + "\n";
}

function mdTable(headers, rows) {
  const line = (cells) => `| ${cells.join(" | ")} |`;
  return [line(headers), line(headers.map(() => "---")), ...rows.map(line)].join("\n");
}

function renderMd(size, sections) {
  const parts = [
    `# ${title(size)}`,
    "",
    INTRO,
    "",
    "## Status",
    "",
    mdTable(["Task", "Status", "Owner"], STATUS_ROWS),
  ];
  for (const s of sections) {
    parts.push("", `## ${s.heading}`, "");
    parts.push(s.paras[0], "", s.paras[1]);
    if (s.table) parts.push("", mdTable(s.table.headers, s.table.rows));
  }
  parts.push("", FOOTER, "");
  return parts.join("\n");
}

// Grow filler sections until the rendered output reaches the byte target.
function build(render, size, target) {
  const sections = [];
  let out = render(size, sections);
  let k = 1;
  while (Buffer.byteLength(out) < target) {
    sections.push(fillerSection(k++));
    out = render(size, sections);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Revision specs — change one table cell + append a section
// ---------------------------------------------------------------------------

function revisionSpec(size) {
  const appendHtml =
    `<section id="${T_APPEND}"><h2>Update 1</h2><p>Revision applied by agent-bench: ` +
    `pricing fact-check complete; figures confirmed against the status table. ${T_APPEND}.</p></section>\n`;
  const appendMd =
    `\n## Update 1\n\nRevision applied by agent-bench: pricing fact-check complete; ` +
    `figures confirmed against the status table. ${T_APPEND}.\n`;
  return {
    size,
    description:
      "Change one table cell (Fact-check pricing: pending -> done) and append one 'Update 1' section.",
    html: {
      replace: { find: T_PENDING, with: T_DONE },
      append: { beforeMarker: "</main>", content: appendHtml },
      verify1MustContain: [T_PENDING, T_END],
      verify2MustContain: [T_DONE, T_APPEND, T_END],
    },
    md: {
      replace: { find: T_PENDING, with: T_DONE },
      append: { content: appendMd },
      verify1MustContain: [T_PENDING, T_END],
      verify2MustContain: [T_DONE, T_APPEND, T_END],
    },
    comment: {
      find: "Fact-check pricing",
      body:
        "agent-bench: please double-check the pricing figures behind this row before the next revision.",
    },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

mkdirSync(OUT, { recursive: true });

const report = [];
for (const [size, target] of Object.entries(SIZES)) {
  const html = build(renderHtml, size, target);
  const md = build(renderMd, size, target);
  writeFileSync(path.join(OUT, `${size}.html`), html);
  writeFileSync(path.join(OUT, `${size}.md`), md);
  writeFileSync(
    path.join(OUT, `${size}.revision.json`),
    JSON.stringify(revisionSpec(size), null, 2) + "\n",
  );
  report.push({
    size,
    target_bytes: target,
    html_bytes: Buffer.byteLength(html),
    md_bytes: Buffer.byteLength(md),
  });
}

console.log("Generated fixtures in tasks/:");
for (const r of report)
  console.log(
    `  ${r.size.padEnd(6)} target ~${r.target_bytes}B  html=${r.html_bytes}B  md=${r.md_bytes}B`,
  );
