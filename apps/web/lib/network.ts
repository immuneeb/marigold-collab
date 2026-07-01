import { and, eq } from "drizzle-orm";
import { db, networkGrants } from "@marigold/db";

/** Normalize to a bare origin `scheme://host[:port]`, or null if invalid. */
export function normalizeOrigin(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

export async function listNetworkGrants(docId: string) {
  return db
    .select({ origin: networkGrants.origin })
    .from(networkGrants)
    .where(eq(networkGrants.docId, docId));
}

export async function addNetworkGrant(
  docId: string,
  origin: string,
  userId: string,
): Promise<void> {
  await db
    .insert(networkGrants)
    .values({ docId, origin, approvedBy: userId })
    .onConflictDoNothing();
}

export async function removeNetworkGrant(
  docId: string,
  origin: string,
): Promise<void> {
  await db
    .delete(networkGrants)
    .where(and(eq(networkGrants.docId, docId), eq(networkGrants.origin, origin)));
}
