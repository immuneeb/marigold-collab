import { and, count, eq, inArray, isNull } from "drizzle-orm";
import {
  type AgentKeyRoleCap,
  listAgentKeys,
  mintAgentKey,
  type Role,
  sanitizeAgentKeyLabel,
} from "@marigold/core";
import { agentKeys, db, docs, newId, shares, users } from "@marigold/db";
import { currentActor } from "@/lib/actor";
import type { Actor } from "@/lib/actor";
import { json } from "@/lib/http";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

// Minted agent keys (MUN-74): doc-scoped, role-capped, labeled, revocable
// bearer keys over the same plain HTTP API — post-claim continuity for the
// agent that authored a doc, and a door for grantees to point their own
// agents at shared docs. The bearer secret is returned ONCE at mint; only its
// sha256 is stored. Effective role is re-attenuated at every use, so nothing
// minted here can outlive or exceed the minter's own standing.

const CAPS = ["viewer", "commenter", "editor"] as const;
const RANK: Record<Role, number> = {
  viewer: 0,
  commenter: 1,
  editor: 2,
  owner: 3,
};
const MAX_LIVE_KEYS_PER_DOC = 20;

function isCap(v: unknown): v is AgentKeyRoleCap {
  return typeof v === "string" && (CAPS as readonly string[]).includes(v);
}

/**
 * The caller's minting standing on a doc: owner, or the role of an ACTIVE
 * email grant. Deliberately NOT resolveRole — its public-doc `viewer`
 * fallback would let any signed-in stranger stockpile keys on a public doc.
 * Quarantined docs mint for no one but the owner (who keeps `manage`).
 */
async function minterRole(
  doc: { ownerId: string | null; quarantined: boolean },
  docId: string,
  actor: Actor,
): Promise<Role | null> {
  if (doc.ownerId && doc.ownerId === actor.userId) return "owner";
  if (doc.quarantined || !doc.ownerId) return null;
  if (actor.verifiedEmails.length === 0) return null;
  const grant = (
    await db
      .select({ role: shares.role })
      .from(shares)
      .where(
        and(
          eq(shares.docId, docId),
          eq(shares.state, "active"),
          inArray(shares.email, actor.verifiedEmails),
        ),
      )
      .limit(1)
  )[0];
  return (grant?.role as Role | undefined) ?? null;
}

export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  const actor = await currentActor();
  if (!actor.userId)
    return json(401, {
      error: "unauthenticated",
      hint: "Minting an agent key needs a signed-in session; the key inherits (at most) your role on the doc.",
    });

  const doc = (
    await db
      .select({ ownerId: docs.ownerId, quarantined: docs.quarantined })
      .from(docs)
      .where(eq(docs.id, id))
      .limit(1)
  )[0];
  if (!doc) return json(404, { error: "not_found" });
  if (!doc.ownerId)
    return json(403, {
      error: "unclaimed",
      hint: "Unclaimed quick docs already have a full-capability ?k= key. Claim the doc first, then mint agent keys.",
    });

  const role = await minterRole(doc, id, actor);
  if (!role) return json(403, { error: "forbidden" });

  let body: { label?: unknown; roleCap?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }
  const label = sanitizeAgentKeyLabel(body.label);
  if (!label)
    return json(400, {
      error: "invalid_label",
      hint: "Label the key for attribution: 1-40 characters, e.g. \"my agent\".",
    });
  if (!isCap(body.roleCap))
    return json(400, {
      error: "invalid_role_cap",
      hint: "roleCap must be viewer, commenter, or editor — a key never confers owner.",
    });
  // A minter can't cap a key above their own role (owner mints up to editor).
  // Attenuation re-checks at every auth, so this is UX honesty, not the
  // security boundary — a stale cap can never escalate.
  if (RANK[body.roleCap] > RANK[role])
    return json(403, {
      error: "role_cap_exceeds_role",
      hint: `Your role on this doc is ${role}; you can't mint a ${body.roleCap}-capped key.`,
    });

  // Cheap abuse valve: cap live keys per doc.
  const live = (
    await db
      .select({ n: count() })
      .from(agentKeys)
      .where(and(eq(agentKeys.docId, id), isNull(agentKeys.revokedAt)))
  )[0];
  if ((live?.n ?? 0) >= MAX_LIVE_KEYS_PER_DOC)
    return json(429, {
      error: "too_many_keys",
      hint: `This doc already has ${MAX_LIVE_KEYS_PER_DOC} live agent keys. Revoke one first.`,
    });

  const minted = await mintAgentKey({
    id: newId("akey"),
    docId: id,
    minterUserId: actor.userId,
    roleCap: body.roleCap,
    label,
  });
  // The bearer secret appears here and nowhere else, ever.
  return json(200, {
    id: minted.id,
    key: minted.key,
    label,
    roleCap: body.roleCap,
  });
}

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  const actor = await currentActor();
  if (!actor.userId) return json(401, { error: "forbidden" });

  const doc = (
    await db
      .select({ ownerId: docs.ownerId, quarantined: docs.quarantined })
      .from(docs)
      .where(eq(docs.id, id))
      .limit(1)
  )[0];
  if (!doc) return json(404, { error: "not_found" });

  const role = await minterRole(doc, id, actor);
  if (!role) return json(403, { error: "forbidden" });

  // Owner sees every key on the doc; a grantee sees only keys they minted.
  const rows = (await listAgentKeys(id)).filter(
    (k) => role === "owner" || k.minterUserId === actor.userId,
  );

  // Attribution: resolve minter ids to display fields (never the key hash).
  const minterIds = [...new Set(rows.map((k) => k.minterUserId))];
  const minters = minterIds.length
    ? await db
        .select({
          id: users.id,
          name: users.displayName,
          email: users.primaryEmail,
        })
        .from(users)
        .where(inArray(users.id, minterIds))
    : [];
  const minterById = new Map(minters.map((m) => [m.id, m]));

  return json(200, {
    keys: rows.map((k) => ({
      id: k.id,
      label: k.label,
      roleCap: k.roleCap,
      minter: minterById.get(k.minterUserId) ?? { id: k.minterUserId },
      createdAt: k.createdAt,
      revokedAt: k.revokedAt,
      lastUsedAt: k.lastUsedAt,
    })),
  });
}
