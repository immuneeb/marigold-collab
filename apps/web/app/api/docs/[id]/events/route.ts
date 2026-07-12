import { eq } from "drizzle-orm";
import { authorize, headSeq, touchAgentKey, waitForEvents } from "@marigold/core";
import { db, docs } from "@marigold/db";
import { currentActor } from "@/lib/actor";
import { json } from "@/lib/http";
import { resolveAgentKeyAuth } from "@/lib/key-access";
import { quickAccess, requestQuickKey } from "@/lib/quick";

export const runtime = "nodejs";
// A long poll can hold the function up to `wait` (≤50s) — lift the default
// serverless cap so the connection isn't killed mid-poll.
export const maxDuration = 60;

type Params = { params: Promise<{ id: string }> };

const MAX_WAIT_S = 50;

// Long-poll feedback feed for scripted/HTTP agents (the MCP `get_feedback` tool
// is the same feed for MCP clients). View access, mirroring the content GET:
// a live quick key (the edit capability of an unclaimed doc) OR a session with
// an ACL view grant. `?since=SEQ` is the cursor (`latest` = start from now);
// `?wait=N` blocks up to N seconds for the first event, returning the moment
// events land — or an empty list on timeout.
export async function GET(req: Request, { params }: Params) {
  const { id } = await params;
  const doc = (
    await db.select().from(docs).where(eq(docs.id, id)).limit(1)
  )[0];
  if (!doc)
    return json(404, { error: "not_found", hint: "No doc with this id." });
  if (doc.quarantined)
    return json(403, {
      error: "quarantined",
      hint: "This doc has been quarantined by an administrator.",
    });

  // Auth: a live quick key grants view; on owned docs a minted agent key does
  // too (every attenuated role can at least view — MUN-74, the post-claim
  // feedback loop); otherwise fall back to the account ACL.
  const key = requestQuickKey(req);
  const access = quickAccess(doc, key);
  if (access !== "granted") {
    let agentGranted = false;
    if (doc.ownerId && key && access === "claimed") {
      const agent = await resolveAgentKeyAuth(id, key);
      if (agent) {
        void touchAgentKey(agent.keyId);
        agentGranted = true;
      }
    }
    if (!agentGranted) {
      const actor = await currentActor();
      const { ok } = await authorize(id, actor, "view");
      if (!ok) {
        if (key && access === "expired")
          return json(410, { error: "expired" });
        if (key && access === "claimed")
          return json(403, { error: "claimed" });
        if (key) return json(401, { error: "invalid_key" });
        return json(actor.userId ? 403 : 401, { error: "forbidden" });
      }
    }
  }

  const url = new URL(req.url);
  const sinceParam = url.searchParams.get("since") ?? "0";
  const wait = Math.min(
    Math.max(Number(url.searchParams.get("wait") ?? "0") || 0, 0),
    MAX_WAIT_S,
  );

  // `since=latest` starts the cursor at the current head, so only events created
  // after this request are returned.
  let since: number;
  if (sinceParam === "latest") {
    since = await headSeq(id);
  } else {
    const n = Number.parseInt(sinceParam, 10);
    since = Number.isFinite(n) && n >= 0 ? n : 0;
  }

  // Shared long-poll loop; `latest` is the race-safe resume cursor (last
  // delivered seq, or `since` when caught up — never skips an event).
  const { events, latest } = await waitForEvents({
    docId: id,
    sinceSeq: since,
    waitMs: wait * 1000,
    signal: req.signal,
  });
  return json(200, { events, latest });
}
