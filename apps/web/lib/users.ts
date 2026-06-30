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
    await db
      .update(shares)
      .set({ state: "active", boundUserId: userId })
      .where(and(eq(shares.email, normalized), eq(shares.state, "pending")));
  }

  return { id: userId };
}
