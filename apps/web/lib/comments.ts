import { and, asc, eq } from "drizzle-orm";
import { comments, db, docVersions, newId, users } from "@marigold/db";

export interface CommentRow {
  id: string;
  parentId: string | null;
  anchoredVersionId: string | null;
  authorId: string | null;
  authorName: string | null;
  body: string;
  anchor: unknown;
  status: string;
  createdAt: Date;
}

/** Is `versionId` a version of `docId`? (validates comment anchoring target) */
export async function versionBelongsToDoc(
  docId: string,
  versionId: string,
): Promise<boolean> {
  const v = (
    await db
      .select({ id: docVersions.id })
      .from(docVersions)
      .where(and(eq(docVersions.id, versionId), eq(docVersions.docId, docId)))
      .limit(1)
  )[0];
  return !!v;
}

export async function createComment(opts: {
  docId: string;
  authorId: string;
  versionId: string;
  anchor: unknown;
  body: string;
}): Promise<string> {
  const id = newId("cmt");
  await db.insert(comments).values({
    id,
    docId: opts.docId,
    anchoredVersionId: opts.versionId,
    parentId: null,
    authorId: opts.authorId,
    body: opts.body,
    anchor: opts.anchor,
    status: "open",
  });
  return id;
}

export async function replyToComment(opts: {
  parentId: string;
  authorId: string;
  body: string;
}): Promise<{ id: string; docId: string } | null> {
  const parent = (
    await db
      .select()
      .from(comments)
      .where(eq(comments.id, opts.parentId))
      .limit(1)
  )[0];
  if (!parent) return null;
  const id = newId("cmt");
  await db.insert(comments).values({
    id,
    docId: parent.docId,
    anchoredVersionId: parent.anchoredVersionId,
    parentId: parent.id,
    authorId: opts.authorId,
    body: opts.body,
    anchor: parent.anchor,
    status: "open",
  });
  return { id, docId: parent.docId };
}

export async function listComments(
  docId: string,
  status?: string,
): Promise<CommentRow[]> {
  const where = status
    ? and(eq(comments.docId, docId), eq(comments.status, status))
    : eq(comments.docId, docId);
  return db
    .select({
      id: comments.id,
      parentId: comments.parentId,
      anchoredVersionId: comments.anchoredVersionId,
      authorId: comments.authorId,
      authorName: users.displayName,
      body: comments.body,
      anchor: comments.anchor,
      status: comments.status,
      createdAt: comments.createdAt,
    })
    .from(comments)
    .leftJoin(users, eq(comments.authorId, users.id))
    .where(where)
    .orderBy(asc(comments.createdAt));
}

export async function getComment(commentId: string) {
  return (
    (
      await db
        .select({
          id: comments.id,
          docId: comments.docId,
          authorId: comments.authorId,
          parentId: comments.parentId,
          status: comments.status,
        })
        .from(comments)
        .where(eq(comments.id, commentId))
        .limit(1)
    )[0] ?? null
  );
}

export async function setCommentStatus(
  commentId: string,
  status: "open" | "resolved",
): Promise<void> {
  await db
    .update(comments)
    .set({ status, updatedAt: new Date() })
    .where(eq(comments.id, commentId));
}

export async function editCommentBody(
  commentId: string,
  body: string,
): Promise<void> {
  await db
    .update(comments)
    .set({ body, updatedAt: new Date() })
    .where(eq(comments.id, commentId));
}
