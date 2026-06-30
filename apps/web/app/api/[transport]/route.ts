import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import {
  authorize,
  createDoc,
  getBlobStore,
  IngestError,
  renderOriginFor,
  updateDoc,
} from "@marigold/core";
import { db, docs } from "@marigold/db";
import { actorForUserId } from "@/lib/actor";
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
  return bytes ? new TextDecoder().decode(bytes) : null;
}

const baseHandler = createMcpHandler(
  (server) => {
    server.registerTool(
      "create_doc",
      {
        title: "Create doc",
        description:
          "Create a new Marigold doc from generated HTML and return its URL.",
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
          "Replace a doc's content in place (same URL). No-op if unchanged.",
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
        description: "List the docs you own.",
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
            createdAt: docs.createdAt,
          })
          .from(docs)
          .where(eq(docs.ownerId, userId))
          .orderBy(desc(docs.createdAt));
        return ok({ docs: rows.map((r) => ({ ...r, url: `/d/${r.slug}` })) });
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
        const { ok: allowed } = await authorize(docId, actor, "view");
        if (!allowed) return fail("not authorized to view this doc");
        const doc = (
          await db.select().from(docs).where(eq(docs.id, docId)).limit(1)
        )[0];
        if (!doc) return fail("doc not found");
        const currentHtml = await currentHtmlOf(doc.latestVersionId);
        return ok({
          docId: doc.id,
          slug: doc.slug,
          title: doc.title,
          url: `/d/${doc.slug}`,
          renderOrigin: renderOriginFor(doc.renderId),
          latestVersionId: doc.latestVersionId,
          publishedVersionId: doc.publishedVersionId,
          currentHtml,
        });
      },
    );

    server.registerTool(
      "share_doc",
      {
        title: "Share doc",
        description: "Grant a person access to a doc by email.",
        inputSchema: {
          docId: z.string(),
          email: z.string(),
          role: z.enum(["viewer", "commenter", "editor"]).optional(),
        },
      },
      async ({ docId, email, role }, extra: ToolExtra) => {
        const userId = userIdOf(extra);
        if (!userId) return fail("unauthenticated");
        const actor = await actorForUserId(userId);
        const { ok: allowed } = await authorize(docId, actor, "manage");
        if (!allowed) return fail("not authorized to share this doc");

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
        });
      },
    );
  },
  {},
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
