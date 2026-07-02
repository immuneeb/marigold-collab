import { authorize } from "@marigold/core";
import { currentActor } from "@/lib/actor";
import {
  createComment,
  listComments,
  versionBelongsToDoc,
} from "@/lib/comments";
import { json } from "@/lib/http";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Params) {
  const { id } = await params;
  const actor = await currentActor();
  const { ok } = await authorize(id, actor, "view");
  if (!ok) return json(actor.userId ? 403 : 401, { error: "forbidden" });
  const status = new URL(req.url).searchParams.get("status") ?? undefined;
  return json(200, {
    comments: await listComments(id, { status: status || undefined }),
  });
}

export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  const actor = await currentActor();
  const { ok } = await authorize(id, actor, "comment");
  if (!ok) return json(actor.userId ? 403 : 401, { error: "forbidden" });

  let body: { anchor?: unknown; body?: string; versionId?: string };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }
  if (!body.body || !body.anchor || !body.versionId) {
    return json(400, { error: "anchor, versionId and body are required" });
  }
  if (!(await versionBelongsToDoc(id, body.versionId))) {
    return json(400, { error: "versionId does not belong to this doc" });
  }

  const commentId = await createComment({
    docId: id,
    authorId: actor.userId as string,
    versionId: body.versionId,
    anchor: body.anchor,
    body: String(body.body).slice(0, 4000),
  });
  return json(200, { id: commentId });
}
