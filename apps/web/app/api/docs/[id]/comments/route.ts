import { eq } from "drizzle-orm";
import { authorize } from "@marigold/core";
import { db, docs } from "@marigold/db";
import { currentActor } from "@/lib/actor";
import {
  createComment,
  displayNameInUse,
  listComments,
  sanitizeGuestName,
  versionBelongsToDoc,
} from "@/lib/comments";
import { emitDocEvent } from "@/lib/events";
import { json } from "@/lib/http";
import { quickKeyGrants, requestQuickKey } from "@/lib/quick";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Params) {
  const { id } = await params;
  const actor = await currentActor();
  const { ok } = await authorize(id, actor, "view");
  // Additive quick-doc branch: a live key on an unclaimed doc grants view, so a
  // URL holder can read the thread they're commenting in (mirrors content GET).
  if (!ok) {
    const doc = (
      await db.select().from(docs).where(eq(docs.id, id)).limit(1)
    )[0];
    const quick =
      !!doc && !doc.quarantined && quickKeyGrants(doc, requestQuickKey(req));
    if (!quick) return json(actor.userId ? 403 : 401, { error: "forbidden" });
  }
  const status = new URL(req.url).searchParams.get("status") ?? undefined;
  return json(200, {
    comments: await listComments(id, { status: status || undefined }),
  });
}

export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  const actor = await currentActor();
  const { ok } = await authorize(id, actor, "comment");
  // Additive quick-doc branch (mirrors content/patch): a valid key on a live
  // unclaimed doc lets the URL holder comment as a GUEST. Owned docs never reach
  // this — their key hash is burned, so commenting stays account+ACL there.
  let quick = false;
  if (!ok) {
    const doc = (
      await db.select().from(docs).where(eq(docs.id, id)).limit(1)
    )[0];
    quick =
      !!doc && !doc.quarantined && quickKeyGrants(doc, requestQuickKey(req));
    if (!quick) return json(actor.userId ? 403 : 401, { error: "forbidden" });
  }

  let body: {
    anchor?: unknown;
    body?: string;
    versionId?: string;
    author?: string;
  };
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

  // ── Guest (quick-key) comment ──────────────────────────────────────────────
  if (quick) {
    // TOCTOU: re-verify the grant now the body has arrived — the doc may have
    // been claimed (key burned) while the request uploaded, exactly as the
    // content/patch write routes re-check.
    const fresh = (
      await db.select().from(docs).where(eq(docs.id, id)).limit(1)
    )[0];
    if (!fresh || !quickKeyGrants(fresh, requestQuickKey(req))) {
      return json(403, {
        error: "claimed",
        hint: "The doc was claimed; the quick key no longer grants access.",
      });
    }
    const authorName = sanitizeGuestName(body.author);
    if (!authorName) {
      return json(400, {
        error: "author_required",
        hint: "Guest comments need an `author` display name (1–40 chars of plain text).",
      });
    }
    // Impersonation guard: a guest may not adopt a real account's display name.
    if (await displayNameInUse(authorName)) {
      return json(409, {
        error: "name_taken",
        hint: "That name belongs to a Marigold account — pick a different guest name.",
      });
    }
    const commentId = await createComment({
      docId: id,
      authorId: null,
      versionId: body.versionId,
      anchor: body.anchor,
      body: String(body.body).slice(0, 4000),
      authorName,
      guest: true,
    });
    // Feedback feed: a guest comment must wake a watching agent too — this is
    // what closes the feedback loop for unclaimed quick docs.
    await emitDocEvent({
      docId: id,
      type: "comment.created",
      actor: `guest:${authorName}`,
      payload: { commentId, assignedToAi: false },
    });
    return json(200, { id: commentId, guest: true });
  }

  // ── Account comment (unchanged) ────────────────────────────────────────────
  const commentId = await createComment({
    docId: id,
    authorId: actor.userId as string,
    versionId: body.versionId,
    anchor: body.anchor,
    body: String(body.body).slice(0, 4000),
  });
  // Feedback feed: a new human comment is the signal a watching agent blocks on.
  await emitDocEvent({
    docId: id,
    type: "comment.created",
    actor: actor.userId,
    payload: { commentId, assignedToAi: false },
  });
  return json(200, { id: commentId });
}
