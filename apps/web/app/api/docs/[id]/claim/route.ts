import { and, eq, isNull } from "drizzle-orm";
import { config, verifyQuickKey } from "@marigold/core";
import { db, docs } from "@marigold/db";
import { currentActor } from "@/lib/actor";
import { json } from "@/lib/http";
import { requestQuickKey } from "@/lib/quick";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

// Graduation: valid quick key + signed-in session → the doc becomes a standard
// private owned doc. The key hash is nulled (burned) in the same statement, so
// the old ?k= URL stops granting anything — that's the point of claiming.
// Expiry is cleared too: claiming rescues an expired doc — until the daily
// purge job (packages/core purge.ts, PURGE_GRACE_DAYS after expiry) removes it.
export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  const actor = await currentActor();
  if (!actor.userId)
    return json(401, {
      error: "unauthenticated",
      hint: "Claiming needs a signed-in session (the doc joins an account). Sign in at /login, then retry with the key — or open the claimUrl in a browser.",
    });

  const doc = (
    await db.select().from(docs).where(eq(docs.id, id)).limit(1)
  )[0];
  if (!doc)
    return json(404, { error: "not_found", hint: "No doc with this id." });
  // Quarantine is an admin kill switch; claiming must not launder a doc out of
  // it (claim → owner → un-quarantine would hand the abuser the reversal).
  if (doc.quarantined)
    return json(403, {
      error: "quarantined",
      hint: "This doc has been quarantined by an administrator and cannot be claimed.",
    });
  if (doc.ownerId)
    return json(403, {
      error: "already_claimed",
      hint: "This doc already belongs to an account, so it can't be claimed again.",
    });

  const key = requestQuickKey(req);
  if (!verifyQuickKey(key, doc.quickKeyHash))
    return json(401, {
      error: "invalid_key",
      hint: "Claiming requires the doc's quick key (?k= or X-Marigold-Key) — only someone holding the link may claim it.",
    });

  // Guard the race: only claim while still ownerless (first valid claim wins).
  const updated = await db
    .update(docs)
    .set({
      ownerId: actor.userId,
      claimedAt: new Date(),
      expiresAt: null,
      quickKeyHash: null, // burn the key
    })
    .where(and(eq(docs.id, id), isNull(docs.ownerId)))
    .returning({ id: docs.id });
  if (updated.length === 0) {
    // Zero rows can mean two different things — distinguish them so we don't tell
    // a lie. Re-read: if the row is gone, the daily purge removed it between our
    // initial read and this update (grace elapsed), so it can never be claimed
    // again; if it still exists, someone else won the claim race first.
    const still = (
      await db.select({ id: docs.id }).from(docs).where(eq(docs.id, id)).limit(1)
    )[0];
    if (!still)
      return json(410, {
        error: "purged",
        hint: "This doc expired and was permanently removed; it can no longer be claimed.",
      });
    return json(409, {
      error: "claim_conflict",
      hint: "Someone else claimed this doc first.",
    });
  }

  return json(200, {
    ok: true,
    docId: id,
    url: `${config.appOrigin}/d/${doc.slug}`,
    dashboardUrl: `${config.appOrigin}/`,
  });
}
