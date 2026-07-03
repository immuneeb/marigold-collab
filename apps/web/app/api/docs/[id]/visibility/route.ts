import { eq } from "drizzle-orm";
import { authorize } from "@marigold/core";
import { db, docs } from "@marigold/db";
import { currentActor } from "@/lib/actor";
import { json } from "@/lib/http";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

// Toggle link visibility. Public docs are viewable (published version only) by
// anyone without signing in; editing/commenting still requires an explicit
// grant. Owner-only in v1 (the only role with `manage`).
export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  const actor = await currentActor();
  const { ok } = await authorize(id, actor, "manage");
  if (!ok) return json(actor.userId ? 403 : 401, { error: "forbidden" });

  let body: { public?: boolean };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }
  if (typeof body.public !== "boolean") {
    return json(400, { error: "public (boolean) is required" });
  }

  await db
    .update(docs)
    .set({ isPublic: body.public })
    .where(eq(docs.id, id));
  return json(200, { ok: true, public: body.public });
}
