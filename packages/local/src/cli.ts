/**
 * marigold-draft — a warm local daemon for the agent↔human review loop on
 * rich HTML/SVG drafts. One background server reused across opens (state in
 * ~/.marigold-local/server.json); `open --json` blocks until the reviewer hits
 * "Send feedback to agent" and prints the feedback JSON to stdout.
 *
 *   marigold-draft open <file> [--title T] [--json] [--no-browser] [--no-wait] [--timeout <s>]
 *   marigold-draft comments <file> [--json]
 *   marigold-draft context <file> [--json]
 *   marigold-draft note <file> "one line"
 *   marigold-draft reply <file> <commentId> <text…>
 *   marigold-draft resolve|reopen <file> <commentId>
 *   marigold-draft start [--port N] | status | stop | mcp
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import {
  DEFAULT_PORT,
  ensureServer,
  openBrowser,
  ping,
  readState,
  registerDoc,
  STATE_DIR,
  STATE_FILE,
  type OpenResult,
  type ServerState,
} from "./client";
import { type ChangeView, type ContextDigest } from "./store";
import { LocalServer, type ReviewPayload } from "./server";
import { formatShareResult, ShareError, shareDraft } from "./share";

function log(msg: string): void {
  // stderr, so `--json` stdout stays machine-clean
  process.stderr.write(msg + "\n");
}

// ── ANSI styling (guidelines/cli.html) ──────────────────────────────────────
// Status only ever paints stderr (stdout stays clean for --json / links / the
// status JSON). Brand mapping: success green ✓ · active/waiting yellow ● (the
// terminal's marigold) · errors red ✗ · meta dim. Paths and values are never
// colored — they read as bright default-fg. Honors NO_COLOR and non-TTY.
const ANSI = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m" };
function colorOn(): boolean {
  return !process.env.NO_COLOR && !!process.stderr.isTTY;
}
function paint(code: string, s: string): string {
  return colorOn() ? code + s + ANSI.reset : s;
}
const ok = (s: string) => paint(ANSI.green, s); // success ✓
const warn = (s: string) => paint(ANSI.yellow, s); // active/waiting ●
const err = (s: string) => paint(ANSI.red, s); // error ✗
const dim = (s: string) => paint(ANSI.dim, s); // meta
const bold = (s: string) => paint(ANSI.bold, s);
// Status glyphs match the GUI.
const G = { ok: "✓", wait: "●", off: "○", err: "✗" }; // ✓ ● ○ ✗

function parseArgs(argv: string[]): { cmd: string; positional: string[]; flags: Record<string, string | boolean> } {
  const [cmd = "help", ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith("--")) {
      const name = a.slice(2);
      const next = rest[i + 1];
      if (["title", "timeout", "port", "origin"].includes(name) && next !== undefined && !next.startsWith("--")) {
        flags[name] = next;
        i++;
      } else flags[name] = true;
    } else positional.push(a);
  }
  return { cmd, positional, flags };
}

async function serve(flags: Record<string, string | boolean>): Promise<void> {
  const server = new LocalServer({ allowShutdown: true });
  const port = await server.listen(Number(flags.port ?? DEFAULT_PORT));
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify({ port, pid: process.pid, startedAt: server.startedAt } satisfies ServerState, null, 2));
  log(`${ok(G.ok)} serving on http://127.0.0.1:${port}  ${dim(`(pid ${process.pid})`)}`);
  const bye = () => {
    const s = readState();
    if (s?.pid === process.pid) rmSync(STATE_FILE, { force: true });
    process.exit(0);
  };
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
}

function printReviewHuman(p: ReviewPayload): void {
  log(`\n${ok(G.ok)} feedback received on ${p.file}  ${dim(`(v${p.version})`)}`);
  if (p.overallComment) log(`  Overall: ${p.overallComment}`);
  for (const c of p.openComments) {
    log(`  [${c.id}] ${c.author}${c.kind === "overall" ? " (overall feedback)" : ""}${c.anchoredText ? ` on “${c.anchoredText.slice(0, 60)}”` : ""}: ${c.body}`);
    for (const r of c.replies) log(`      ↳ ${r.author}: ${r.body}`);
  }
  if (!p.openComments.length && !p.overallComment) log(dim("  (no open comments — the reviewer just signed off)"));
}

function statsLine(s: ChangeView["diffStats"]): string {
  return dim(`+${s.added} −${s.removed} ~${s.changed}`);
}

function printChangeHuman(c: ChangeView, indent = "  "): void {
  log(`${indent}${warn("●")} v${c.version} ${dim(c.actor)} ${statsLine(c.diffStats)}${c.intent ? `  ${dim("·")} ${c.intent}` : ""}`);
  for (const e of c.changed.slice(0, 3)) log(`${indent}    ${dim(`~ ${e.tag}`)} “${e.before.slice(0, 40)}” → “${e.after.slice(0, 40)}”`);
  for (const e of c.added.slice(0, 3)) log(`${indent}    ${dim(`+ ${e.tag}`)} “${e.text.slice(0, 60)}”`);
  for (const e of c.removed.slice(0, 3)) log(`${indent}    ${dim(`− ${e.tag}`)} “${e.text.slice(0, 60)}”`);
}

function printContextHuman(ctx: ContextDigest): void {
  log(bold("Open comments"));
  if (!ctx.openComments.length) log(dim("  (none)"));
  for (const c of ctx.openComments) {
    log(`  [${c.id}] ${c.author}${c.kind === "overall" ? " (overall feedback)" : ""}${c.anchoredText ? ` on “${c.anchoredText.slice(0, 60)}”` : ""}: ${c.body}`);
  }
  log(`\n${bold("Recent changes")}`);
  if (!ctx.recentChanges.length) log(dim("  (none)"));
  for (const c of ctx.recentChanges) printChangeHuman(c);
  log(`\n${bold("Corrections")} ${dim("(resolved comment → the change that addressed it)")}`);
  if (!ctx.corrections.length) log(dim("  (none)"));
  for (const p of ctx.corrections) {
    const glyph = p.confirmed ? ok(G.ok) : warn(G.wait);
    const label = p.confirmed ? dim("confirmed") : warn("proposed — awaiting the reviewer");
    log(`  ${glyph} [${p.comment.id}] ${label}${p.comment.anchoredText ? ` on “${p.comment.anchoredText.slice(0, 40)}”` : ""}: ${p.comment.body}`);
    if (p.change) printChangeHuman(p.change, "      ");
    else log(dim(`      (resolved at v${p.resolvedAtVersion}; no matching change recorded)`));
  }
  log(`\n${bold("Rejected fixes")} ${dim("(the reviewer reopened — these versions did NOT address the comment)")}`);
  if (!ctx.rejectedFixes.length) log(dim("  (none)"));
  for (const rf of ctx.rejectedFixes) {
    log(`  ${err(G.err)} [${rf.comment.id}]${rf.comment.anchoredText ? ` on “${rf.comment.anchoredText.slice(0, 40)}”` : ""}: ${rf.comment.body}`);
    for (const f of rf.rejected) log(dim(`      ${G.err} v${f.version} rejected${f.note ? ` — ${f.note}` : ""}`));
  }
}

async function open(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const file = positional[0];
  if (!file) throw new Error("usage: marigold-draft open <file.html> [--json] [--no-browser] [--no-wait] [--timeout <s>]");
  const port = await ensureServer(flags.port ? Number(flags.port) : undefined);
  const doc = await registerDoc(port, file, typeof flags.title === "string" ? flags.title : undefined);
  log(`${ok(G.ok)} serving ${doc.url}  ${dim(`(v${doc.version})`)}`);

  // A connected tab live-reloads on file changes — don't stack up new tabs.
  if (!flags["no-browser"] && doc.connectedClients === 0) openBrowser(doc.url);
  if (flags["no-wait"]) return;

  const budgetS = flags.timeout ? Number(flags.timeout) : Infinity;
  const deadline = Date.now() + budgetS * 1000;
  log(`${warn(G.wait)} waiting for feedback…  ${dim("(Ctrl-C to stop waiting)")}`);
  for (;;) {
    const remaining = (deadline - Date.now()) / 1000;
    if (remaining <= 0) {
      log(dim("timed out waiting for feedback"));
      process.exit(2);
    }
    const chunk = Math.min(25, Math.ceil(remaining));
    let r: Response;
    try {
      // The server delivers any round submitted while nobody was listening
      // immediately, so a re-armed wait can't miss feedback.
      r = await fetch(`http://127.0.0.1:${port}/api/docs/${doc.docId}/wait?timeout=${chunk}`);
    } catch {
      throw new Error("lost connection to the marigold-draft server");
    }
    if (r.status === 204) continue;
    if (!r.ok) throw new Error(`wait failed (${r.status})`);
    const payload = (await r.json()) as ReviewPayload;
    if (flags.json) process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    else printReviewHuman(payload);
    return;
  }
}

/**
 * `share` — graduate a local draft to hosted Marigold's quick door and print
 * the share + claim links. See src/share.ts for the (testable) core.
 */
