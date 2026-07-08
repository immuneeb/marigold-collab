import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { z } from "zod";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import {
  applyPatchOps,
  authorize,
  buildAddressFeedbackPrompt,
  buildAnalyzePrompt,
  buildLearnPrompt,
  buildStartAnalysisText,
  createDoc,
  deinstrumentHtml,
  deleteDoc,
  type DocEvent,
  getBlobStore,
  IngestError,
  listThemes,
  MARIGOLD_DIGEST,
  type PatchOp,
  PatchError,
  renderOriginFor,
  roleCan,
  StaleVersionError,
  ThemeError,
  updateDoc,
  waitForEvents,
} from "@marigold/core";
import { comments, db, docs } from "@marigold/db";
import { actorForUserId } from "@/lib/actor";
import {
  getComment,
  listComments,
  replyToComment,
  setCommentStatus,
} from "@/lib/comments";
import { emitDocEvent } from "@/lib/events";
import { sendInvite } from "@/lib/invite";
import { verifyAccessToken } from "@/lib/oauth/tokens";
import { upsertShare } from "@/lib/shares";

export const runtime = "nodejs";
// get_feedback blocks up to ~50s — lift the default serverless cap.
export const maxDuration = 60;

interface ToolExtra {
  authInfo?: { extra?: Record<string, unknown> };
}
function userIdOf(extra: ToolExtra): string | undefined {
  const v = extra?.authInfo?.extra?.userId;
  return typeof v === "string" ? v : undefined;
}

