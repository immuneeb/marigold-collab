/**
 * `marigold-draft mcp` — a stdio MCP server so chat clients without shell
 * access (Claude Desktop) can drive the local review loop: author a draft,
 * open it in the user's browser, block for feedback, revise, reply, resolve.
 * Every tool talks HTTP to the (auto-started) background daemon; the daemon
 * remains the single source of truth.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { buildStartAnalysisText } from "@marigold/core/principles";
import { ensureServer, openBrowser, registerDoc, STATE_DIR } from "./client";

const DRAFTS_DIR = join(STATE_DIR, "drafts");

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}
function fail(message: string) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }], isError: true };
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "draft"
  );
}

async function open(file: string, title?: string, browser = true) {
  const port = await ensureServer();
  const doc = await registerDoc(port, file, title);
  if (browser && doc.connectedClients === 0) openBrowser(doc.url);
  return { port, doc };
}

const DIGEST = `marigold-draft: a localhost review loop for rich HTML/SVG drafts.
Workflow: create_draft (or open_draft on an existing file) → the draft opens in
the reviewer's browser → get_feedback with waitSeconds to block until they hit
"Send feedback to agent" → revise with update_draft (the reviewer's tab
live-reloads, comments re-anchor) → reply_to_comment + resolve_comment →
get_feedback again for the next round. resolve_comment only PROPOSES a
resolution — the reviewer confirms it (or reopens if the fix missed) in the
shell. note_intent records the "why" for the next save; get_history and
get_context replay what changed and lay out each thread as an EPISODE — its
full comment chain, every attempt, and where it landed. Read the whole chain
before judging: a reopen may be a follow-up refinement, not a rejection. At a
round's close, distill durable cross-draft learnings with save_insight — but
first reaffirm/refine/contradict a matching existing insight rather than
spawning a near-duplicate; get_context lists current insights (stale ones
first — staleness = fresh reviewer activity on a cited thread) then
unsynthesized episodes, and get_insight expands one insight with its evidence
episodes. Drafts are plain HTML: full documents or
fragments (and .svg), self-contained (external network is blocked by CSP,
matching cloud Marigold). Before authoring, call start_analysis (pass mode:
analyze | learn | judge | decide | organize | tune | do | track — pick by what
the session must produce) and follow the returned methodology + posture pack.`;

export async function runMcp(): Promise<void> {
  const server = new McpServer(
    { name: "marigold-draft", version: "0.1.0" },
    { instructions: DIGEST },
  );

  server.registerTool(
    "start_analysis",
    {
      title: "Start a Marigold analysis",
      description:
        "load the Marigold Way before authoring a draft — the first-principles method, doc structure guide, and a mode posture pack for what the session must produce. Call this first when asked to analyze, explain, teach, or build an interactive draft, then follow the returned method.",
      inputSchema: {
        topic: z.string().optional().describe("The topic, if known"),
        mode: z
          .enum(["analyze", "learn", "judge", "decide", "organize", "tune", "do", "track"])
          .optional()
          .describe(
            "What the session must produce: analyze = first-principles breakdown (default); learn = a retained mental model; judge = verdicts on existing work; decide = a selection + rationale; organize = an arrangement of items; tune = parameter values; do = a completed procedure; track = an updated picture",
          ),
      },
    },
    async ({ topic, mode }) => ({
      content: [{ type: "text" as const, text: buildStartAnalysisText(topic, mode) }],
    }),
  );

  server.registerTool(
    "create_draft",
    {
      title: "Create draft",
      description:
        "write a new HTML/SVG draft to disk and open it in the reviewer's browser. Returns the file path — pass it to every other tool. Use update_draft for revisions.",
      inputSchema: {
        html: z.string().describe("Full HTML document, fragment, or SVG markup"),
        title: z.string().optional().describe("Doc title (also names the file)"),
        name: z.string().optional().describe("File name without extension (defaults to the title)"),
      },
    },
    async ({ html, title, name }) => {
      try {
        mkdirSync(DRAFTS_DIR, { recursive: true });
        const base = slug(name ?? title ?? `draft-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}`);
        const file = join(DRAFTS_DIR, `${base}.html`);
        writeFileSync(file, html);
        const { doc } = await open(file, title);
        return ok({ path: file, url: doc.url, docId: doc.docId, version: doc.version, reviewSeq: doc.reviewSeq });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    "open_draft",
    {
      title: "Open draft",
      description: "open an existing .html/.htm/.svg draft in the review shell (starts the daemon if needed).",
      inputSchema: {
        path: z.string().describe("Path to the file"),
        title: z.string().optional(),
      },
    },
    async ({ path, title }) => {
      try {
        const { doc } = await open(path, title);
        return ok({ path, url: doc.url, docId: doc.docId, version: doc.version, reviewSeq: doc.reviewSeq });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    "update_draft",
    {
      title: "Update draft",
      description:
        "replace the draft's content with revised HTML. The reviewer's open tab live-reloads and existing comments re-anchor (keep the DOM structure stable where you can).",
      inputSchema: {
        path: z.string(),
        html: z.string(),
      },
    },
    async ({ path, html }) => {
      try {
        const { port, doc } = await open(path, undefined, false);
        writeFileSync(path, html);
        await new Promise((r) => setTimeout(r, 400)); // let the watcher pick it up
        const d = (await (await fetch(`http://127.0.0.1:${port}/api/docs/${doc.docId}`)).json()) as {
          version: number;
        };
        return ok({ path, version: d.version });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    "get_feedback",
    {
      title: "Get feedback",
      description:
        "read the draft's comments. With waitSeconds > 0, wait for the reviewer to send feedback (or time out) and return the review round — use this after creating or updating a draft to wait for the reviewer.",
      inputSchema: {
        path: z.string(),
        waitSeconds: z
          .number()
          .optional()
          .describe("How long to block for the next review round; 0/omitted = return current comments now"),
      },
    },
    async ({ path, waitSeconds }) => {
      try {
        const { port, doc } = await open(path, undefined, false);
        if (!waitSeconds || waitSeconds <= 0) {
          const d = (await (await fetch(`http://127.0.0.1:${port}/api/docs/${doc.docId}`)).json()) as {
            version: number;
            comments: unknown[];
          };
          return ok({ path, version: d.version, comments: d.comments });
        }
        const deadline = Date.now() + waitSeconds * 1000;
        for (;;) {
          const remaining = Math.ceil((deadline - Date.now()) / 1000);
          if (remaining <= 0) return ok({ path, timedOut: true, hint: "No review round arrived — call get_feedback again to keep waiting." });
          const chunk = Math.min(25, remaining);
          const r = await fetch(
            `http://127.0.0.1:${port}/api/docs/${doc.docId}/wait?timeout=${chunk}`,
          );
          if (r.status === 204) continue;
          if (!r.ok) return fail(`wait failed (${r.status})`);
          return ok(await r.json());
        }
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    "reply_to_comment",
    {
      title: "Reply to comment",
      description: "reply in a comment thread — shown with the AI badge. Say what you changed before resolving.",
      inputSchema: {
        path: z.string(),
        commentId: z.string(),
        body: z.string(),
      },
    },
    async ({ path, commentId, body }) => {
      try {
        const { port, doc } = await open(path, undefined, false);
        const r = await fetch(`http://127.0.0.1:${port}/api/docs/${doc.docId}/comments/${commentId}/replies`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body, viaAssistant: true, author: "AI" }),
        });
        if (!r.ok) return fail(`reply failed (${r.status})`);
        return ok({ replied: commentId });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    "resolve_comment",
    {
      title: "Resolve comment",
      description:
        "propose a comment thread resolved, or reopen it. Resolving is a PROPOSAL — the reviewer confirms it (or reopens it if the fix missed) in the shell; it is not final until they do. Reply first with what you changed.",
      inputSchema: {
        path: z.string(),
        commentId: z.string(),
        reopen: z.boolean().optional(),
      },
    },
    async ({ path, commentId, reopen }) => {
      try {
        const { port, doc } = await open(path, undefined, false);
        const r = await fetch(`http://127.0.0.1:${port}/api/docs/${doc.docId}/comments/${commentId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: reopen ? "open" : "resolved", source: "agent" }),
        });
        if (!r.ok) return fail(`update failed (${r.status})`);
        return ok(
          reopen
            ? { reopened: commentId }
            : { proposed: commentId, note: "proposed resolved — the reviewer confirms in the shell" },
        );
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    "read_draft",
    {
      title: "Read draft",
      description: "read the draft's current HTML source from disk (e.g. before an update_draft revision).",
      inputSchema: { path: z.string() },
    },
    async ({ path }) => {
      try {
        return ok({ path, html: readFileSync(path, "utf8") });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    "note_intent",
    {
      title: "Note intent",
      description:
        "record the intent — the \"why\" — for the draft's next save. The next edit's change entry carries it, so the history reads as decisions, not just diffs.",
      inputSchema: {
        path: z.string(),
        intent: z.string().describe("One line: why the next edit is being made"),
      },
    },
    async ({ path, intent }) => {
      try {
        const { port, doc } = await open(path, undefined, false);
        const r = await fetch(`http://127.0.0.1:${port}/api/docs/${doc.docId}/note`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ intent }),
        });
        if (!r.ok) return fail(`note failed (${r.status})`);
        return ok(await r.json());
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    "get_history",
    {
      title: "Get history",
      description:
        "list the draft's recent changes, most recent first — each with its version, actor, intent, diff stats, and a few changed/added/removed element summaries.",
      inputSchema: {
        path: z.string(),
        limit: z.number().optional().describe("How many recent changes to return (default 50, max 200)"),
      },
    },
    async ({ path, limit }) => {
      try {
        const { port, doc } = await open(path, undefined, false);
        const qs = limit ? `?limit=${Math.trunc(limit)}` : "";
        const r = await fetch(`http://127.0.0.1:${port}/api/docs/${doc.docId}/history${qs}`);
        if (!r.ok) return fail(`history failed (${r.status})`);
        return ok(await r.json());
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    "get_context",
    {
      title: "Get context",
      description:
        "get the draft's catch-up digest: durable insights FIRST (owner-level learnings across all drafts, stale ones first — an insight goes stale when a cited thread gets fresh REVIEWER activity; reaffirm/refine before creating a near-duplicate), then the open comments, the recent changes, and this draft's unsynthesized episodes (each thread's full comment chain, every attempt, and where it landed — read the whole chain, a reopen may be a follow-up, not a rejection).",
      inputSchema: { path: z.string() },
    },
    async ({ path }) => {
      try {
        const { port, doc } = await open(path, undefined, false);
        const r = await fetch(`http://127.0.0.1:${port}/api/docs/${doc.docId}/context`);
        if (!r.ok) return fail(`context failed (${r.status})`);
        return ok(await r.json());
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    "save_insight",
    {
      title: "Save insight",
      description:
        "record a durable, cross-draft learning distilled from review episodes — owner-level, not per-draft. Evidence is mandatory: cite the {docId, commentId} threads it came from. Statements are capped at 140 characters. relation: \"new\" creates; \"reinforces\"/\"refines\"/\"contradicts\" update the insight named by `updates`. Creating (or refining into a) statement close to an existing ACTIVE insight is refused with `{saved:false, needsDistinction:true, candidates:[{id,statement}], hint}` — reaffirm one (updates + relation:\"reinforces\"), refine it (relation:\"refines\" + a new statement, which supersedes the old), contradict it (relation:\"contradicts\" — flags it, keeps it), or resend with distinctFrom listing those candidate ids. On success: `{saved:true, insight:{id,statement,status,relation,evidenceCount,updatedAt}, supersededId?}`. Distill at a review round's close.",
      inputSchema: {
        statement: z.string().optional().describe("The learning, one sentence (≤140 chars). Required for new + refines."),
        evidence: z
          .array(
            z.object({
              docId: z.string(),
              commentId: z.string(),
              relation: z.enum(["supports", "refines", "contradicts"]).optional(),
            }),
          )
          .describe("≥1 {docId, commentId} pairs that name real comments in a draft"),
        updates: z.string().optional().describe("The existing insight this reinforces/refines/contradicts"),
        relation: z
          .enum(["new", "reinforces", "refines", "contradicts"])
          .optional()
          .describe("new = create; reinforces = add evidence to `updates`; refines = new insight supersedes `updates`; contradicts = flag `updates` false"),
        distinctFrom: z
          .array(z.string())
          .optional()
          .describe("ids of similar active insights you've decided are genuinely distinct — clears the forced choice (new + refines)"),
        createdByLabel: z.string().optional(),
      },
    },
    async ({ statement, evidence, updates, relation, distinctFrom, createdByLabel }) => {
      try {
        const port = await ensureServer();
        const r = await fetch(`http://127.0.0.1:${port}/api/insights`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ statement, evidence, updates, relation, distinctFrom, createdByLabel }),
        });
        const data = await r.json();
        if (!r.ok && r.status >= 500) return fail(`save_insight failed (${r.status})`);
        return ok(data); // {saved:true,…} | {saved:false, needsDistinction, candidates, hint} | {saved:false, error}
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    "get_insight",
    {
      title: "Get insight",
      description:
        "expand one insight by id: its statement, status, evidence links, and the full review episode behind each cited comment (chain + attempts + outcome).",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      try {
        const port = await ensureServer();
        const r = await fetch(`http://127.0.0.1:${port}/api/insights/${id}`);
        if (!r.ok) return fail(`get_insight failed (${r.status})`);
        return ok(await r.json());
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  await server.connect(new StdioServerTransport());
}
