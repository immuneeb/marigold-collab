import { authorize, publishDoc } from "@marigold/core";
import { currentActor } from "@/lib/actor";
import { json } from "@/lib/http";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  const actor = await currentActor();
  const { ok } = await authorize(id, actor, "publish");
  if (!ok) return json(actor.userId ? 403 : 401, { error: "forbidden" });

  let body: { versionId?: string };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }
  if (!body.versionId) return json(400, { error: "missing versionId" });

  try {
    await publishDoc(id, body.versionId);
  } catch (e) {
    return json(400, { error: (e as Error).message });
  }
  return json(200, { ok: true });
}