function ok(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj) }] };
}
function fail(message: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

// Resolve comment bodies for comment.* events so get_feedback returns the
// actual feedback text (not just an id the agent would have to fetch). Fetch
// only the referenced comments, so cost scales with new events not total
// comment count.
async function enrichEvents(
  docId: string,
  events: DocEvent[],
): Promise<unknown[]> {
  const ids = [
    ...new Set(
      events
        .filter((e) => e.type.startsWith("comment."))
        .map((e) =>
          typeof e.payload?.commentId === "string" ? e.payload.commentId : null,
        )
        .filter((v): v is string => v !== null),
    ),
  ];
  const byId = new Map(
    ids.length ? (await listComments(docId, { ids })).map((c) => [c.id, c]) : [],
  );
  return events.map((e) => {
    const commentId =
      typeof e.payload?.commentId === "string" ? e.payload.commentId : null;
    const c = commentId ? byId.get(commentId) : undefined;
    const base = {
      seq: e.seq,
      type: e.type,
      actor: e.actor,
      at: e.createdAt,
      payload: e.payload,
    };
    if (!c) return base;
    const a = (c.anchor ?? {}) as { textQuote?: { exact?: string } };
    return {
      ...base,
      comment: {
        id: c.id,
        author: c.authorName ?? "someone",
        body: c.body,
        status: c.status,
        assignedToAi: c.assignedToAi,
        byAi: c.viaAssistant,
        anchoredText: a.textQuote?.exact ?? null,
      },
    };
  });
}

async function currentHtmlOf(
  latestVersionId: string | null,
  keepIds = false,
): Promise<string | null> {
  if (!latestVersionId) return null;
  const store = getBlobStore();
  const manifest = await store.getManifest(latestVersionId);
  const sha = manifest?.["index.html"];
  if (!sha) return null;
  const bytes = await store.getBlob(sha);
  if (!bytes) return null;
  const raw = new TextDecoder().decode(bytes);
  // keepIds: return the instrumented HTML so an agent can see each element's
  // data-marigold-id and target it with patch_doc. Default strips ids + agent.
  return keepIds ? raw : deinstrumentHtml(raw);
}

// Built-in theme ids, for the create_doc description (kept in sync with the
// core registry so the tool always advertises what actually exists).
const THEME_IDS = listThemes()
  .map((t) => t.id)
  .join(", ");

const baseHandler = createMcpHandler(
  (server) => {
    // The Marigold Way — methodology surface. Prompts for clients that
    // support them (Claude surfaces these as slash commands); the
    // start_analysis tool for clients that only speak tools (ChatGPT).
    server.registerPrompt(
      "analyze",
      {
        title: "Marigold: analyze",
        description:
          "Analyze a concept, system, or decision the Marigold Way — first-principles decomposition, answer-first structure, load-bearing diagrams, three reading depths.",
        argsSchema: {
          topic: z.string().describe("The concept, system, question, or decision to analyze"),
          audience: z
            .string()
            .optional()
            .describe("Who this is for (default: a sharp generalist new to the domain)"),
        },
      },
      ({ topic, audience }) => ({
        messages: [
          {
            role: "user" as const,
            content: { type: "text" as const, text: buildAnalyzePrompt(topic, audience) },
          },
        ],
      }),
    );

    server.registerPrompt(
      "learn",
      {
        title: "Marigold: learn",
        description:
          "Learn a topic the Marigold Way — same first-principles rigor, taught progressively: one new primitive at a time, in dependency order.",
        argsSchema: {
          topic: z.string().describe("The topic to learn"),
          audience: z
            .string()
            .optional()
            .describe("Who is learning (default: a sharp generalist new to the domain)"),
        },
      },
      ({ topic, audience }) => ({
        messages: [
          {
            role: "user" as const,
            content: { type: "text" as const, text: buildLearnPrompt(topic, audience) },
          },
        ],
      }),
    );

    server.registerPrompt(
      "address_feedback",
      {
        title: "Marigold: address AI-assigned comments",
        description:
          "Work through the comments editors have assigned to AI (✨): fetch them, make the edits, reply with what changed, and resolve.",
        argsSchema: {
          doc: z
            .string()
            .optional()
            .describe("A specific doc (title, slug, or id); omit to sweep all docs"),
        },
      },
      ({ doc }) => ({
        messages: [
          {
            role: "user" as const,
            content: { type: "text" as const, text: buildAddressFeedbackPrompt(doc) },
          },
        ],
      }),
    );

    server.registerTool(
      "start_analysis",
      {
        title: "Start a Marigold analysis",
        description:
          'Load the Marigold Way — the methodology for analyzing or teaching a topic from first principles. Call this FIRST when the user asks Marigold to analyze, explain, or teach something (e.g. "marigold analyze X", "/marigold learn Y"), then follow the returned method for the rest of the conversation.',
        inputSchema: {
          topic: z.string().optional().describe("The topic to analyze or learn, if known"),
          mode: z
            .enum(["analyze", "learn"])
            .optional()
            .describe("analyze = first-principles breakdown; learn = progressive teaching"),
        },
      },
      async ({ topic, mode }) => ({
        content: [
          { type: "text" as const, text: buildStartAnalysisText(topic, mode) },
        ],
      }),
    );

    server.registerTool(
      "create_doc",
      {
        title: "Create doc",
        description:
          "Create a new Marigold doc and return its URL. Two ways to author: (1) full-control — pass `html`, one self-contained page (inline all CSS/JS/SVG, data: URIs for images; external scripts, fonts, and images are blocked by CSP and fail silently). (2) themed — pass a `theme` id plus `content` (the body's inner HTML: your semantic <h1>/<p>/<table>/<svg>… with NO <style> or page scaffold), and the server wraps it in the theme's stylesheet into a self-contained page. Themed docs can be updated content-only (send `content`, not `html`) and raise the quality floor. Valid theme ids: " +
          THEME_IDS +
          ". Lead with the core insight and carry the structure in a diagram (call start_analysis for the full authoring guide). After you share the returned URL, call get_feedback(docId) to WATCH for the reader's response and act on it in the same session — otherwise no one is listening and their comment just waits.",
        inputSchema: {
          title: z.string().optional(),
          html: z
            .string()
            .optional()
            .describe("Full self-contained HTML page. Omit when using theme + content."),
          theme: z
            .string()
            .optional()
            .describe(`Built-in theme id to wrap content in. One of: ${THEME_IDS}.`),
          content: z
            .string()
            .optional()
            .describe("Body inner HTML (semantic content only) — wrapped by `theme`."),
        },
      },
      async ({ title, html, theme, content }, extra: ToolExtra) => {
        const userId = userIdOf(extra);
        if (!userId) return fail("unauthenticated");
        try {
          const r = await createDoc({ ownerId: userId, title, html, theme, content, assistant: "mcp" });
          // Feedback feed: the doc's first version is saved (feed genesis event).
          await emitDocEvent({
            docId: r.docId,
            type: "version.saved",
            actor: userId,
            payload: { versionId: r.versionId, ordinal: r.ordinal },
          });
          return ok({
            docId: r.docId,
            slug: r.slug,
            url: r.url,
            versionId: r.versionId,
            ordinal: r.ordinal,
            theme: r.theme ?? null,
            themeVersion: r.themeVersion ?? null,
            watch: `Share ${r.url}, then call get_feedback({docId: "${r.docId}"}) to wait for the reader's first comment and respond in this session.`,
          });
        } catch (e) {
          if (e instanceof ThemeError) return fail(e.message);
          if (e instanceof IngestError) return fail(e.message);
          throw e;
        }
      },
    );

    server.registerTool(
      "update_doc",
      {
        title: "Update doc",
        description:
          "Replace a doc's content in place (same URL). No-op if unchanged. Keep the DOM structure stable — comments anchor to elements, so edit content in place; reordering or re-nesting sections orphans readers' comments. If the doc is themed (get_doc / list_docs report its `theme`), send `content` (body inner HTML only) and the server re-wraps it in the pinned theme; sending `html` full-replaces the whole page instead.",
        inputSchema: {
          docId: z.string(),
          html: z
            .string()
            .optional()
            .describe("Full self-contained HTML page (full replace). Omit to send themed content."),
          content: z
            .string()
            .optional()
            .describe("Body inner HTML — re-wrapped in the doc's pinned theme (themed docs only)."),
          title: z.string().optional(),
        },
      },
      async ({ docId, html, content, title }, extra: ToolExtra) => {
        const userId = userIdOf(extra);
        if (!userId) return fail("unauthenticated");
        const actor = await actorForUserId(userId);
        const { ok: allowed } = await authorize(docId, actor, "update");
        if (!allowed) return fail("not authorized to update this doc");
        try {
          const r = await updateDoc({ docId, html, content, title, assistant: "mcp" });
          // Feedback feed: content was replaced (skip no-op writes).
          if (!r.unchanged)
            await emitDocEvent({
              docId,
              type: "content.replaced",
              actor: userId,
              payload: { versionId: r.versionId, ordinal: r.ordinal },
            });
          return ok({
            docId: r.docId,
            slug: r.slug,
            url: r.url,
            versionId: r.versionId,
            ordinal: r.ordinal,
            unchanged: r.unchanged,
            theme: r.theme ?? null,
            themeVersion: r.themeVersion ?? null,
          });
        } catch (e) {
          if (e instanceof ThemeError) return fail(e.message);
          if (e instanceof IngestError) return fail(e.message);
          throw e;
        }
      },
    );

    server.registerTool(
      "list_docs",
      {
        title: "List docs",
        description:
          "List the docs you own. openAiComments counts unresolved comments editors have assigned to AI — if it's > 0, that doc has feedback waiting for you (get_comments with assignedToAi: true).",
        inputSchema: {},
      },
      async (_args, extra: ToolExtra) => {
        const userId = userIdOf(extra);
        if (!userId) return fail("unauthenticated");
        const rows = await db
          .select({
            docId: docs.id,
            slug: docs.slug,
            title: docs.title,
            url: docs.slug,
            public: docs.isPublic,
            theme: docs.theme,
            themeVersion: docs.themeVersion,
            createdAt: docs.createdAt,
          })
          .from(docs)
          .where(eq(docs.ownerId, userId))
          .orderBy(desc(docs.createdAt));
        const counts = await db
          .select({ docId: comments.docId, n: sql<number>`count(*)::int` })
          .from(comments)
          .innerJoin(docs, eq(comments.docId, docs.id))
          .where(
            and(
              eq(docs.ownerId, userId),
              eq(comments.assignedToAi, true),
              ne(comments.status, "resolved"),
            ),
          )
          .groupBy(comments.docId);
        const aiByDoc = new Map(counts.map((c) => [c.docId, c.n]));
        return ok({
          docs: rows.map((r) => ({
            ...r,
            url: `/d/${r.slug}`,
            openAiComments: aiByDoc.get(r.docId) ?? 0,
          })),
        });
      },
    );

    server.registerTool(
      "get_doc",
      {
        title: "Get doc",
        description:
          "Read a doc's metadata, URL, and current HTML. Pass includeIds:true to get the HTML with each element's data-marigold-id intact — you need those ids to target elements with patch_doc.",
        inputSchema: {
          docId: z.string(),
          includeIds: z
            .boolean()
            .optional()
            .describe(
              "Return HTML with data-marigold-id attributes so you can target elements with patch_doc (default false = clean HTML).",
            ),
        },
      },
      async ({ docId, includeIds }, extra: ToolExtra) => {
        const userId = userIdOf(extra);
        if (!userId) return fail("unauthenticated");
        const actor = await actorForUserId(userId);
        const { ok: allowed, role } = await authorize(docId, actor, "view");
        if (!allowed) return fail("not authorized to view this doc");
        const doc = (
          await db.select().from(docs).where(eq(docs.id, docId)).limit(1)
        )[0];
        if (!doc) return fail("doc not found");
        // Update-capable roles read the working draft; read-only roles (incl.
        // the public-doc viewer fallback) only see the published version.
        const canUpdate = !!role && roleCan(role, "update");
        const currentHtml = await currentHtmlOf(
          canUpdate
            ? doc.latestVersionId
            : doc.publishedVersionId,
          includeIds === true && canUpdate,
        );
        return ok({
          docId: doc.id,
          slug: doc.slug,
          title: doc.title,
          url: `/d/${doc.slug}`,
          renderOrigin: renderOriginFor(doc.renderId),
          ...(canUpdate ? { latestVersionId: doc.latestVersionId } : {}),
          publishedVersionId: doc.publishedVersionId,
          public: doc.isPublic,
          // Themed docs report their pinned theme so an agent can update
          // content-only (send `content` to update_doc, not full `html`).
          theme: doc.theme,
          themeVersion: doc.themeVersion,
          currentHtml,
        });
      },
    );

    server.registerTool(
      "share_doc",
      {
        title: "Share doc",
        description:
          "Grant a person access to a doc by email, and/or set link visibility. Public docs are viewable (published version) by anyone with the link, no sign-in; editing and commenting always require an explicit grant. After sharing, call get_feedback(docId) to WATCH for the recipient's comments and respond in the same session — the reaction only happens while an agent is listening.",
        inputSchema: {
          docId: z.string(),
          email: z.string().optional(),
          role: z.enum(["viewer", "commenter", "editor"]).optional(),
          public: z
            .boolean()
            .optional()
            .describe("true = anyone with the link can view; false = private"),
        },
      },
      async ({ docId, email, role, public: makePublic }, extra: ToolExtra) => {
        const userId = userIdOf(extra);
        if (!userId) return fail("unauthenticated");
        const actor = await actorForUserId(userId);
        const { ok: allowed } = await authorize(docId, actor, "manage");
        if (!allowed) return fail("not authorized to share this doc");

        if (email === undefined && makePublic === undefined)
          return fail("provide an email to grant access, public to set link visibility, or both");

        if (makePublic !== undefined) {
          await db
            .update(docs)
            .set({ isPublic: makePublic })
            .where(eq(docs.id, docId));
        }
        if (email === undefined) {
          const doc = (
            await db
              .select({ slug: docs.slug })
              .from(docs)
              .where(eq(docs.id, docId))
              .limit(1)
          )[0];
          if (!doc) return fail("doc not found");
          return ok({ public: makePublic, url: `/d/${doc.slug}` });
        }

        const grantRole = role ?? "viewer";
        const { email: normalized, state } = await upsertShare({
          docId,
          email,
          role: grantRole,
          invitedBy: userId,
        });
        const doc = (
          await db
            .select({ slug: docs.slug, title: docs.title })
            .from(docs)
            .where(eq(docs.id, docId))
            .limit(1)
        )[0];
        const invite = doc
          ? await sendInvite({
              email: normalized,
              docSlug: doc.slug,
              docTitle: doc.title,
              inviterName: null,
              role: grantRole,
            })
          : { sent: false, link: "" };

        return ok({
          email: normalized,
          state,
          role: grantRole,
          inviteSent: invite.sent,
          inviteLink: invite.link,
          ...(makePublic !== undefined ? { public: makePublic } : {}),
        });
      },
    );

    server.registerTool(
      "delete_doc",
      {
        title: "Delete doc",
        description:
          "Permanently delete a doc you own — the doc, every version, and all comments and shares are removed, and its URL stops working. This cannot be undone, so only call it when the human has explicitly asked to delete the doc (never to \"clean up\" on your own).",
        inputSchema: { docId: z.string() },
      },
      async ({ docId }, extra: ToolExtra) => {
        const userId = userIdOf(extra);
        if (!userId) return fail("unauthenticated");
        const actor = await actorForUserId(userId);
        const { ok: allowed } = await authorize(docId, actor, "delete");
        if (!allowed) return fail("not authorized to delete this doc (owner only)");
        const deleted = await deleteDoc(docId);
        if (!deleted) return fail("doc not found");
        return ok({ deleted: true, docId });
      },
    );

    server.registerTool(
      "get_comments",
      {
        title: "Get comments",
        description:
          "Read human feedback on a doc. Each comment includes the element text it's anchored to, so you can revise the HTML and call update_doc — comments re-anchor automatically. Pass assignedToAi: true to get just the comments editors queued for you (✨) — address those, reply_to_comment with what changed, then resolve_comment.",
        inputSchema: {
          docId: z.string(),
          status: z.enum(["open", "resolved", "orphaned"]).optional(),
          assignedToAi: z
            .boolean()
            .optional()
            .describe("true = only comments assigned to AI"),
        },
      },
      async ({ docId, status, assignedToAi }, extra: ToolExtra) => {
        const userId = userIdOf(extra);
        if (!userId) return fail("unauthenticated");
        const actor = await actorForUserId(userId);
        const { ok: allowed } = await authorize(docId, actor, "view");
        if (!allowed) return fail("not authorized to view this doc");

        const rows = await listComments(docId, { status, assignedToAi });
        const list = rows.map((c) => {
          const a = (c.anchor ?? {}) as { textQuote?: { exact?: string } };
          return {
            id: c.id,
            threadId: c.parentId ?? c.id,
            isReply: !!c.parentId,
            author: c.authorName ?? "someone",
            body: c.body,
            status: c.status,
            assignedToAi: c.assignedToAi,
            byAi: c.viaAssistant,
            anchoredText: a.textQuote?.exact ?? null,
          };
        });
        return ok({ comments: list });
      },
    );

    server.registerTool(
      "reply_to_comment",
      {
        title: "Reply to comment",
        description:
          "Reply to a comment thread. Use it to say what you changed (or why you disagree) before resolving — the reply is badged as AI-written in the doc.",
        inputSchema: { commentId: z.string(), body: z.string() },
      },
      async ({ commentId, body }, extra: ToolExtra) => {
        const userId = userIdOf(extra);
        if (!userId) return fail("unauthenticated");
        const c = await getComment(commentId);
        if (!c) return fail("comment not found");
        const actor = await actorForUserId(userId);
        const { ok: allowed } = await authorize(c.docId, actor, "comment");
        if (!allowed) return fail("not authorized to comment on this doc");
        // Replies always attach to the thread root.
        const threadId = c.parentId ?? c.id;
        const r = await replyToComment({
          parentId: threadId,
          authorId: userId,
          body: String(body).slice(0, 4000),
          viaAssistant: true,
        });
        if (!r) return fail("comment not found");
        return ok({ id: r.id, threadId });
      },
    );

    server.registerTool(
      "resolve_comment",
      {
        title: "Resolve comment",
        description:
          "Mark a comment thread resolved once you've addressed it. If it was assigned to AI, reply_to_comment first so the humans see what changed.",
        inputSchema: { commentId: z.string() },
      },
      async ({ commentId }, extra: ToolExtra) => {
        const userId = userIdOf(extra);
        if (!userId) return fail("unauthenticated");
        const c = await getComment(commentId);
        if (!c) return fail("comment not found");
        const actor = await actorForUserId(userId);
        const { ok: allowed } = await authorize(c.docId, actor, "update");
        if (!allowed) return fail("not authorized");
        await setCommentStatus(commentId, "resolved");
        return ok({ ok: true });
      },
    );

    // ── get_feedback (feedback-loop events feed) ──────────────────────────────
    // Keep this LAST so future tool additions and this one don't collide on the
    // same merge lines. Blocks until new activity lands on a doc, then returns
    // it — the MCP twin of GET /api/docs/:id/events long-poll.
    server.registerTool(
      "get_feedback",
      {
        title: "Get feedback (wait for new activity)",
        description:
          "Block until new activity lands on a doc — a human comment, a resolve, or a content change — then return those events. This closes the feedback loop: after you share or update a doc, call get_feedback and it returns the moment someone comments, instead of you waiting for the human to prompt you again. sinceSeq is your cursor (omit or 0 = from the start; pass back the returned `latest` to continue where you left off). It returns immediately if there's already activity after sinceSeq; otherwise it waits up to waitSeconds (default 30, max 50) and returns an empty list on timeout — just call it again to keep watching. comment.created/comment.resolved events include the comment's author and body so you can act on the feedback directly (then reply_to_comment and resolve_comment).",
        inputSchema: {
          docId: z.string(),
          sinceSeq: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe("Cursor: return events with seq greater than this (default 0)"),
          waitSeconds: z
            .number()
            .int()
            .min(0)
            .max(50)
            .optional()
            .describe("Max seconds to block waiting for activity (default 30, max 50)"),
        },
      },
      async ({ docId, sinceSeq, waitSeconds }, extra: ToolExtra) => {
        const userId = userIdOf(extra);
        if (!userId) return fail("unauthenticated");
        const actor = await actorForUserId(userId);
        const { ok: allowed } = await authorize(docId, actor, "view");
        if (!allowed) return fail("not authorized to view this doc");

        const since = sinceSeq ?? 0;
        const wait = Math.min(Math.max(waitSeconds ?? 30, 0), 50);
        // Shared long-poll loop; `latest` is the race-safe resume cursor.
        const { events, latest } = await waitForEvents({
          docId,
          sinceSeq: since,
          waitMs: wait * 1000,
        });
        return ok({ events: await enrichEvents(docId, events), latest });
      },
    );

    // ---- patch_doc (registered last to localize merge conflicts) ----------
    // Small-payload update path: send only the elements that changed, keyed by
    // their data-marigold-id, instead of re-transmitting the whole page.
    server.registerTool(
      "patch_doc",
      {
        title: "Patch doc",
        description:
          "Update a doc by sending ONLY the elements that changed, keyed by their data-marigold-id — much cheaper than update_doc for small edits (a few hundred tokens vs re-sending the whole page). Prefer this over update_doc whenever you're changing a handful of elements in an existing doc; use update_doc for a full rewrite or a brand-new page. Ops apply atomically (an unknown id fails the whole patch) and comments re-anchor as usual. ops is an array of: {op:\"replace\", marigoldId, html} (replace an element's inner content), {op:\"setText\", marigoldId, text} (replace text, auto-escaped), {op:\"append\", marigoldId, html} (insert markup right after the element), {op:\"remove\", marigoldId}. Example: [{\"op\":\"setText\",\"marigoldId\":\"mg-1a2b3c4d5e\",\"text\":\"Q3 revenue: $4.2M\"},{\"op\":\"append\",\"marigoldId\":\"mg-9f8e7d6c5b\",\"html\":\"<p>Updated 2026-07-07.</p>\"}].",
        inputSchema: {
          docId: z.string(),
          ops: z
            .array(z.record(z.string(), z.unknown()))
            .describe(
              'Element ops keyed by marigoldId, e.g. [{"op":"replace","marigoldId":"mg-xxxxxxxxxx","html":"..."}]',
            ),
        },
      },
      async ({ docId, ops }, extra: ToolExtra) => {
        const userId = userIdOf(extra);
        if (!userId) return fail("unauthenticated");
        const actor = await actorForUserId(userId);
        const { ok: allowed } = await authorize(docId, actor, "update");
        if (!allowed) return fail("not authorized to update this doc");
        const doc = (
          await db.select().from(docs).where(eq(docs.id, docId)).limit(1)
        )[0];
        if (!doc) return fail("doc not found");
        // Clean HTML round-trips to the SAME ids (they're structural), so
        // applyPatchOps re-instruments to exactly the ids the ops reference.
        const base = doc.latestVersionId;
        const html = await currentHtmlOf(base);
        if (!html) return fail("doc has no content to patch");
        try {
          const newHtml = applyPatchOps(html, ops as unknown as PatchOp[]);
          const r = await updateDoc({
            docId,
            html: newHtml,
            assistant: "mcp-patch",
            // CAS: the patch was computed against `base`; if another write
            // landed in the read→write window, reject rather than clobber it.
            expectedLatestVersionId: base ?? undefined,
          });
          // Feedback feed: a patch replaces content (skip no-op writes).
          if (!r.unchanged)
            await emitDocEvent({
              docId,
              type: "content.replaced",
              actor: userId,
              payload: { versionId: r.versionId, ordinal: r.ordinal },
            });
          return ok({
            docId: r.docId,
            slug: r.slug,
            url: r.url,
            versionId: r.versionId,
            ordinal: r.ordinal,
            unchanged: r.unchanged,
            applied: (ops as unknown[]).length,
          });
        } catch (e) {
          if (e instanceof PatchError) return fail(e.message);
          if (e instanceof StaleVersionError)
            return fail(
              "doc changed since you read it (a concurrent edit landed) — call get_doc with includeIds:true again and re-apply your patch",
            );
          if (e instanceof IngestError) return fail(e.message);
          throw e;
        }
      },
    );
  },
  {
    serverInfo: { name: "marigold", version: "1.0.0" },
    // Injected into the client's context on connect (where supported).
    instructions: MARIGOLD_DIGEST,
  },
  { basePath: "/api" },
);

// Verify our AS-issued access token; expose the owner userId to tools via extra.
const handler = withMcpAuth(
  baseHandler,
  async (_req, bearer) => {
    if (!bearer) return undefined;
    const claims = await verifyAccessToken(bearer);
    if (!claims) return undefined;
    return {
      token: bearer,
      clientId: claims.clientId,
      scopes: claims.scope ? claims.scope.split(" ") : [],
      expiresAt: claims.expiresAt,
      extra: { userId: claims.userId },
    };
  },
  { required: true },
);

export { handler as GET, handler as POST, handler as DELETE };
