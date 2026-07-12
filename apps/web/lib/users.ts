import { and, eq } from "drizzle-orm";
import { db, newId, shares, userEmails, users } from "@marigold/db";
import { normalizeEmail } from "./email";

export interface SignInInfo {
  authSub: string; // "google|<sub>" or "dev|<email>"
  email: string;
  emailVerified: boolean;
  name: string | null;
}

/**
 * The user id (if any) that already holds this address as a VERIFIED email.
 * Magic-link sign-in uses this to sign in AS the existing owner rather than
 * minting a duplicate `email|<addr>` account (which would collide with the
 * verified-email unique index and degrade the address to unverified). Null when
 * no verified holder exists — the caller then falls back to the email identity.
 */
export async function findVerifiedEmailOwnerId(
  email: string,
): Promise<string | null> {
  const normalized = normalizeEmail(email);
  const [row] = await db
    .select({ userId: userEmails.userId })
    .from(userEmails)
    .where(and(eq(userEmails.email, normalized), eq(userEmails.verified, true)))
    .limit(1);
  return row?.userId ?? null;
}

/** Flip this user's pending shares for a now-verified address to active. Shared
 * by upsertUserOnSignIn and the magic-link "sign in as existing owner" path. */
export async function bindVerifiedEmailShares(
  userId: string,
  email: string,
): Promise<void> {
  const normalized = normalizeEmail(email);
  await db
    .update(shares)
    .set({ state: "active", boundUserId: userId })
    .where(and(eq(shares.email, normalized), eq(shares.state, "pending")));
}

/**
 * Idempotent on every sign-in: upsert the user by auth subject, then record the
 * normalized email and its verified state. The verified-email partial unique
 * index can reject a cross-user claim of an already-verified address; we degrade
 * that to an unverified row rather than break the whole sign-in.
 */
export async function upsertUserOnSignIn(
  info: SignInInfo,
): Promise<{ id: string }> {
  const normalized = normalizeEmail(info.email);

  const rows = await db
    .insert(users)
    .values({
      id: newId("usr"),
      authSub: info.authSub,
      primaryEmail: info.email,
      displayName: info.name,
    })
    .onConflictDoUpdate({
      target: users.authSub,
      set: { primaryEmail: info.email, displayName: info.name },
    })
    .returning({ id: users.id });

  const row = rows[0];
  if (!row) throw new Error("user upsert returned no row");
  const userId = row.id;

  try {
    await db
      .insert(userEmails)
      .values({ userId, email: normalized, verified: info.emailVerified })
      .onConflictDoUpdate({
        target: [userEmails.userId, userEmails.email],
        set: { verified: info.emailVerified },
      });
  } catch {
    // Another user already owns this address as verified. Keep an unverified row.
    console.warn(`[auth] email already claimed verified elsewhere: ${normalized}`);
    await db
      .insert(userEmails)
      .values({ userId, email: normalized, verified: false })
      .onConflictDoNothing();
  }

  // Bind pending shares for this newly-verified email -> active.
  if (info.emailVerified) {
    await bindVerifiedEmailShares(userId, normalized);
  }

  return { id: userId };
}
