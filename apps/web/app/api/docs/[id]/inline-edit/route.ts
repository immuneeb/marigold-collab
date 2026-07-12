import { and, eq, isNull } from "drizzle-orm";
import {
  applyInlineEdits,
  DocClaimedError,
  getBlobStore,
  IngestError,
  type InlineEdit,
  quickDocExpiry,
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

// Double-click editing: apply element-level content edits to the doc source and
// roll a new version through the normal pipeline (comments re-anchor).
export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  const actor = await currentActor();
  // Session ACL, else a quick key on a live unclaimed doc, else a minted agent
  // key on an owned doc (attenuated to min(minter's current role, roleCap)).
  const access = await resolveDocWriteAccess(req, id, actor, "update");
  if (access.mode === "denied") return access.response;
  const quick = access.mode === "quick";

  let body: { versionId?: string; edits?: InlineEdit[] };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }
  const edits = (body.edits ?? []).filter(
    (e) => typeof e?.marigoldId === "string" && typeof e?.html === "string",
  );
  if (!body.versionId || edits.length === 0 || edits.length > 50) {
    return json(400, { error: "versionId and 1-50 edits required" });
  }

  const doc = (
    await db.select().from(docs).where(eq(docs.id, id)).limit(1)
  )[0];
  if (!doc) return json(404, { error: "not_found" });
  // A key-authed caller must still hold a live grant now that the body has
  // arrived — the doc may have been claimed (quick key burned) or the agent
  // key revoked while it uploaded.
  const recheck = await recheckDocWriteAccess(req, id, access, doc);
  if (recheck) return recheck;
  // Optimistic concurrency: edits were made against what the user was viewing.
  if (doc.latestVersionId !== body.versionId) {
    return json(409, { error: "doc_changed", message: "Doc changed since you loaded it — reload and retry." });
  }

  const store = getBlobStore();
  const manifest = await store.getManifest(body.versionId);
  const sha = manifest?.["index.html"];
  const bytes = sha ? await store.getBlob(sha) : null;
  if (!bytes) return json(404, { error: "content_missing" });

  try {
    const newHtml = applyInlineEdits(new TextDecoder().decode(bytes), edits);
    const result = await updateDoc({
      docId: id,
      html: newHtml,
      assistant: "inline-edit",
      requireUnclaimed: quick, // key writes fail if the doc was claimed mid-flight
    });
    // Rolling expiry: a successful unclaimed write buys another 30 days.
    // ownerId IS NULL guard: never re-stamp expiry onto a just-claimed doc.
    if (quick) {
      await db
        .update(docs)
        .set({ expiresAt: quickDocExpiry() })
        .where(and(eq(docs.id, id), isNull(docs.ownerId)));
    }
    // Feedback feed: an inline edit replaces content (skip no-op writes).
    if (!result.unchanged)
      await emitDocEvent({
        docId: id,
        type: "content.replaced",
        actor:
          access.mode === "agent"
            ? access.minterUserId
            : quick
              ? null
              : actor.userId,
        payload: {
          versionId: result.versionId,
          ordinal: result.ordinal,
          ...(access.mode === "agent" ? { agentKey: access.label } : {}),
        },
      });
    return json(200, {
      versionId: result.versionId,
      ordinal: result.ordinal,
      unchanged: result.unchanged,
    });
  } catch (e) {
    if (e instanceof DocClaimedError)
      return json(403, { error: "claimed", hint: "The doc was claimed; the quick key no longer grants access." });
    if (e instanceof IngestError) return json(400, { error: e.message });
    return json(400, { error: (e as Error).message });
  }
}
