import { eq } from "drizzle-orm";
import { authorize } from "@marigold/core";
import { db, docs } from "@marigold/db";
import { currentActor } from "@/lib/actor";
import {
  displayNameInUse,
  getComment,
  replyToComment,
  sanitizeGuestName,
} from "@/lib/comments";
import { emitDocEvent } from "@/lib/events";
import { json } from "@/lib/http";
import { quickKeyGrants, requestQuickKey } from "@/lib/quick";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: Params) {
  const { id } = await params; // parent comment id
  const actor = await currentActor();
  const parent = await getComment(id);
  if (!parent) return json(404, { error: "not_found" });

  const { ok } = await authorize(parent.docId, actor, "comment");
  // Additive quick-doc branch: a URL holder replies in-thread as a GUEST on a
  // live unclaimed doc. Owned docs never reach this (burned key) — replies there
  // stay account+ACL. Resolve/assign-to-AI remain account-only elsewhere.
  let quick = false;
  if (!ok) {
    const doc = (
      await db.select().from(docs).where(eq(docs.id, parent.docId)).limit(1)
    )[0];
    quick =
      !!doc && !doc.quarantined && quickKeyGrants(doc, requestQuickKey(req));
    if (!quick) return json(actor.userId ? 403 : 401, { error: "forbidden" });
  }

  let body: { body?: string; author?: string };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }
  if (!body.body) return json(400, { error: "body required" });

  // ── Guest (quick-key) reply ────────────────────────────────────────────────
  if (quick) {
    // TOCTOU: re-verify the grant now the body arrived (claimed mid-flight).
    const fresh = (
      await db.select().from(docs).where(eq(docs.id, parent.docId)).limit(1)
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
        hint: "Guest replies need an `author` display name (1–40 chars of plain text).",
      });
    }
    if (await displayNameInUse(authorName)) {
      return json(409, {
        error: "name_taken",
        hint: "That name belongs to a Marigold account — pick a different guest name.",
      });
    }
    const reply = await replyToComment({
      parentId: id,
      authorId: null,
      body: String(body.body).slice(0, 4000),
      authorName,
      guest: true,
    });
    if (!reply) return json(404, { error: "not_found" });
    // Feedback feed: a guest reply is activity a watching agent wants too.
    await emitDocEvent({
      docId: reply.docId,
      type: "comment.created",
      actor: `guest:${authorName}`,
      payload: { commentId: reply.id, assignedToAi: false },
    });
    return json(200, { id: reply.id, guest: true });
  }

  // ── Account reply (unchanged) ──────────────────────────────────────────────
  const reply = await replyToComment({
    parentId: id,
    authorId: actor.userId as string,
    body: String(body.body).slice(0, 4000),
  });
  return json(200, { id: reply?.id });
}
