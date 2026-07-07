import { and, eq, isNull } from "drizzle-orm";
import {
  applyPatchOps,
  authorize,
  DocClaimedError,
  getBlobStore,
  IngestError,
  type PatchOp,
  PatchError,
  quickDocExpiry,
  StaleVersionError,
  updateDoc,
} from "@marigold/core";
import { db, docs } from "@marigold/db";
import { currentActor } from "@/lib/actor";
import { emitDocEvent } from "@/lib/events";
import { json } from "@/lib/http";
import { quickKeyGrants, requestQuickKey } from "@/lib/quick";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

// Patch ops: apply element-level ops (replace/setText/append/remove) keyed by
// marigoldId to the doc source and roll a new version through the normal
// pipeline (comments re-anchor). The small-payload sibling of PUT
// /api/docs/:id/content — the agent sends only the elements that changed
// instead of re-transmitting the whole page. Auth mirrors inline-edit exactly.
export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  const actor = await currentActor();
  const { ok } = await authorize(id, actor, "update");
  // Additive quick-doc branch: a valid key on a live unclaimed doc is edit
  // capability (?k= / X-Marigold-Key). Owned docs never reach this — their key
  // hash is burned.
  let quick = false;
  if (!ok) {
    const doc = (
      await db.select().from(docs).where(eq(docs.id, id)).limit(1)
    )[0];
    quick =
      !!doc && !doc.quarantined && quickKeyGrants(doc, requestQuickKey(req));
    if (!quick) return json(actor.userId ? 403 : 401, { error: "forbidden" });
  }

  let body: { ops?: PatchOp[]; baseVersionId?: string };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }
  const ops = Array.isArray(body.ops) ? body.ops : [];
  if (ops.length === 0 || ops.length > 100) {
    return json(400, { error: "1-100 ops required" });
  }

  const doc = (
    await db.select().from(docs).where(eq(docs.id, id)).limit(1)
  )[0];
  if (!doc) return json(404, { error: "not_found" });
  // A quick-key caller must still hold a live grant now that the body has
  // arrived — the doc may have been claimed (key burned) while it uploaded.
  if (quick && !quickKeyGrants(doc, requestQuickKey(req))) {
    return json(403, { error: "claimed", hint: "The doc was claimed; the quick key no longer grants access." });
  }

  const targetVersionId = doc.latestVersionId;
  if (!targetVersionId) return json(404, { error: "no_content" });
  // Optional optimistic concurrency: patch against the version the caller last
  // saw. When omitted, patch against the current latest.
  if (body.baseVersionId && body.baseVersionId !== targetVersionId) {
    return json(409, { error: "doc_changed", message: "Doc changed since you loaded it — reload and retry." });
  }

  const store = getBlobStore();
  const manifest = await store.getManifest(targetVersionId);
  const sha = manifest?.["index.html"];
  const bytes = sha ? await store.getBlob(sha) : null;
  if (!bytes) return json(404, { error: "content_missing" });

  try {
    const newHtml = applyPatchOps(new TextDecoder().decode(bytes), ops);
    const result = await updateDoc({
      docId: id,
      html: newHtml,
      assistant: "patch",
      requireUnclaimed: quick, // key writes fail if the doc was claimed mid-flight
      // CAS: patch was computed against targetVersionId; reject (409) rather
      // than clobber a version committed in the read→patch→write window, even
      // when the client didn't supply baseVersionId.
      expectedLatestVersionId: targetVersionId,
    });
    // Rolling expiry: a successful unclaimed write buys another 30 days.
    // ownerId IS NULL guard: never re-stamp expiry onto a just-claimed doc.
    if (quick) {
      await db
        .update(docs)
        .set({ expiresAt: quickDocExpiry() })
        .where(and(eq(docs.id, id), isNull(docs.ownerId)));
    }
    // Feedback feed: a patch replaces content (skip no-op writes, which roll no
    // new version) — same signal watchers get from a full-replace update.
    if (!result.unchanged)
      await emitDocEvent({
        docId: id,
        type: "content.replaced",
        actor: quick ? null : actor.userId,
        payload: { versionId: result.versionId, ordinal: result.ordinal },
      });
    return json(200, {
      versionId: result.versionId,
      ordinal: result.ordinal,
      unchanged: result.unchanged,
      applied: ops.length,
    });
  } catch (e) {
    if (e instanceof PatchError)
      return json(400, { error: e.code, message: e.message, ids: e.ids });
    if (e instanceof StaleVersionError)
      return json(409, {
        error: "doc_changed",
        message: "Doc changed since you loaded it — reload and reapply your patch.",
      });
    if (e instanceof DocClaimedError)
      return json(403, { error: "claimed", hint: "The doc was claimed; the quick key no longer grants access." });
    if (e instanceof IngestError) return json(400, { error: e.message });
    return json(400, { error: (e as Error).message });
  }
}
