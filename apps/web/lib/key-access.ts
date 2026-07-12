import { eq } from "drizzle-orm";
import {
  type AgentKeyRoleCap,
  attenuate,
  authorize,
  resolveAgentKey,
  resolveRole,
  type Role,
  roleCan,
  touchAgentKey,
} from "@marigold/core";
import { db, docs } from "@marigold/db";
import { type Actor, actorForUserId } from "@/lib/actor";
import { json } from "@/lib/http";
import { quickKeyGrants, requestQuickKey } from "@/lib/quick";

// Bearer-key access resolution for the doc write routes (MUN-67 substrate,
// MUN-74 agent keys). One doc, two key kinds, mutually exclusive by doc state:
//
//   unclaimed doc + live quick key  → full edit capability (the ?k= URL)
//   owned doc     + minted agent key → attenuated role: min(minter's CURRENT
//                                      role, key's roleCap), recomputed here
//                                      at EVERY auth — revoking the minter's
//                                      grant kills their keys instantly.
//
// A burned quick key can never fall through to the agent path: agent keys are
// looked up by hash in `agent_keys`, where a quick key's hash never lives.

type DocRow = typeof docs.$inferSelect;

const AGENT_KEY_CAPS: readonly string[] = ["viewer", "commenter", "editor"];

export interface AgentKeyAuth {
  keyId: string;
  label: string;
  minterUserId: string;
  /** Attenuated effective role: min(minter's current role, roleCap). */
  role: Role;
}

/**
 * Resolve a presented bearer key as a live agent key on this doc and compute
 * its effective role. Returns null when the key doesn't resolve, is revoked,
 * or the minter no longer holds any role on the doc (attenuation to null).
 */
export async function resolveAgentKeyAuth(
  docId: string,
  presentedKey: string | null,
): Promise<AgentKeyAuth | null> {
  const row = await resolveAgentKey(docId, presentedKey);
  if (!row) return null;
  if (!AGENT_KEY_CAPS.includes(row.roleCap)) return null; // defensive: bad row
  const minter = await actorForUserId(row.minterUserId);
  const minterRole = await resolveRole(
    docId,
    row.minterUserId,
    minter.verifiedEmails,
  );
  const role = attenuate(minterRole, row.roleCap as AgentKeyRoleCap);
  if (!role) return null;
  return {
    keyId: row.id,
    label: row.label,
    minterUserId: row.minterUserId,
    role,
  };
}

export type DocWriteAccess =
  | { mode: "session" }
  | { mode: "quick" }
  | ({ mode: "agent" } & AgentKeyAuth)
  | { mode: "denied"; response: Response };

/**
 * The shared "may this request mutate this doc?" gate (MUN-67): session ACL,
 * else quick key on a live unclaimed doc, else agent key on an owned doc.
 * Status semantics preserved exactly from the routes this was extracted from:
 * missing doc, quarantined doc, and bad/absent key all collapse to
 * 403 (signed-in) / 401 (signed-out) `forbidden` — a prober without a valid
 * key learns nothing. A VALID agent key whose effective role can't perform
 * `action` gets an explanatory 403 (its holder already proved possession).
 */
export async function resolveDocWriteAccess(
  req: Request,
  docId: string,
  actor: Actor,
  action: "update" | "delete" = "update",
): Promise<DocWriteAccess> {
  const { ok } = await authorize(docId, actor, action);
  if (ok) return { mode: "session" };

  const deny = (): DocWriteAccess => ({
    mode: "denied",
    response: json(actor.userId ? 403 : 401, { error: "forbidden" }),
  });

  const doc = (
    await db.select().from(docs).where(eq(docs.id, docId)).limit(1)
  )[0];
  if (!doc || doc.quarantined) return deny();

  const key = requestQuickKey(req);
  // Unclaimed doc: a live quick key IS the doc's full edit capability —
  // including delete (whoever holds the URL owns the draft's fate).
  if (quickKeyGrants(doc, key)) return { mode: "quick" };

  // Owned doc: try a minted agent key. Enforce the capability matrix on the
  // ATTENUATED role — a commenter-capped key can never update.
  if (doc.ownerId && key) {
    const agent = await resolveAgentKeyAuth(docId, key);
    if (agent) {
      if (!roleCan(agent.role, action)) {
        return {
          mode: "denied",
          response: json(403, {
            error: "forbidden",
            hint: `This agent key's effective role (${agent.role}) does not allow ${action}.`,
          }),
        };
      }
      void touchAgentKey(agent.keyId); // usage stamp; never blocks the request
      return { mode: "agent", ...agent };
    }
  }
  return deny();
}

/**
 * TOCTOU re-check for write routes: after the request body has arrived, the
 * key must STILL grant access — the doc may have been claimed (quick key
 * burned) or the agent key revoked while the body uploaded. This re-verify
 * under a fresh read was a security fix (MUN-67 context); keep it on every
 * key-authed write. Session access needs no re-check (the ACL was not
 * key-derived). Pass `freshDoc` when the route just re-read the doc anyway.
 */
export async function recheckDocWriteAccess(
  req: Request,
  docId: string,
  access: DocWriteAccess,
  freshDoc?: DocRow,
): Promise<Response | null> {
  if (access.mode === "quick") {
    const doc =
      freshDoc ??
      (await db.select().from(docs).where(eq(docs.id, docId)).limit(1))[0];
    if (!doc || !quickKeyGrants(doc, requestQuickKey(req))) {
      return json(403, {
        error: "claimed",
        hint: "The doc was claimed; the quick key no longer grants access.",
      });
    }
    return null;
  }
  if (access.mode === "agent") {
    // Full re-resolution: catches a key revoked mid-flight AND a minter whose
    // grant was revoked mid-flight (attenuation re-computes to null).
    const agent = await resolveAgentKeyAuth(docId, requestQuickKey(req));
    if (!agent || !roleCan(agent.role, "update")) {
      return json(403, {
        error: "key_revoked",
        hint: "This agent key no longer grants update access to this doc.",
      });
    }
    return null;
  }
  return null;
}
