import { and, eq } from "drizzle-orm";
import { db, docs, newId, shares, userEmails } from "@marigold/db";
import { normalizeEmail } from "./email";

const ROLES = ["viewer", "commenter", "editor"] as const;
export type ShareRole = (typeof ROLES)[number];

export function isRole(r: string): r is ShareRole {
  return (ROLES as readonly string[]).includes(r);
}

/**
 * Grant access by email. If a verified user already owns the (normalized) email,
 * bind immediately (active); otherwise the grant is pending until they sign in.
 */
export async function upsertShare(opts: {
  docId: string;
  email: string;
  role: ShareRole;
  invitedBy: string;
}): Promise<{ email: string; state: "pending" | "active" }> {
  const email = normalizeEmail(opts.email);

  const owner = (
    await db
      .select({ userId: userEmails.userId })
      .from(userEmails)
      .where(and(eq(userEmails.email, email), eq(userEmails.verified, true)))
      .limit(1)
  )[0];
  const state: "pending" | "active" = owner ? "active" : "pending";
  const boundUserId = owner?.userId ?? null;

  await db
    .insert(shares)
    .values({
      id: newId("shr"),
      docId: opts.docId,
      email,
      role: opts.role,
      state,
      invitedBy: opts.invitedBy,
      boundUserId,
    })
    .onConflictDoUpdate({
      target: [shares.docId, shares.email],
      set: { role: opts.role, state, boundUserId },
    });

  return { email, state };
}

export async function listShares(docId: string) {
  return db
    .select({
      id: shares.id,
      email: shares.email,
      role: shares.role,
      state: shares.state,
    })
    .from(shares)
    .where(eq(shares.docId, docId))
    .orderBy(shares.createdAt);
}

export async function changeShareRole(
  shareId: string,
  role: ShareRole,
): Promise<void> {
  await db.update(shares).set({ role }).where(eq(shares.id, shareId));
}

export async function revokeShare(shareId: string): Promise<void> {
  await db.delete(shares).where(eq(shares.id, shareId));
}

/** The doc + its owner for a share row — used to authorize share management. */
export async function docOwnerForShare(shareId: string) {
  return (
    (
      await db
        .select({ docId: shares.docId, ownerId: docs.ownerId })
        .from(shares)
        .innerJoin(docs, eq(shares.docId, docs.id))
        .where(eq(shares.id, shareId))
        .limit(1)
    )[0] ?? null
  );
}