async function share(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const file = positional[0];
  if (!file) throw new Error('usage: marigold-draft share <file.html> [--title "…"] [--origin <url>]');
  try {
    const result = await shareDraft(file, {
      title: typeof flags.title === "string" ? flags.title : undefined,
      origin: typeof flags.origin === "string" ? flags.origin : undefined,
    });
    // The links are the deliverable — stdout, so an agent can capture them.
    process.stdout.write(formatShareResult(result) + "\n");
  } catch (e) {
    if (e instanceof ShareError) {
      log(`${err(G.err)} ${e.message}`);
      if (e.hint) log(dim(`hint: ${e.hint}`));
      process.exit(1);
    }
    throw e;
  }
}

/**
 * `listen [paths…]` — hold one long-lived SSE stream and print each submitted
 * review round as a single JSON line on stdout. Path arguments (draft files
 * and/or directories) scope the stream to just those drafts, so parallel
 * agent sessions listening at once don't wake each other; with no paths it
 * covers every draft. Designed to run under a persistent monitor (agent
 * harness) or any supervisor: it reconnects forever, restarting the daemon if
 * needed, and the daemon counts the connection as agent presence for covered
 * docs (tabs show "● Agent connected").
 */
async function listen(paths: string[]): Promise<never> {
  const scopes = paths.map((p) => resolvePath(p));
  const qs = scopes.map((s) => `scope=${encodeURIComponent(s)}`).join("&");
  let announced = false;
  for (;;) {
    try {
      const port = await ensureServer();
      const resp = await fetch(`http://127.0.0.1:${port}/api/agent/listen${qs ? `?${qs}` : ""}`);
      if (resp.ok && resp.body) {
        if (!announced) {
          const what = scopes.length ? `scoped to: ${scopes.join(", ")}` : "all drafts";
          log(`${warn(G.wait)} listening for review rounds on http://127.0.0.1:${port}  ${dim(`(${what})`)}`);
          announced = true;
        }
        const reader = resp.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        let event = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).trimEnd();
            buf = buf.slice(i + 1);
            if (line.startsWith("event: ")) event = line.slice(7).trim();
            else if (line.startsWith("data: ")) {
              if (event === "review") process.stdout.write(line.slice(6).trim() + "\n");
              event = "";
            }
          }
        }
      }
    } catch {
      /* daemon restarting or unreachable — retry below */
    }
    log(dim("listen stream closed — reconnecting…"));
    await new Promise((r) => setTimeout(r, 1500));
  }
}

