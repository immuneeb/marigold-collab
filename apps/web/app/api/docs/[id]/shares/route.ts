import { eq } from "drizzle-orm";
import { authorize } from "@marigold/core";
import { db, docs } from "@marigold/db";
import { currentActor } from "@/lib/actor";
import { json } from "@/lib/http";
import { sendInvite } from "@/lib/invite";
import { isRole, listShares, upsertShare } from "@/lib/shares";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  const actor = await currentActor();
  const { ok } = await authorize(id, actor, "manage");
  if (!ok) return json(actor.userId ? 403 : 401, { error: "forbidden" });
  return json(200, { shares: await listShares(id) });
}

export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  const actor = await currentActor();
  const { ok } = await authorize(id, actor, "manage");
  if (!ok) return json(actor.userId ? 403 : 401, { error: "forbidden" });

  let body: { email?: string; role?: string };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }
  if (!body.email || !body.role || !isRole(body.role)) {
    return json(400, { error: "email and a valid role are required" });
  }

  const { email, state } = await upsertShare({
    docId: id,
    email: body.email,
    role: body.role,
    invitedBy: actor.userId as string,
  });

  const doc = (
    await db
      .select({ slug: docs.slug, title: docs.title })
      .from(docs)
      .where(eq(docs.id, id))
      .limit(1)
  )[0];

  const invite = doc
    ? await sendInvite({
        email,
        docSlug: doc.slug,
        docTitle: doc.title,
        inviterName: null,
        role: body.role,
      })
    : { sent: false, link: "" };

  return json(200, {
    email,
    state,
    invite: { sent: invite.sent, link: invite.link, error: invite.error },
  });
}
