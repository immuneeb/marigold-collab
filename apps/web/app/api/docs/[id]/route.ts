import { eq } from "drizzle-orm";
import { authorize, IngestError, updateDoc } from "@marigold/core";
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
  const { ok } = await authorize(id, actor, "view");
  if (!ok) return json(actor.userId ? 403 : 401, { error: "forbidden" });

  const doc = (
    await db.select().from(docs).where(eq(docs.id, id)).limit(1)
  )[0];
  if (!doc) return json(404, { error: "not_found" });
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