async function withDoc(file: string | undefined, flags: Record<string, string | boolean>): Promise<{ port: number; doc: OpenResult }> {
  if (!file) throw new Error("a <file> argument is required");
  const port = await ensureServer(flags.port ? Number(flags.port) : undefined);
  const doc = await registerDoc(port, file);
  return { port, doc };
}

async function main(): Promise<void> {
  const { cmd, positional, flags } = parseArgs(process.argv.slice(2));

  switch (cmd) {
    case "serve":
      await serve(flags);
      return;

    case "mcp": {
      // stdio MCP server for chat clients (Claude Desktop etc.).
      const { runMcp } = await import("./mcp");
      await runMcp();
      return;
    }

    case "principles": {
      // Print the Marigold authoring methodology (+ optional mode posture
      // pack) so agents without MCP can load it before authoring a draft.
      const { buildStartAnalysisText, MARIGOLD_MODES } = await import("@marigold/core/principles");
      const [first, ...restWords] = positional;
      const isMode = (s: string | undefined): s is (typeof MARIGOLD_MODES)[number] =>
        !!s && (MARIGOLD_MODES as readonly string[]).includes(s);
      const mode = isMode(first) ? first : undefined;
      const topic = (mode ? restWords : positional).join(" ") || undefined;
      process.stdout.write(buildStartAnalysisText(topic, mode) + "\n");
      return;
    }

    case "agent-setup": {
      const { runAgentSetup } = await import("./agent-setup");
      runAgentSetup({
        claudeMd: flags["no-claude-md"] !== true,
        agentsMd: flags["no-agents-md"] !== true,
      });
      return;
    }

    case "start": {
      const port = await ensureServer(flags.port ? Number(flags.port) : undefined);
      log(`${ok(G.ok)} running on http://127.0.0.1:${port}`);
      return;
    }

    case "open":
      await open(positional, flags);
      return;

    case "listen":
      await listen(positional);
      return;

    case "share":
      await share(positional, flags);
      return;

    case "comments": {
      const { port, doc } = await withDoc(positional[0], flags);
      const r = await fetch(`http://127.0.0.1:${port}/api/docs/${doc.docId}`);
      const data = (await r.json()) as { comments: unknown[] };
      if (flags.json) process.stdout.write(JSON.stringify(data.comments, null, 2) + "\n");
      else {
        const cs = data.comments as { id: string; parentId: string | null; author: string; body: string; status: string }[];
        for (const c of cs.filter((c) => !c.parentId)) {
          log(`[${c.id}] ${dim(`(${c.status})`)} ${c.author}: ${c.body}`);
          for (const rp of cs.filter((x) => x.parentId === c.id)) log(`    ↳ ${rp.author}: ${rp.body}`);
        }
        if (!cs.length) log(dim("no comments yet"));
      }
      return;
    }

    case "reply": {
      const [file, commentId, ...words] = positional;
      const body = words.join(" ");
      if (!commentId || !body) throw new Error("usage: marigold-draft reply <file> <commentId> <text…>");
      const { port, doc } = await withDoc(file, flags);
      const r = await fetch(`http://127.0.0.1:${port}/api/docs/${doc.docId}/comments/${commentId}/replies`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body, viaAssistant: true, author: "AI" }),
      });
      if (!r.ok) throw new Error(`reply failed (${r.status})`);
      log(`${ok(G.ok)} replied to ${commentId}`);
      return;
    }

    case "resolve":
    case "reopen": {
      const [file, commentId] = positional;
      if (!commentId) throw new Error(`usage: marigold-draft ${cmd} <file> <commentId>`);
      const { port, doc } = await withDoc(file, flags);
      // The agent surface: a resolve is a PROPOSAL (source "agent"), which the
      // reviewer confirms or reopens in the shell.
      const r = await fetch(`http://127.0.0.1:${port}/api/docs/${doc.docId}/comments/${commentId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: cmd === "resolve" ? "resolved" : "open", source: "agent" }),
      });
      if (!r.ok) throw new Error(`${cmd} failed (${r.status})`);
      if (cmd === "resolve") log(`${ok(G.ok)} proposed ${commentId} resolved ${dim("— the reviewer confirms in the shell")}`);
      else log(`${ok(G.ok)} reopened ${commentId}`);
      return;
    }

    case "note": {
      const [file, ...words] = positional;
      const intent = words.join(" ");
      if (!file || !intent) throw new Error('usage: marigold-draft note <file> "one line"');
      const { port, doc } = await withDoc(file, flags);
      const r = await fetch(`http://127.0.0.1:${port}/api/docs/${doc.docId}/note`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intent }),
      });
      if (!r.ok) throw new Error(`note failed (${r.status})`);
      log(`${ok(G.ok)} noted — the next save records: ${dim(intent)}`);
      return;
    }

    case "context": {
      const { port, doc } = await withDoc(positional[0], flags);
      const r = await fetch(`http://127.0.0.1:${port}/api/docs/${doc.docId}/context`);
      if (!r.ok) throw new Error(`context failed (${r.status})`);
      const ctx = (await r.json()) as ContextDigest;
      if (flags.json) process.stdout.write(JSON.stringify(ctx, null, 2) + "\n");
      else printContextHuman(ctx);
      return;
    }

    case "status": {
      const state = readState();
      if (!state || !(await ping(state.port))) {
        log(dim(`${G.off} not running`));
        process.exit(1);
      }
      const r = await fetch(`http://127.0.0.1:${state.port}/api/status`);
      process.stdout.write(JSON.stringify(await r.json(), null, 2) + "\n");
      return;
    }

    case "stop": {
      const state = readState();
      if (state) {
        try {
          await fetch(`http://127.0.0.1:${state.port}/api/shutdown`, { method: "POST" });
        } catch {
          try {
            process.kill(state.pid);
          } catch {
            /* already gone */
          }
        }
        rmSync(STATE_FILE, { force: true });
      }
      log(`${ok(G.ok)} stopped`);
      return;
    }

    default:
      log(`${warn(":: ·")}  ${bold("marigold-draft")} — local Marigold review loop for agent-authored HTML/SVG

  open <file>      open a draft in the browser and wait for feedback
                   --json         print the feedback payload as JSON (stdout)
                   --no-browser   don't open a tab (it live-reloads anyway)
                   --no-wait      register + open, return immediately
                   --timeout <s>  give up waiting after s seconds
                   --title <t>    set the doc title
  listen [path…]   stream submitted review rounds as JSON lines; path args
                   (draft files and/or directories) scope the stream to those
                   drafts — ALWAYS scope when parallel agent sessions may be
                   listening, or every session wakes on every doc's feedback.
                   No paths = all drafts. Reconnects forever — run under a
                   persistent monitor/supervisor
  share <file>     publish the draft to hosted Marigold (no account needed) and
                   print a share link (anyone with it can view + comment) and a
                   claim link (sign in to keep it and control access)
                   --title <t>    title (defaults to the file's <title> or name)
                   --origin <url> hosted origin (default marigold.page,
                                  or set MARIGOLD_ORIGIN)
  comments <file>  list comments   [--json]
  context <file>   digest for catching up on a draft: open comments, recent
                   changes, and correction pairs (resolved comment → the change
                   that addressed it)   [--json]
  note <file> "…"  record the intent (the "why") for the next save — attached
                   to the change entry the next edit produces
  reply <file> <id> <text…>   reply to a comment (badged AI)
  resolve|reopen <file> <id>  set a comment's status
  start | status | stop       manage the background server
  principles [mode] [topic…]  print the Marigold authoring methodology + mode posture pack
                              modes: analyze|learn|judge|decide|organize|tune|do|track
  mcp                         stdio MCP server (for Claude Desktop and other chat clients)
  agent-setup                 wire up every assistant on this machine, globally (all
                              projects): Claude Code skill + ~/.claude/CLAUDE.md block,
                              Claude Desktop MCP, and the review-loop block in detected
                              agents' global rules (~/.codex/AGENTS.md, opencode
                              AGENTS.md, ~/.gemini/GEMINI.md)
                              --no-claude-md   skip the ~/.claude/CLAUDE.md block
                              --no-agents-md   skip other agents' global rules files`);
      if (cmd !== "help") process.exit(1);
  }
}

main().catch((e: Error) => {
  log(`${err(G.err)} ${e.message}`);
  process.exit(1);
});
