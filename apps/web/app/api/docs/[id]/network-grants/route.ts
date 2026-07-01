import { authorize } from "@marigold/core";
import { currentActor } from "@/lib/actor";
import { json } from "@/lib/http";
import {
  addNetworkGrant,
  listNetworkGrants,
  normalizeOrigin,
  removeNetworkGrant,
} from "@/lib/network";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  const actor = await currentActor();
  const { ok } = await authorize(id, actor, "manage");
  if (!ok) return json(actor.userId ? 403 : 401, { error: "forbidden" });
  return json(200, { grants: await listNetworkGrants(id) });
}

export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  const actor = await currentActor();
  const { ok } = await authorize(id, actor, "manage");
  if (!ok) return json(actor.userId ? 403 : 401, { error: "forbidden" });

  let body: { origin?: string };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }
  const origin = normalizeOrigin(body.origin ?? "");
  if (!origin) return json(400, { error: "invalid origin (use https://host)" });

  await addNetworkGrant(id, origin, actor.userId as string);
  return json(200, { ok: true, origin });
}

export async function DELETE(req: Request, { params }: Params) {
  const { id } = await params;
  const actor = await currentActor();
  const { ok } = await authorize(id, actor, "manage");
  if (!ok) return json(actor.userId ? 403 : 401, { error: "forbidden" });

  let body: { origin?: string };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }
  if (!body.origin) return json(400, { error: "origin required" });
  await removeNetworkGrant(id, body.origin);
  return json(200, { ok: true });
}
