#!/usr/bin/env node
// run-http.mjs — scripted agent-latency benchmark for kind:"http" targets.
//
// Runs the phase sequence (DISCOVERY -> CREATE -> VERIFY1 -> UPDATE -> VERIFY2
// -> FEEDBACK [-> CLEANUP]) against a declarative target descriptor from
// targets/, N times, timing every phase (wall) and every request (wire) with
// performance.now(). Emits a per-run JSON into results/ and prints a markdown
// summary table. Node >= 18, zero dependencies.
//
// Usage:
//   node run-http.mjs --target targets/smde.json [--size small|medium|large]
//                     [--repeats 3] [--keep] [--base-url URL] [--no-discovery]
//
//   --keep          skip deletion of created docs (default: delete when the
//                   target has a delete endpoint)
//   --base-url      override target.baseUrl (e.g. point at a local dev server)
//   --no-discovery  skip the DISCOVERY requests (steady-state measurement)
//
// Exit code: non-zero if any phase of any repeat fails.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { performance } from "node:perf_hooks";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PHASES = ["discovery", "create", "verify1", "update", "verify2", "feedback"];

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { size: "small", repeats: 3, keep: false, discovery: true };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--target") opts.target = argv[++i];
    else if (a === "--size") opts.size = argv[++i];
    else if (a === "--repeats") opts.repeats = Number(argv[++i]);
    else if (a === "--keep") opts.keep = true;
    else if (a === "--base-url") opts.baseUrl = argv[++i];
    else if (a === "--no-discovery") opts.discovery = false;
    else if (a === "--help" || a === "-h") opts.help = true;
    else throw new Error(`unknown arg: ${a}`);
  }
  return opts;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const round1 = (n) => Math.round(n * 10) / 10;

const getPath = (obj, dotted) =>
  dotted.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);

// Substitute {name} placeholders. A value that IS exactly "{name}" is replaced
// wholesale (no string interpolation), so multi-KB content never gets mangled.
function fill(value, vars) {
  if (typeof value === "string") {
    const m = value.match(/^\{(\w+)\}$/);
    if (m) return vars[m[1]] ?? "";
    return value.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
  }
  if (Array.isArray(value)) return value.map((v) => fill(v, vars));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, vars)]));
  return value;
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function assertContains(text, needles, phase) {
  for (const n of needles)
    if (!text.includes(n))
      throw new Error(`${phase}: response missing sentinel ${JSON.stringify(n)}`);
}

function applyRevision(content, rev) {
  const { find, with: w } = rev.replace;
  if (!content.includes(find)) throw new Error(`revision: find-string not in content: ${find}`);
  let out = content.replace(find, w);
  const app = rev.append;
  if (app.beforeMarker && out.includes(app.beforeMarker))
    out = out.replace(app.beforeMarker, app.content + app.beforeMarker);
  else out = out + app.content;
  return out;
}

// ---------------------------------------------------------------------------
// one HTTP request, wire-timed
// ---------------------------------------------------------------------------

async function request(target, spec, vars, state, phase) {
  const url = new URL(fill(spec.path, vars), target.baseUrl);
  const headers = spec.headers ? { ...fill(spec.headers, vars) } : {};
  if (spec.auth) {
    if (!state.key) throw new Error(`${phase}: endpoint needs auth but no key captured yet`);
    const auth = target.auth ?? {};
    if (auth.placement === "query") url.searchParams.set(auth.queryParam ?? "key", state.key);
    else if (auth.placement === "header") headers[auth.headerName] = state.key;
    else if (auth.placement === "bearer") headers["authorization"] = `Bearer ${state.key}`;
    else throw new Error(`unknown auth placement: ${auth.placement}`);
  }
  let body;
  if (spec.body) {
    if (spec.body.type === "json") {
      headers["content-type"] = "application/json";
      body = JSON.stringify(fill(spec.body.template, vars));
    } else if (spec.body.type === "text") {
      headers["content-type"] = spec.body.contentType ?? "text/plain";
      body = fill(spec.body.template, vars);
    } else throw new Error(`unknown body type: ${spec.body.type}`);
  }
  // Conditional write: pass back the ETag exactly as received (targets like
  // SMDE want the quoted value verbatim).
  if (spec.conditional?.type === "if-match" && state.etag) headers["if-match"] = state.etag;

  const t0 = performance.now();
  const res = await fetch(url, { method: spec.method, headers, body });
  const text = await res.text();
  const wire = performance.now() - t0;

  const loggedPath =
    url.pathname + (url.search ? url.search.replace(/(key=)[^&]+/, "$1…") : "");
  state.requests.push({
    phase,
    method: spec.method,
    path: loggedPath,
    status: res.status,
    network_time_s: Number((wire / 1000).toFixed(6)),
    response_bytes: Buffer.byteLength(text),
  });

  const expect = spec.expectStatus ?? [200, 201, 204];
  if (!expect.includes(res.status))
    throw new Error(
      `${phase}: ${spec.method} ${url.pathname} -> ${res.status} (expected ${expect.join("/")}): ${text.slice(0, 300)}`,
    );
  const etag = res.headers.get("etag");
  if (etag) state.etag = etag;
  return { res, text };
}

