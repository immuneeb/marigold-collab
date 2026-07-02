import { eq } from "drizzle-orm";
import {
  applyInlineEdits,
  authorize,
  getBlobStore,
  IngestError,
  type InlineEdit,
  updateDoc,
} from "@marigold/core";
import { db, docs } from "@marigold/db";
import { currentActor } from "@/lib/actor";
import { json } from "@/lib/http";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

// Double-click editing: apply element-level content edits to the doc source and
// roll a new version through the normal pipeline (comments re-anchor).
export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  const actor = await currentActor();
  const { ok } = await authorize(id, actor, "update");
  if (!ok) return json(actor.userId ? 403 : 401, { error: "forbidden" });

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
    });
    return json(200, {
      versionId: result.versionId,
      ordinal: result.ordinal,
      unchanged: result.unchanged,
    });
  } catch (e) {
    if (e instanceof IngestError) return json(400, { error: e.message });
    return json(400, { error: (e as Error).message });
  }
}
