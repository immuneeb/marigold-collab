import { currentActor } from "@/lib/actor";
import { json } from "@/lib/http";
import {
  changeShareRole,
  docOwnerForShare,
  isRole,
  revokeShare,
} from "@/lib/shares";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

// Only the owner of the doc a share belongs to may manage it.
async function requireDocOwner(shareId: string, userId: string | null) {
  const target = await docOwnerForShare(shareId);
  if (!target) return { status: 404 as const };
  if (!userId || target.ownerId !== userId)
    return { status: userId ? (403 as const) : (401 as const) };
  return { status: 200 as const };
}

export async function PATCH(req: Request, { params }: Params) {
  const { id } = await params;
  const actor = await currentActor();
  const gate = await requireDocOwner(id, actor.userId);
  if (gate.status !== 200) return json(gate.status, { error: "forbidden" });

  let body: { role?: string };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }
  if (!body.role || !isRole(body.role))
    return json(400, { error: "valid role required" });

  await changeShareRole(id, body.role);
  return json(200, { ok: true });
}

export async function DELETE(_req: Request, { params }: Params) {
  const { id } = await params;
  const actor = await currentActor();
  const gate = await requireDocOwner(id, actor.userId);
  if (gate.status !== 200) return json(gate.status, { error: "forbidden" });

  await revokeShare(id);
  return json(200, { ok: true });
}
