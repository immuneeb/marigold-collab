import { and, eq, isNull } from "drizzle-orm";
import {
  applyInlineEdits,
  authorize,
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
import { quickKeyGrants, requestQuickKey } from "@/lib/quick";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

// Double-click editing: apply element-level content edits to the doc source and
// roll a new version through the normal pipeline (comments re-anchor).
export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  const actor = await currentActor();
  const { ok } = await authorize(id, actor, "update");
  // Additive quick-doc branch: a valid key on a live unclaimed doc is edit
  // capability (the viewer sends it as X-Marigold-Key). Owned docs never
  // reach this — their key hash is burned.
  let quick = false;
  if (!ok) {
    const doc = (
      await db.select().from(docs).where(eq(docs.id, id)).limit(1)
    )[0];
    quick =
      !!doc && !doc.quarantined && quickKeyGrants(doc, requestQuickKey(req));
    if (!quick) return json(actor.userId ? 403 : 401, { error: "forbidden" });
  }

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
  // A quick-key caller must still hold a live grant now that the body has
  // arrived — the doc may have been claimed (key burned) while it uploaded.
  if (quick && !quickKeyGrants(doc, requestQuickKey(req))) {
    return json(403, { error: "claimed", hint: "The doc was claimed; the quick key no longer grants access." });
  }
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
        actor: quick ? null : actor.userId,
        payload: { versionId: result.versionId, ordinal: result.ordinal },
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