// ---------------------------------------------------------------------------
// one full phase sequence
// ---------------------------------------------------------------------------

async function runOnce(target, fixture, rev, comment, opts, runIndex) {
  const state = { requests: [], key: null, etag: null, id: null, url: null };
  const phases = {};
  const run = { run: runIndex + 1, phases, http_requests: state.requests, ok: false };
  const tTotal = performance.now();

  const timed = async (name, fn) => {
    const t0 = performance.now();
    await fn();
    phases[`${name}_ms`] = round1(performance.now() - t0);
  };

  try {
    // DISCOVERY — scripted mode measures the wire cost of the discovery
    // fetches only; agent reading/reasoning time is the cold-start prompt's
    // job (prompts/cold-start.md). Skippable via --no-discovery.
    if (opts.discovery && target.discovery?.length) {
      await timed("discovery", async () => {
        for (const d of target.discovery)
          await request(target, { auth: false, ...d }, {}, state, "discovery");
      });
    }

    // CREATE — until we hold a live shareable URL (id + key + url in hand).
    await timed("create", async () => {
      const vars = {
        title: `agent-bench ${target.name} ${opts.size} run${runIndex + 1}`,
        content: fixture.v1,
      };
      const { text } = await request(target, target.create, vars, state, "create");
      let json = {};
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`create: non-JSON response: ${text.slice(0, 200)}`);
      }
      const map = target.create.response ?? {};
      state.id = getPath(json, map.id ?? "id");
      if (map.key) state.key = getPath(json, map.key);
      if (map.url) state.url = getPath(json, map.url);
      if (!state.id) throw new Error(`create: no doc id at ${map.id ?? "id"} in response`);
    });

    // VERIFY1 — read back, confirm v1 landed intact, capture ETag.
    await timed("verify1", async () => {
      const { text } = await request(target, target.read, { id: state.id }, state, "verify1");
      assertContains(text, rev.verify1MustContain, "verify1");
    });

    // UPDATE — one-row revision + appended section; conditional when supported.
    await timed("update", async () => {
      const vars = { id: state.id, content: fixture.v2, label: "agent-bench revision 1" };
      const { text } = await request(target, target.update, vars, state, "update");
      run.update_response = text.slice(0, 200);
    });

    // VERIFY2 — read back, confirm the revision (cell changed + section appended).
    await timed("verify2", async () => {
      const { text } = await request(target, target.read, { id: state.id }, state, "verify2");
      assertContains(text, rev.verify2MustContain, "verify2");
    });

    // FEEDBACK — post a comment, then read it back. Skipped (with a note) when
    // the target has no comment endpoints.
    if (target.commentCreate && target.commentList) {
      await timed("feedback", async () => {
        const vars = { id: state.id, commentBody: comment.body, commentFind: comment.find };
        const { text: created } = await request(target, target.commentCreate, vars, state, "feedback");
        try {
          const j = JSON.parse(created);
          if ("anchored" in j) run.comment_anchored = j.anchored;
        } catch {}
        const { text } = await request(target, target.commentList, { id: state.id }, state, "feedback");
        assertContains(text, [comment.body], "feedback");
      });
    } else {
      run.feedback_skipped = "target has no comment endpoints";
    }

    phases.total_ms = round1(performance.now() - tTotal);
    run.ok = true;
  } finally {
    run.doc_id = state.id;
    run.doc_url = state.url;
    // CLEANUP — outside total_ms; best-effort even after a failed phase.
    if (state.id && state.key) {
      if (opts.keep) run.cleanup = "kept (--keep)";
      else if (target.delete) {
        try {
          const t0 = performance.now();
          await request(target, target.delete, { id: state.id }, state, "cleanup");
          run.cleanup_ms = round1(performance.now() - t0);
          run.cleanup = "deleted";
        } catch (e) {
          run.cleanup = `delete FAILED: ${e.message}`;
        }
      } else run.cleanup = "target has no delete endpoint — doc left behind";
    }
  }
  return run;
}

// ---------------------------------------------------------------------------
// summary
// ---------------------------------------------------------------------------

function summarize(runs) {
  const rows = [];
  for (const phase of PHASES) {
    const walls = runs.map((r) => r.phases[`${phase}_ms`]).filter((v) => v != null);
    if (!walls.length) continue;
    const wires = runs.map((r) =>
      r.http_requests
        .filter((q) => q.phase === phase)
        .reduce((s, q) => s + q.network_time_s * 1000, 0),
    );
    const reqs = runs.map((r) => r.http_requests.filter((q) => q.phase === phase).length);
    rows.push({
      phase,
      wall_median_ms: round1(median(walls)),
      wire_median_ms: round1(median(wires)),
      requests_per_run: median(reqs),
    });
  }
  const totals = runs.map((r) => r.phases.total_ms).filter((v) => v != null);
  const totalWire = runs.map((r) =>
    r.http_requests
      .filter((q) => q.phase !== "cleanup")
      .reduce((s, q) => s + q.network_time_s * 1000, 0),
  );
  rows.push({
    phase: "TOTAL",
    wall_median_ms: round1(median(totals)),
    wire_median_ms: round1(median(totalWire)),
    requests_per_run: median(
      runs.map((r) => r.http_requests.filter((q) => q.phase !== "cleanup").length),
    ),
  });
  return rows;
}

