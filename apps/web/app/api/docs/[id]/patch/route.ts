import { and, eq, isNull } from "drizzle-orm";
import {
  AgentKeyRevokedError,
  applyPatchOps,
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
import {
  recheckDocWriteAccess,
  resolveDocWriteAccess,
} from "@/lib/key-access";

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
  // Session ACL, else a quick key on a live unclaimed doc, else a minted agent
  // key on an owned doc (attenuated to min(minter's current role, roleCap)).
  const access = await resolveDocWriteAccess(req, id, actor, "update");
  if (access.mode === "denied") return access.response;
  const quick = access.mode === "quick";

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
  // A key-authed caller must still hold a live grant now that the body has
  // arrived — the doc may have been claimed (quick key burned) or the agent
  // key revoked while it uploaded.
  const recheck = await recheckDocWriteAccess(req, id, access, doc);
  if (recheck) return recheck;

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
      // Agent-key writes: re-check the key is still live under the write lock —
      // revocation between the recheck above and commit → 403 key_revoked.
      requireAgentKeyLive: access.mode === "agent" ? access.keyId : undefined,
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
    if (e instanceof AgentKeyRevokedError)
      return json(403, { error: "key_revoked", hint: "This agent key no longer grants update access to this doc." });
    if (e instanceof IngestError) return json(400, { error: e.message });
    return json(400, { error: (e as Error).message });
  }
}
