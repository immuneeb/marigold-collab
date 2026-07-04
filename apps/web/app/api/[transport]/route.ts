import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { z } from "zod";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import {
  authorize,
  buildAddressFeedbackPrompt,
  buildAnalyzePrompt,
  buildLearnPrompt,
  buildStartAnalysisText,
  createDoc,
  deinstrumentHtml,
  deleteDoc,
  getBlobStore,
  IngestError,
  MARIGOLD_DIGEST,
  renderOriginFor,
  roleCan,
  updateDoc,
} from "@marigold/core";
import { comments, db, docs } from "@marigold/db";
import { actorForUserId } from "@/lib/actor";
import {
  getComment,
  listComments,
  replyToComment,
  setCommentStatus,
} from "@/lib/comments";
import { sendInvite } from "@/lib/invite";
import { verifyAccessToken } from "@/lib/oauth/tokens";
import { upsertShare } from "@/lib/shares";

export const runtime = "nodejs";

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

async function currentHtmlOf(latestVersionId: string | null): Promise<string | null> {
  if (!latestVersionId) return null;
  const store = getBlobStore();
  const manifest = await store.getManifest(latestVersionId);
  const sha = manifest?.["index.html"];
  if (!sha) return null;
  const bytes = await store.getBlob(sha);
  // Return clean HTML — strip Marigold's injected ids + agent.
  return bytes ? deinstrumentHtml(new TextDecoder().decode(bytes)) : null;
}

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
          "Create a new Marigold doc from a self-contained HTML page and return its URL. Inline all CSS/JS/SVG and use data: URIs for images — external scripts, fonts, and images are blocked by CSP and fail silently. Lead with the core insight and carry the structure in a diagram (call start_analysis for the full authoring guide).",
        inputSchema: { title: z.string().optional(), html: z.string() },
      },
      async ({ title, html }, extra: ToolExtra) => {
        const userId = userIdOf(extra);
        if (!userId) return fail("unauthenticated");
        try {
          const r = await createDoc({ ownerId: userId, title, html, assistant: "mcp" });
          return ok({
            docId: r.docId,
            slug: r.slug,
            url: r.url,
            versionId: r.versionId,
            ordinal: r.ordinal,
          });
        } catch (e) {
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
          "Replace a doc's content in place (same URL). No-op if unchanged. Keep the DOM structure stable — comments anchor to elements, so edit content in place; reordering or re-nesting sections orphans readers' comments.",
        inputSchema: {
          docId: z.string(),
          html: z.string(),
          title: z.string().optional(),
        },
      },
      async ({ docId, html, title }, extra: ToolExtra) => {
        const userId = userIdOf(extra);
        if (!userId) return fail("unauthenticated");
        const actor = await actorForUserId(userId);
        const { ok: allowed } = await authorize(docId, actor, "update");
        if (!allowed) return fail("not authorized to update this doc");
        try {
          const r = await updateDoc({ docId, html, title, assistant: "mcp" });
          return ok({
            docId: r.docId,
            slug: r.slug,
            url: r.url,
            versionId: r.versionId,
            ordinal: r.ordinal,
            unchanged: r.unchanged,
          });
        } catch (e) {
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
        description: "Read a doc's metadata, URL, and current HTML.",
        inputSchema: { docId: z.string() },
      },
      async ({ docId }, extra: ToolExtra) => {
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
          currentHtml,
        });
      },
    );

    server.registerTool(
      "share_doc",
      {
        title: "Share doc",
        description:
          "Grant a person access to a doc by email, and/or set link visibility. Public docs are viewable (published version) by anyone with the link, no sign-in; editing and commenting always require an explicit grant.",
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
