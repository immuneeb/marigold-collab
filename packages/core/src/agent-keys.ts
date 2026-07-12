import { and, eq, isNull } from "drizzle-orm";
import { agentKeys, db, docs } from "@marigold/db";
import type { Role } from "./acl";
import { generateQuickKey, hashQuickKey, verifyQuickKey } from "./quick";

// Doc-scoped agent keys (MUN-74) — the quick key's HTTP simplicity with
// identity anchoring. Same bearer-secret custody as quick keys (22-char
// base62, sha256 at rest, timing-safe verify), but minted BY an identity,
// capped at a role, labeled for attribution, and revocable one-by-one.

/** Roles a key may be capped at — delegation never grants `owner`. */
export type AgentKeyRoleCap = Exclude<Role, "owner">;

const ROLE_ORDER: Role[] = ["viewer", "commenter", "editor", "owner"];

/**
 * Attenuation: the effective role a key confers is the WEAKER of the minter's
 * current role and the key's cap. A minter whose grant was revoked (role null)
 * yields null — their keys die with the grant.
 */
export function attenuate(
  minterRole: Role | null,
  roleCap: AgentKeyRoleCap,
): Role | null {
  if (!minterRole) return null;
  return ROLE_ORDER.indexOf(minterRole) <= ROLE_ORDER.indexOf(roleCap)
    ? minterRole
    : roleCap;
}

export type MintedAgentKey = {
  id: string;
  /** The bearer secret. Returned exactly once, at mint. Never stored. */
  key: string;
};

export type AgentKeyRow = typeof agentKeys.$inferSelect;

/** Reject labels that could impersonate UI affordances; keep them short. */
export function sanitizeAgentKeyLabel(label: unknown): string | null {
  if (typeof label !== "string") return null;
  const trimmed = label.trim().replace(/\s+/g, " ");
  if (trimmed.length < 1 || trimmed.length > 40) return null;
  return trimmed;
}

/**
 * Mint a key for a doc. Caller is responsible for having ALREADY verified the
 * minter's role on the doc and that `roleCap` does not exceed it (attenuation
 * is still re-computed at every auth, so a stale cap can never escalate).
 */
export async function mintAgentKey(input: {
  id: string; // newId("akey") — passed in so core stays id-policy-free
  docId: string;
  minterUserId: string;
  roleCap: AgentKeyRoleCap;
  label: string;
}): Promise<MintedAgentKey> {
  const key = generateQuickKey(); // same 128-bit base62 generator
  await db.insert(agentKeys).values({
    id: input.id,
    docId: input.docId,
    minterUserId: input.minterUserId,
    roleCap: input.roleCap,
    label: input.label,
    keyHash: hashQuickKey(key),
  });
  return { id: input.id, key };
}

/**
 * Resolve a presented bearer key on a doc to its live agent-key row, or null.
 * Constant-time hash compare; revoked keys never resolve. Does NOT compute
 * the effective role — pair with `attenuate(resolveRole(minter), roleCap)`.
 */
export async function resolveAgentKey(
  docId: string,
  presentedKey: string | null | undefined,
): Promise<AgentKeyRow | null> {
  if (!presentedKey) return null;
  const rows = await db
    .select()
    .from(agentKeys)
    .where(
      and(
        eq(agentKeys.docId, docId),
        eq(agentKeys.keyHash, hashQuickKey(presentedKey)),
        isNull(agentKeys.revokedAt),
      ),
    )
    .limit(1);
  const row = rows[0];
  // Re-verify timing-safe against the stored hash (lookup already matched,
  // but keep the same discipline as quick keys).
  if (!row || !verifyQuickKey(presentedKey, row.keyHash)) return null;
  return row;
}

/** Best-effort usage stamp; failures are non-fatal by design. */
export async function touchAgentKey(id: string): Promise<void> {
  try {
    await db
      .update(agentKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(agentKeys.id, id));
  } catch {
    // never block the request on telemetry
  }
}

/**
 * Revoke a key. Allowed for the doc owner (revokes any key on the doc) or the
 * key's own minter. Returns false if the key doesn't exist on this doc or the
 * caller may not revoke it.
 */
export async function revokeAgentKey(
  docId: string,
  keyId: string,
  byUserId: string,
): Promise<boolean> {
  const [row] = await db
    .select()
    .from(agentKeys)
    .where(and(eq(agentKeys.id, keyId), eq(agentKeys.docId, docId)))
    .limit(1);
  if (!row) return false;
  const [doc] = await db
    .select({ ownerId: docs.ownerId })
    .from(docs)
    .where(eq(docs.id, docId))
    .limit(1);
  const isOwner = !!doc?.ownerId && doc.ownerId === byUserId;
  if (!isOwner && row.minterUserId !== byUserId) return false;
  if (row.revokedAt) return true; // idempotent
  await db
    .update(agentKeys)
    .set({ revokedAt: new Date() })
    .where(eq(agentKeys.id, keyId));
  return true;
}

/** All keys on a doc (live and revoked) for the owner's access panel. */
export async function listAgentKeys(docId: string): Promise<AgentKeyRow[]> {
  return db
    .select()
    .from(agentKeys)
    .where(eq(agentKeys.docId, docId))
    .orderBy(agentKeys.createdAt);
}
