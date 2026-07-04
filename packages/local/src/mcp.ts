/**
 * `marigold-local mcp` — a stdio MCP server so chat clients without shell
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

const DIGEST = `marigold-local: a localhost review loop for rich HTML/SVG drafts.
Workflow: create_draft (or open_draft on an existing file) → the doc opens in
the user's browser → get_feedback with waitSeconds to block until they hit
"Send feedback to agent" → revise with update_draft (the tab live-reloads,
comments re-anchor) → reply_to_comment + resolve_comment → get_feedback again
for the next round. Drafts are plain HTML: full documents or fragments (and
.svg), self-contained (external network is blocked by CSP, matching cloud
Marigold).`;

export async function runMcp(): Promise<void> {
  const server = new McpServer(
    { name: "marigold-local", version: "0.1.0" },
    { instructions: DIGEST },
  );

  server.registerTool(
    "create_draft",
    {
      title: "Create draft",
      description:
        "Write a new HTML/SVG draft to disk and open it in the user's browser for review. Returns the file path — pass it to every other tool. Use update_draft for revisions.",
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
      description: "Open an existing .html/.htm/.svg file in the review shell (starts the daemon if needed).",
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
        "Replace the draft's content with revised HTML. The open tab live-reloads and existing comments re-anchor (keep the DOM structure stable where you can).",
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
        "Read the draft's comments. With waitSeconds > 0, blocks until the reviewer clicks \"Send feedback to agent\" (or the wait times out) and returns the review round — use this after creating/updating a draft to wait for the human.",
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
        let since = doc.reviewSeq;
        for (;;) {
          const remaining = Math.ceil((deadline - Date.now()) / 1000);
          if (remaining <= 0) return ok({ path, timedOut: true, hint: "No review round arrived — call get_feedback again to keep waiting." });
          const chunk = Math.min(25, remaining);
          const r = await fetch(
            `http://127.0.0.1:${port}/api/docs/${doc.docId}/wait?timeout=${chunk}&since=${since}`,
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
      description: "Reply to a comment thread (badged AI in the shell). Say what you changed before resolving.",
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
      description: "Mark a comment thread resolved (or reopen it).",
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
          body: JSON.stringify({ status: reopen ? "open" : "resolved" }),
        });
        if (!r.ok) return fail(`update failed (${r.status})`);
        return ok({ [reopen ? "reopened" : "resolved"]: commentId });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    "read_draft",
    {
      title: "Read draft",
      description: "Read the draft's current HTML source from disk (e.g. before an update_draft revision).",
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

  await server.connect(new StdioServerTransport());
}
