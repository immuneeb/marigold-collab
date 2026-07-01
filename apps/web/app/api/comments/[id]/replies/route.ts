import { authorize } from "@marigold/core";
import { currentActor } from "@/lib/actor";
import { getComment, replyToComment } from "@/lib/comments";
import { json } from "@/lib/http";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: Params) {
  const { id } = await params; // parent comment id
  const actor = await currentActor();
  const parent = await getComment(id);
  if (!parent) return json(404, { error: "not_found" });

  const { ok } = await authorize(parent.docId, actor, "comment");
  if (!ok) return json(actor.userId ? 403 : 401, { error: "forbidden" });

  let body: { body?: string };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }
  if (!body.body) return json(400, { error: "body required" });

  const reply = await replyToComment({
    parentId: id,
    authorId: actor.userId as string,
    body: String(body.body).slice(0, 4000),
  });
  return json(200, { id: reply?.id });
}
