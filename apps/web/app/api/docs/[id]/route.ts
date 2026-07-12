import { and, eq, isNull } from "drizzle-orm";
import {
  authorize,
  deleteDoc,
  DocClaimedError,
  IngestError,
  quickDocExpiry,
  renameDoc,
  roleCan,
  updateDoc,
} from "@marigold/core";
import { db, docs } from "@marigold/db";
import { currentActor } from "@/lib/actor";
import { emitDocEvent } from "@/lib/events";
import { json } from "@/lib/http";
import {
  recheckDocWriteAccess,
  resolveDocWriteAccess,
} from "@/lib/key-access";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

function ingestStatus(code: string): number {
  return code === "too_large" || code === "too_many_files" ? 413 : 400;
}

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  const actor = await currentActor();
  const { ok, role } = await authorize(id, actor, "view");
  if (!ok) return json(actor.userId ? 403 : 401, { error: "forbidden" });

  const doc = (
    await db.select().from(docs).where(eq(docs.id, id)).limit(1)
  )[0];
  if (!doc) return json(404, { error: "not_found" });
  // Read-only roles (incl. the public-doc viewer fallback) get published-facing
  // metadata only — no draft pointer, owner id, or render id.
  if (!role || !roleCan(role, "update")) {
    return json(200, {
      doc: {
        id: doc.id,
        slug: doc.slug,
        title: doc.title,
        publishedVersionId: doc.publishedVersionId,
        isPublic: doc.isPublic,
        createdAt: doc.createdAt,
      },
    });
  }
  return json(200, { doc });
}

export async function PATCH(req: Request, { params }: Params) {
  const { id } = await params;
  const actor = await currentActor();
  // Session ACL, else a quick key on a live unclaimed doc, else a minted agent
  // key on an owned doc (attenuated to min(minter's current role, roleCap)).
  const access = await resolveDocWriteAccess(req, id, actor, "update");
  if (access.mode === "denied") return access.response;
  const quick = access.mode === "quick";

  let body: { title?: string; html?: string; files?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }

  // A key-authed caller must still hold a live grant now that the body has
  // arrived — the doc may have been claimed (quick key burned) or the agent
  // key revoked while it uploaded.
  const recheck = await recheckDocWriteAccess(req, id, access);
  if (recheck) return recheck;

  const extendQuickExpiry = async () => {
    // Rolling expiry: a successful unclaimed write buys another 30 days.
    // ownerId IS NULL guard: never re-stamp expiry onto a just-claimed doc.
    if (quick) {
      await db
        .update(docs)
        .set({ expiresAt: quickDocExpiry() })
        .where(and(eq(docs.id, id), isNull(docs.ownerId)));
    }
  };

  const eventActor =
    access.mode === "agent"
      ? access.minterUserId
      : quick
        ? null
        : actor.userId;

  // Title-only rename: metadata change, no new version.
  if (body.html === undefined && body.files === undefined) {
    if (typeof body.title !== "string")
      return json(400, { error: "nothing_to_update" });
    const { title } = await renameDoc(id, body.title);
    await extendQuickExpiry();
    return json(200, { docId: id, title });
  }

  try {
    const result = await updateDoc({
      docId: id,
      title: body.title,
      html: body.html,
      files: body.files as never,
      requireUnclaimed: quick, // key writes fail if the doc was claimed mid-flight
    });
    await extendQuickExpiry();
    // Feedback feed: content was replaced (skip no-op writes, which roll no
    // new version).
    if (!result.unchanged)
      await emitDocEvent({
        docId: id,
        type: "content.replaced",
        actor: eventActor,
        payload: {
          versionId: result.versionId,
          ordinal: result.ordinal,
          ...(access.mode === "agent" ? { agentKey: access.label } : {}),
        },
      });
    return json(200, result);
  } catch (e) {
    if (e instanceof DocClaimedError)
      return json(403, {
        error: "claimed",
        hint: "The doc was claimed; the quick key no longer grants access.",
      });
    if (e instanceof IngestError)
      return json(ingestStatus(e.code), { error: e.code, message: e.message });
    throw e;
  }
}

// Permanent delete (the "delete" capability). Session path is owner-only;
// additionally (MUN-67) a live quick key on an unclaimed, unexpired,
// unquarantined doc may delete — the ?k= URL is that draft's full edit
// capability, disposal included. Agent keys can never delete: their cap tops
// out at editor and roleCan(editor, "delete") is false. Cascades to versions,
// comments, shares, and network grants; purges blobs no other doc references.
export async function DELETE(req: Request, { params }: Params) {
  const { id } = await params;
  const actor = await currentActor();
  const access = await resolveDocWriteAccess(req, id, actor, "delete");
  if (access.mode === "denied") return access.response;

  const deleted = await deleteDoc(id);
  if (!deleted) return json(404, { error: "not_found" });
  return json(200, { ok: true });
}
