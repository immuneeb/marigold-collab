import { and, asc, eq, inArray, sql } from "drizzle-orm";
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
  assignedToAi: boolean;
  viaAssistant: boolean;
  // Authored by a quick-doc URL holder (no account) under a self-supplied name.
  guest: boolean;
  createdAt: Date;
}

/**
 * Normalize a guest-supplied display name to plain text: strip control/format
 * chars and angle brackets, collapse whitespace, trim. Returns null unless the
 * result is 1–40 chars — the caller turns that into a 400 `author_required`.
 */
export function sanitizeGuestName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw
    .replace(/[\p{C}<>]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length < 1 || cleaned.length > 40) return null;
  return cleaned;
}

/**
 * Impersonation guard for guest comments: is `name` already an account's
 * display name (case-insensitive)? A guest may not adopt a real user's name.
 */
export async function displayNameInUse(name: string): Promise<boolean> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.displayName}) = lower(${name})`)
    .limit(1);
  return rows.length > 0;
}

/**
 * Second impersonation guard: is `name` already used by a GUEST on this doc?
 * Without it, a second link-holder could post under an existing guest's name,
 * so a reader can't tell two people apart. Case-insensitive, this doc only.
 */
export async function guestNameInUseOnDoc(
  docId: string,
  name: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: comments.id })
    .from(comments)
    .where(
      sql`${comments.docId} = ${docId} and ${comments.guest} = true and lower(${comments.authorName}) = lower(${name})`,
    )
    .limit(1);
  return rows.length > 0;
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
  // Null for a guest (quick-doc) author; their name lives in `authorName`.
  authorId: string | null;
  versionId: string;
  anchor: unknown;
  body: string;
  authorName?: string | null;
  guest?: boolean;
}): Promise<string> {
  const id = newId("cmt");
  await db.insert(comments).values({
    id,
    docId: opts.docId,
    anchoredVersionId: opts.versionId,
    parentId: null,
    authorId: opts.authorId,
    authorName: opts.authorName ?? null,
    guest: opts.guest ?? false,
    body: opts.body,
    anchor: opts.anchor,
    status: "open",
  });
  return id;
}

export async function replyToComment(opts: {
  parentId: string;
  // Null for a guest (quick-doc) reply; their name lives in `authorName`.
  authorId: string | null;
  body: string;
  viaAssistant?: boolean;
  authorName?: string | null;
  guest?: boolean;
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
    authorName: opts.authorName ?? null,
    guest: opts.guest ?? false,
    body: opts.body,
    anchor: parent.anchor,
    status: "open",
    viaAssistant: opts.viaAssistant ?? false,
  });
  return { id, docId: parent.docId };
}

export async function listComments(
  docId: string,
  filter?: { status?: string; assignedToAi?: boolean; ids?: string[] },
): Promise<CommentRow[]> {
  // `ids` empty means "no comments requested" — short-circuit rather than emit a
  // vacuous `IN ()` that some drivers reject or that scans the whole doc.
  if (filter?.ids && filter.ids.length === 0) return [];
  const conds = [eq(comments.docId, docId)];
  if (filter?.status) conds.push(eq(comments.status, filter.status));
  if (filter?.assignedToAi !== undefined)
    conds.push(eq(comments.assignedToAi, filter.assignedToAi));
  if (filter?.ids) conds.push(inArray(comments.id, filter.ids));
  return db
    .select({
      id: comments.id,
      parentId: comments.parentId,
      anchoredVersionId: comments.anchoredVersionId,
      authorId: comments.authorId,
      // Account authors show their profile name; guests show the name they
      // supplied (stored on the comment) — coalesce picks whichever is set.
      authorName: sql<
        string | null
      >`coalesce(${users.displayName}, ${comments.authorName})`,
      body: comments.body,
      anchor: comments.anchor,
      status: comments.status,
      assignedToAi: comments.assignedToAi,
      viaAssistant: comments.viaAssistant,
      guest: comments.guest,
      createdAt: comments.createdAt,
    })
    .from(comments)
    .leftJoin(users, eq(comments.authorId, users.id))
    .where(and(...conds))
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
          assignedToAi: comments.assignedToAi,
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

export async function setCommentAiAssignment(
  commentId: string,
  assigned: boolean,
  byUserId: string | null,
): Promise<void> {
  await db
    .update(comments)
    .set({
      assignedToAi: assigned,
      aiAssignedAt: assigned ? new Date() : null,
      aiAssignedBy: assigned ? byUserId : null,
      updatedAt: new Date(),
    })
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
