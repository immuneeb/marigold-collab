/**
 * marigold-local — a warm local daemon for the agent↔human review loop on
 * rich HTML/SVG drafts. One background server reused across opens (state in
 * ~/.marigold-local/server.json); `open --json` blocks until the reviewer hits
 * "Send feedback to agent" and prints the feedback JSON to stdout.
 *
 *   marigold-local open <file> [--title T] [--json] [--no-browser] [--no-wait] [--timeout <s>]
 *   marigold-local comments <file> [--json]
 *   marigold-local reply <file> <commentId> <text…>
 *   marigold-local resolve|reopen <file> <commentId>
 *   marigold-local start [--port N] | status | stop
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { LocalServer, type ReviewPayload } from "./server";

const STATE_DIR = join(homedir(), ".marigold-local");
const STATE_FILE = join(STATE_DIR, "server.json");
const DEFAULT_PORT = Number(process.env.MARIGOLD_LOCAL_PORT ?? 4747);

interface ServerState {
  port: number;
  pid: number;
  startedAt: string;
}

function log(msg: string): void {
  // stderr, so `--json` stdout stays machine-clean
  process.stderr.write(msg + "\n");
}

function parseArgs(argv: string[]): { cmd: string; positional: string[]; flags: Record<string, string | boolean> } {
  const [cmd = "help", ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith("--")) {
      const name = a.slice(2);
      const next = rest[i + 1];
      if (["title", "timeout", "port"].includes(name) && next !== undefined && !next.startsWith("--")) {
        flags[name] = next;
        i++;
      } else flags[name] = true;
    } else positional.push(a);
  }
  return { cmd, positional, flags };
}

function readState(): ServerState | null {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as ServerState;
  } catch {
    return null;
  }
}

async function ping(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(700) });
    return r.ok;
  } catch {
    return false;
  }
}

async function ensureServer(preferredPort?: number): Promise<number> {
  const state = readState();
  if (state && (await ping(state.port))) return state.port;

  const port = preferredPort ?? DEFAULT_PORT;
  const child = spawn(process.execPath, [process.argv[1]!, "serve", "--port", String(port)], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 150));
    const s = readState();
    if (s && s.pid === child.pid && (await ping(s.port))) return s.port;
  }
  throw new Error("could not start the marigold-local server (try `marigold-local serve` for logs)");
}

async function serve(flags: Record<string, string | boolean>): Promise<void> {
  const server = new LocalServer({ allowShutdown: true });
  const port = await server.listen(Number(flags.port ?? DEFAULT_PORT));
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify({ port, pid: process.pid, startedAt: server.startedAt } satisfies ServerState, null, 2));
  log(`marigold-local serving on http://127.0.0.1:${port} (pid ${process.pid})`);
  const bye = () => {
    const s = readState();
    if (s?.pid === process.pid) rmSync(STATE_FILE, { force: true });
    process.exit(0);
  };
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* URL is printed anyway */
  }
}

interface OpenResult {
  docId: string;
  url: string;
  version: number;
  reviewSeq: number;
  connectedClients: number;
}

async function registerDoc(port: number, file: string, title?: string): Promise<OpenResult> {
  const r = await fetch(`http://127.0.0.1:${port}/api/open`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: resolvePath(file), title }),
  });
  const data = (await r.json()) as OpenResult & { error?: string };
  if (!r.ok) throw new Error(data.error ?? `open failed (${r.status})`);
  return data;
}

function printReviewHuman(p: ReviewPayload): void {
  log(`\nFeedback received on ${p.file} (v${p.version}):`);
  if (p.overallComment) log(`  Overall: ${p.overallComment}`);
  for (const c of p.openComments) {
    log(`  [${c.id}] ${c.author}${c.anchoredText ? ` on “${c.anchoredText.slice(0, 60)}”` : ""}: ${c.body}`);
    for (const r of c.replies) log(`      ↳ ${r.author}: ${r.body}`);
  }
  if (!p.openComments.length && !p.overallComment) log("  (no open comments — reviewer just signed off)");
}

