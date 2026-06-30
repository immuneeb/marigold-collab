import { and, eq, inArray } from "drizzle-orm";
import { db, docs, shares } from "@marigold/db";

export type Role = "owner" | "editor" | "commenter" | "viewer";
export type Action =
  | "view"
  | "comment"
  | "update"
  | "publish"
  | "manage" // manage shares/roles
  | "delete";

// v1 role capability matrix (eng/CEO scoped): editor may update+publish+comment
// but not manage shares or delete; only the owner manages access.
const CAP: Record<Role, Action[]> = {
  owner: ["view", "comment", "update", "publish", "manage", "delete"],
  editor: ["view", "comment", "update", "publish"],
  commenter: ["view", "comment"],
  viewer: ["view"],
};

export function roleCan(role: Role, action: Action): boolean {
  return CAP[role].includes(action);
}

/**
 * The actor's effective role on a doc: owner if they own it, else the role from
 * an ACTIVE share bound to one of their verified emails. null = no access.
 * (Shares are populated in Phase 3; in Phase 1 only `owner` ever resolves.)
 */
export async function resolveRole(
  docId: string,
  userId: string | null,
  verifiedEmails: string[],
): Promise<Role | null> {
  const doc = (
    await db
      .select({ ownerId: docs.ownerId })
      .from(docs)
      .where(eq(docs.id, docId))
      .limit(1)
  )[0];
  if (!doc) return null;
  if (userId && doc.ownerId === userId) return "owner";
  if (verifiedEmails.length === 0) return null;

  const grant = (
    await db
      .select({ role: shares.role })
      .from(shares)
      .where(
        and(
          eq(shares.docId, docId),
          eq(shares.state, "active"),
          inArray(shares.email, verifiedEmails),
        ),
      )
      .limit(1)
  )[0];
  return (grant?.role as Role | undefined) ?? null;
}

export interface Actor {
  userId: string | null;
  verifiedEmails: string[];
}

export async function authorize(
  docId: string,
  actor: Actor,
  action: Action,
): Promise<{ ok: boolean; role: Role | null }> {
  const role = await resolveRole(docId, actor.userId, actor.verifiedEmails);
  if (!role) return { ok: false, role: null };
  return { ok: roleCan(role, action), role };
}
