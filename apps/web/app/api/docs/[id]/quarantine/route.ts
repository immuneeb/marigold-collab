import { eq } from "drizzle-orm";
import { authorize } from "@marigold/core";
import { db, docs } from "@marigold/db";
import { currentActor } from "@/lib/actor";
import { json } from "@/lib/http";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

// Kill switch: instantly quarantine (or un-quarantine) a doc. Owner-only in v1;
// an admin role can be layered on later.
export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  const actor = await currentActor();
  const { ok } = await authorize(id, actor, "manage");
  if (!ok) return json(actor.userId ? 403 : 401, { error: "forbidden" });

  let body: { quarantined?: boolean };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }

  await db
    .update(docs)
    .set({ quarantined: body.quarantined !== false })
    .where(eq(docs.id, id));
  return json(200, { ok: true, quarantined: body.quarantined !== false });
}