async function open(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const file = positional[0];
  if (!file) throw new Error("usage: marigold-local open <file.html> [--json] [--no-browser] [--no-wait] [--timeout <s>]");
  const port = await ensureServer(flags.port ? Number(flags.port) : undefined);
  const doc = await registerDoc(port, file, typeof flags.title === "string" ? flags.title : undefined);
  log(`${doc.url}  (v${doc.version})`);

  // A connected tab live-reloads on file changes — don't stack up new tabs.
  if (!flags["no-browser"] && doc.connectedClients === 0) openBrowser(doc.url);
  if (flags["no-wait"]) return;

  const budgetS = flags.timeout ? Number(flags.timeout) : Infinity;
  const deadline = Date.now() + budgetS * 1000;
  log("Waiting for the reviewer to send feedback… (Ctrl-C to stop waiting)");
  let since = doc.reviewSeq;
  for (;;) {
    const remaining = (deadline - Date.now()) / 1000;
    if (remaining <= 0) {
      log("Timed out waiting for feedback.");
      process.exit(2);
    }
    const chunk = Math.min(25, Math.ceil(remaining));
    let r: Response;
    try {
      r = await fetch(`http://127.0.0.1:${port}/api/docs/${doc.docId}/wait?timeout=${chunk}&since=${since}`);
    } catch {
      throw new Error("lost connection to the marigold-local server");
    }
    if (r.status === 204) continue;
    if (!r.ok) throw new Error(`wait failed (${r.status})`);
    const payload = (await r.json()) as ReviewPayload;
    since = payload.reviewSeq;
    if (flags.json) process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    else printReviewHuman(payload);
    return;
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

    case "start": {
      const port = await ensureServer(flags.port ? Number(flags.port) : undefined);
      log(`marigold-local running on http://127.0.0.1:${port}`);
      return;
    }

    case "open":
      await open(positional, flags);
      return;

    case "comments": {
      const { port, doc } = await withDoc(positional[0], flags);
      const r = await fetch(`http://127.0.0.1:${port}/api/docs/${doc.docId}`);
      const data = (await r.json()) as { comments: unknown[] };
      if (flags.json) process.stdout.write(JSON.stringify(data.comments, null, 2) + "\n");
      else {
        const cs = data.comments as { id: string; parentId: string | null; author: string; body: string; status: string }[];
        for (const c of cs.filter((c) => !c.parentId)) {
          log(`[${c.id}] (${c.status}) ${c.author}: ${c.body}`);
          for (const rp of cs.filter((x) => x.parentId === c.id)) log(`    ↳ ${rp.author}: ${rp.body}`);
        }
        if (!cs.length) log("no comments yet");
      }
      return;
    }

    case "reply": {
      const [file, commentId, ...words] = positional;
      const body = words.join(" ");
      if (!commentId || !body) throw new Error("usage: marigold-local reply <file> <commentId> <text…>");
      const { port, doc } = await withDoc(file, flags);
      const r = await fetch(`http://127.0.0.1:${port}/api/docs/${doc.docId}/comments/${commentId}/replies`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body, viaAssistant: true, author: "AI" }),
      });
      if (!r.ok) throw new Error(`reply failed (${r.status})`);
      log(`replied to ${commentId}`);
      return;
    }

    case "resolve":
    case "reopen": {
      const [file, commentId] = positional;
      if (!commentId) throw new Error(`usage: marigold-local ${cmd} <file> <commentId>`);
      const { port, doc } = await withDoc(file, flags);
      const r = await fetch(`http://127.0.0.1:${port}/api/docs/${doc.docId}/comments/${commentId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: cmd === "resolve" ? "resolved" : "open" }),
      });
      if (!r.ok) throw new Error(`${cmd} failed (${r.status})`);
      log(`${cmd}d ${commentId}`);
      return;
    }

    case "status": {
      const state = readState();
      if (!state || !(await ping(state.port))) {
        log("not running");
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
      log("stopped");
      return;
    }

    default:
      log(`marigold-local — local Marigold review loop for agent-authored HTML/SVG

  open <file>      open a draft in the browser and wait for feedback
                   --json         print the feedback payload as JSON (stdout)
                   --no-browser   don't open a tab (it live-reloads anyway)
                   --no-wait      register + open, return immediately
                   --timeout <s>  give up waiting after s seconds
                   --title <t>    set the doc title
  comments <file>  list comments   [--json]
  reply <file> <id> <text…>   reply to a comment (badged AI)
  resolve|reopen <file> <id>  set a comment's status
  start | status | stop       manage the background server`);
      if (cmd !== "help") process.exit(1);
  }
}

main().catch((e: Error) => {
  log(`error: ${e.message}`);
  process.exit(1);
});
