import { and, eq } from "drizzle-orm";
import { db, userEmails } from "@marigold/db";
import { auth } from "@/auth";

export interface Actor {
  userId: string | null;
  verifiedEmails: string[];
}

async function verifiedEmailsFor(userId: string): Promise<string[]> {
  const rows = await db
    .select({ email: userEmails.email })
    .from(userEmails)
    .where(and(eq(userEmails.userId, userId), eq(userEmails.verified, true)));
  return rows.map((r) => r.email);
}

/** The signed-in actor: their user id + verified emails (for ACL/share matching). */
export async function currentActor(): Promise<Actor> {
  const session = await auth();
  const userId = session?.user?.id ?? null;
  if (!userId) return { userId: null, verifiedEmails: [] };
  return { userId, verifiedEmails: await verifiedEmailsFor(userId) };
}

/** Actor for a userId resolved out-of-band (e.g. from an MCP access token). */
export async function actorForUserId(userId: string): Promise<Actor> {
  return { userId, verifiedEmails: await verifiedEmailsFor(userId) };
}
