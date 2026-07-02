import { authorize } from "@marigold/core";
import { currentActor } from "@/lib/actor";
import {
  editCommentBody,
  getComment,
  setCommentAiAssignment,
  setCommentStatus,
} from "@/lib/comments";
import { json } from "@/lib/http";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

// Resolve/reopen: comment author OR doc editor+. Edit body: author only.
// Assign/unassign to AI: doc editor+.
export async function PATCH(req: Request, { params }: Params) {
  const { id } = await params;
  const actor = await currentActor();
  const c = await getComment(id);
  if (!c) return json(404, { error: "not_found" });

  let body: { status?: string; body?: string; assignToAi?: boolean };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }

  const isAuthor = !!actor.userId && c.authorId === actor.userId;

  if (body.status === "resolved" || body.status === "open") {
    const canModerate = (await authorize(c.docId, actor, "update")).ok;
    if (!canModerate && !isAuthor)
      return json(actor.userId ? 403 : 401, { error: "forbidden" });
    await setCommentStatus(id, body.status);
  }

  if (typeof body.assignToAi === "boolean") {
    const canEdit = (await authorize(c.docId, actor, "update")).ok;
    if (!canEdit)
      return json(actor.userId ? 403 : 401, { error: "forbidden" });
    await setCommentAiAssignment(id, body.assignToAi, actor.userId ?? null);
  }

  if (typeof body.body === "string") {
    if (!isAuthor) return json(403, { error: "only the author can edit" });
    await editCommentBody(id, body.body.slice(0, 4000));
  }

  return json(200, { ok: true });
}
