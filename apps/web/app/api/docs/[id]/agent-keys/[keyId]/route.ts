import { revokeAgentKey } from "@marigold/core";
import { currentActor } from "@/lib/actor";
import { json } from "@/lib/http";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string; keyId: string }> };

// Revoke one agent key (MUN-74). Core enforces who may: the doc owner revokes
// any key on the doc; a minter revokes their own. Revocation is immediate —
// the next auth re-resolves the key and finds it dead. A single 404 covers
// "no such key on this doc" and "not yours to revoke" so a prober can't map
// key ids across docs.
export async function DELETE(_req: Request, { params }: Params) {
  const { id, keyId } = await params;
  const actor = await currentActor();
  if (!actor.userId) return json(401, { error: "forbidden" });

  const ok = await revokeAgentKey(id, keyId, actor.userId);
  if (!ok) return json(404, { error: "not_found" });
  return json(200, { ok: true });
}