function markdownTable(rows) {
  const lines = [
    "| phase | wall median (ms) | wire median (ms) | reqs/run |",
    "|---|---:|---:|---:|",
  ];
  for (const r of rows)
    lines.push(
      `| ${r.phase} | ${r.wall_median_ms} | ${r.wire_median_ms} | ${r.requests_per_run} |`,
    );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help || !opts.target) {
    console.log(
      "usage: node run-http.mjs --target targets/<t>.json [--size small|medium|large] [--repeats N] [--keep] [--base-url URL] [--no-discovery]",
    );
    process.exit(opts.help ? 0 : 1);
  }
  if (!["small", "medium", "large"].includes(opts.size))
    throw new Error(`--size must be small|medium|large, got ${opts.size}`);
  if (!Number.isInteger(opts.repeats) || opts.repeats < 1)
    throw new Error(`--repeats must be a positive integer`);

  const targetPath = path.isAbsolute(opts.target) ? opts.target : path.resolve(HERE, opts.target);
  const target = JSON.parse(readFileSync(targetPath, "utf8"));
  if (target.kind !== "http")
    throw new Error(
      `target kind is "${target.kind}" — run-http.mjs only drives kind:"http" targets. ` +
        `kind:"mcp" targets run via prompts/cold-start.md through an agent.`,
    );
  if (opts.baseUrl) target.baseUrl = opts.baseUrl;
  if (String(target.status).toUpperCase().startsWith("PENDING"))
    console.warn(`WARNING: target "${target.name}" is marked pending: ${target.status}\n`);

  const fmt = target.contentFormat; // "md" | "html"
  const v1 = readFileSync(path.join(HERE, "tasks", `${opts.size}.${fmt}`), "utf8");
  const revSpec = JSON.parse(
    readFileSync(path.join(HERE, "tasks", `${opts.size}.revision.json`), "utf8"),
  );
  const rev = revSpec[fmt];
  if (!rev) throw new Error(`no ${fmt} revision spec for size ${opts.size}`);
  const fixture = { v1, v2: applyRevision(v1, rev) };

  console.log(
    `target=${target.name} (${target.baseUrl})  size=${opts.size} (${Buffer.byteLength(v1)}B ${fmt})  repeats=${opts.repeats}\n`,
  );

  const runs = [];
  let failed = false;
  for (let i = 0; i < opts.repeats; i++) {
    process.stdout.write(`run ${i + 1}/${opts.repeats} ... `);
    try {
      const run = await runOnce(target, fixture, rev, revSpec.comment, opts, i);
      runs.push(run);
      console.log(
        `ok  total=${run.phases.total_ms}ms  doc=${run.doc_url ?? run.doc_id}  cleanup=${run.cleanup ?? "n/a"}`,
      );
    } catch (e) {
      failed = true;
      console.error(`FAILED: ${e.message}`);
      runs.push({ run: i + 1, ok: false, error: e.message });
    }
  }

  const okRuns = runs.filter((r) => r.ok);
  const summary = okRuns.length ? summarize(okRuns) : [];

  const startedAt = new Date();
  const result = {
    schema: "agent-bench/v1",
    product: target.product,
    target: target.name,
    kind: target.kind,
    mode: "scripted", // no model turns — wall times are a floor, see README
    base_url: target.baseUrl,
    size: opts.size,
    content_format: fmt,
    content_bytes: { v1: Buffer.byteLength(fixture.v1), v2: Buffer.byteLength(fixture.v2) },
    repeats: opts.repeats,
    ran_at: startedAt.toISOString(),
    node: process.version,
    runs,
    medians: Object.fromEntries(
      summary.map((r) => [
        r.phase,
        { wall_ms: r.wall_median_ms, wire_ms: r.wire_median_ms, requests: r.requests_per_run },
      ]),
    ),
  };

  const resultsDir = path.join(HERE, "results");
  mkdirSync(resultsDir, { recursive: true });
  const stamp = startedAt.toISOString().slice(0, 19).replace(/[T:]/g, "-");
  const outPath = path.join(resultsDir, `${stamp}-${target.name}-${opts.size}-scripted.json`);
  writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n");

  console.log(`\n## ${target.name} · ${opts.size} · ${okRuns.length}/${opts.repeats} runs ok\n`);
  if (summary.length) console.log(markdownTable(summary));
  console.log(`\nresult JSON: ${outPath}`);

  if (failed || !okRuns.length) process.exit(1);
}

main().catch((e) => {
  console.error(`fatal: ${e.message}`);
  process.exit(1);
});
