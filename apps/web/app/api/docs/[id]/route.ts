import { eq } from "drizzle-orm";
import {
  authorize,
  deleteDoc,
  IngestError,
  renameDoc,
  roleCan,
  updateDoc,
} from "@marigold/core";
import { db, docs } from "@marigold/db";
import { currentActor } from "@/lib/actor";
import { json } from "@/lib/http";

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
  const { ok } = await authorize(id, actor, "update");
  if (!ok) return json(actor.userId ? 403 : 401, { error: "forbidden" });

  let body: { title?: string; html?: string; files?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }

  // Title-only rename: metadata change, no new version.
  if (body.html === undefined && body.files === undefined) {
    if (typeof body.title !== "string")
      return json(400, { error: "nothing_to_update" });
    const { title } = await renameDoc(id, body.title);
    return json(200, { docId: id, title });
  }

  try {
    const result = await updateDoc({
      docId: id,
      title: body.title,
      html: body.html,
      files: body.files as never,
    });
    return json(200, result);
  } catch (e) {
    if (e instanceof IngestError)
      return json(ingestStatus(e.code), { error: e.code, message: e.message });
    throw e;
  }
}

// Permanent, owner-only (the "delete" capability). Cascades to versions,
// comments, shares, and network grants; purges blobs no other doc references.
export async function DELETE(_req: Request, { params }: Params) {
  const { id } = await params;
  const actor = await currentActor();
  const { ok } = await authorize(id, actor, "delete");
  if (!ok) return json(actor.userId ? 403 : 401, { error: "forbidden" });

  const deleted = await deleteDoc(id);
  if (!deleted) return json(404, { error: "not_found" });
  return json(200, { ok: true });
}
