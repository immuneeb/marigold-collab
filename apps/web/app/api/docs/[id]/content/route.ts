import { and, eq, isNull } from "drizzle-orm";
import {
  AgentKeyRevokedError,
  authorize,
  deinstrumentHtml,
  DocClaimedError,
  getBlobStore,
  IngestError,
  quickDocExpiry,
  roleCan,
  touchAgentKey,
  updateDoc,
} from "@marigold/core";
import { db, docs, docVersions } from "@marigold/db";
import { currentActor } from "@/lib/actor";
import { emitDocEvent } from "@/lib/events";
import { json } from "@/lib/http";
import { resolveAgentKeyAuth } from "@/lib/key-access";
import { quickAccess, requestQuickKey } from "@/lib/quick";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

// Content as JSON — the agent-facing read/write surface for quick docs
// (see /agents.md). GET also accepts a normal session (any viewer role).
// PUT accepts the quick key while the doc is unclaimed, and — post-claim —
// a minted agent key (MUN-74) whose attenuated role can update. Owned docs
// otherwise update via PATCH /api/docs/:id or MCP, exactly as before.

function ingestStatus(code: string): number {
  return code === "too_large" || code === "too_many_files" ? 413 : 400;
}

const HINTS = {
  claimed:
    "This doc belongs to an account, so the quick key is burned and grants nothing. The owner works with it signed in (dashboard, PATCH /api/docs/:id, or MCP at /api/mcp) — or mints an agent key (POST /api/docs/:id/agent-keys) for continued API access.",
  expired:
    "This unclaimed quick doc has expired (~30 days after its last write). Sign in and claim it — POST /api/docs/:id/claim with the key — to restore and keep it, or create a fresh doc via POST /api/quick.",
  invalid_key:
    "The key doesn't match this doc. Pass the editKey from POST /api/quick as ?k=<key> or the X-Marigold-Key header.",
  key_required:
    "Writes need the doc's edit key: ?k=<key> or the X-Marigold-Key header. Keys come from POST /api/quick; claimed docs are edited through the owner's account or a minted agent key.",
};

async function versionPayload(
  versionId: string,
  title: string | null,
  keepIds = false,
) {
  const store = getBlobStore();
  const manifest = await store.getManifest(versionId);
  const sha = manifest?.["index.html"];
  const bytes = sha ? await store.getBlob(sha) : null;
  if (!bytes) return null;
  const version = (
    await db
      .select({ ordinal: docVersions.ordinal })
      .from(docVersions)
      .where(eq(docVersions.id, versionId))
      .limit(1)
  )[0];
  const raw = new TextDecoder().decode(bytes);
  return {
    // keepIds keeps each element's data-marigold-id so the caller can target
    // it with POST /api/docs/:id/patch; default returns clean HTML.
    html: keepIds ? raw : deinstrumentHtml(raw),
    title,
    versionId,
    ordinal: version?.ordinal ?? null,
  };
}

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

  const key = requestQuickKey(req);
  const access = quickAccess(doc, key);
  // ?includeIds=1 returns instrumented HTML (marigold-ids intact) so the caller
  // can target elements with POST /api/docs/:id/patch.
  const includeIds =
    new URL(req.url).searchParams.get("includeIds") === "1";

  // A live quick key reads the working draft (the key IS the edit capability).
  if (access === "granted") {
    const versionId = doc.latestVersionId ?? doc.publishedVersionId;
    if (!versionId)
      return json(404, { error: "no_content", hint: "Doc has no versions yet." });
    const payload = await versionPayload(versionId, doc.title, includeIds);
    if (!payload) return json(404, { error: "content_missing" });
    // Surface the pinned theme so an agent knows it can send content-only writes.
    return json(200, { ...payload, theme: doc.theme, themeVersion: doc.themeVersion });
  }

  // Owned doc + minted agent key (MUN-74): the attenuated role decides what it
  // reads — update-capable keys see the working draft (and may keep marigold
  // ids for patching); read-only keys see the published version, like the ACL.
  if (doc.ownerId && key) {
    const agent = await resolveAgentKeyAuth(id, key);
    if (agent) {
      void touchAgentKey(agent.keyId);
      const canUpdate = roleCan(agent.role, "update");
      const versionId = canUpdate
        ? (doc.latestVersionId ?? doc.publishedVersionId)
        : doc.publishedVersionId;
      if (!versionId)
        return json(404, { error: "no_content", hint: "Doc has no published version." });
      const payload = await versionPayload(
        versionId,
        doc.title,
        includeIds && canUpdate,
      );
      if (!payload) return json(404, { error: "content_missing" });
      return json(200, { ...payload, theme: doc.theme, themeVersion: doc.themeVersion });
    }
  }

  // Otherwise the normal account ACL — unchanged from every other endpoint.
  const actor = await currentActor();
  const { ok, role } = await authorize(id, actor, "view");
  if (!ok) {
    if (key && access === "expired")
      return json(410, { error: "expired", hint: HINTS.expired });
    if (key && access === "claimed")
      return json(403, { error: "claimed", hint: HINTS.claimed });
    if (key)
      return json(401, { error: "invalid_key", hint: HINTS.invalid_key });
    return json(actor.userId ? 403 : 401, {
      error: "forbidden",
      hint: "Sign in with an account that has access, or pass the doc's quick key (?k= / X-Marigold-Key) if it is unclaimed.",
    });
  }
  const canUpdate = !!role && roleCan(role, "update");
  const versionId = canUpdate
    ? (doc.latestVersionId ?? doc.publishedVersionId)
    : doc.publishedVersionId;
  if (!versionId)
    return json(404, { error: "no_content", hint: "Doc has no published version." });
  // Ids only for update-capable roles (they're the ones who can patch).
  const payload = await versionPayload(versionId, doc.title, includeIds && canUpdate);
  if (!payload) return json(404, { error: "content_missing" });
  return json(200, { ...payload, theme: doc.theme, themeVersion: doc.themeVersion });
}

export async function PUT(req: Request, { params }: Params) {
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

  const key = requestQuickKey(req);
  if (!key) return json(401, { error: "key_required", hint: HINTS.key_required });
  const access = quickAccess(doc, key);
  // Owned doc (or burned key): a minted agent key may write instead (MUN-74).
  // A burned quick key can't sneak through here — agent keys are looked up by
  // hash in agent_keys, where a quick key's hash never lives.
  let agent: Awaited<ReturnType<typeof resolveAgentKeyAuth>> = null;
  if (access === "claimed") {
    if (doc.ownerId) agent = await resolveAgentKeyAuth(id, key);
    if (!agent)
      return json(403, { error: "claimed", hint: HINTS.claimed });
    if (!roleCan(agent.role, "update"))
      return json(403, {
        error: "forbidden",
        hint: `This agent key's effective role (${agent.role}) does not allow update.`,
      });
  }
  if (access === "invalid_key")
    return json(401, { error: "invalid_key", hint: HINTS.invalid_key });
  if (access === "expired")
    return json(410, { error: "expired", hint: HINTS.expired });

  let body: { html?: string; title?: string };
  try {
    body = await req.json();
  } catch {
    return json(400, {
      error: "invalid_json",
      hint: 'Send JSON: {"html": "<full replacement page>", "title": "optional"}.',
    });
  }
  if (typeof body.html !== "string" || body.html.length === 0) {
    return json(400, {
      error: "html_required",
      hint: "PUT replaces the whole page: provide `html` (≤2MB, self-contained).",
    });
  }

  // Agent-key TOCTOU re-check: the key (or the minter's grant) may have been
  // revoked while the body uploaded — re-resolve under a fresh read. (The
  // quick-key path's equivalent is updateDoc's requireUnclaimed CAS.)
  if (agent) {
    const fresh = await resolveAgentKeyAuth(id, key);
    if (!fresh || !roleCan(fresh.role, "update"))
      return json(403, {
        error: "key_revoked",
        hint: "This agent key no longer grants update access to this doc.",
      });
    void touchAgentKey(fresh.keyId);
  }

  try {
    const result = await updateDoc({
      docId: id,
      html: body.html,
      title: typeof body.title === "string" ? body.title : undefined,
      assistant: agent ? "agent-key" : "quick-api",
      // Quick-key writes must fail if the doc was claimed mid-flight; agent
      // keys only exist on owned docs, so the guard would always trip there.
      requireUnclaimed: !agent,
      // Agent-key writes: re-check the key is still live under the write lock —
      // revocation between the TOCTOU recheck above and commit → 403 key_revoked.
      requireAgentKeyLive: agent ? agent.keyId : undefined,
    });
    if (agent) {
      // Owned docs never expire — no expiry stamp on the agent-key path.
      if (!result.unchanged)
        await emitDocEvent({
          docId: id,
          type: "content.replaced",
          actor: agent.minterUserId,
          payload: {
            versionId: result.versionId,
            ordinal: result.ordinal,
            agentKey: agent.label,
          },
        });
      return json(200, {
        versionId: result.versionId,
        ordinal: result.ordinal,
        unchanged: result.unchanged,
      });
    }
    // Rolling expiry: every successful unclaimed write buys another 30 days.
    // Guarded on ownerId IS NULL so a claim landing mid-request can never get
    // an expiry re-stamped onto the now-owned doc.
    const expiresAt = quickDocExpiry();
    await db
      .update(docs)
      .set({ expiresAt })
      .where(and(eq(docs.id, id), isNull(docs.ownerId)));
    // Feedback feed: a content replacement is activity a watcher wants (skip
    // no-op writes, which roll no new version).
    if (!result.unchanged)
      await emitDocEvent({
        docId: id,
        type: "content.replaced",
        actor: null, // quick-key writes are anonymous
        payload: { versionId: result.versionId, ordinal: result.ordinal },
      });
    return json(200, {
      versionId: result.versionId,
      ordinal: result.ordinal,
      unchanged: result.unchanged,
      expiresAt: expiresAt.toISOString(),
    });
  } catch (e) {
    if (e instanceof DocClaimedError)
      return json(403, { error: "claimed", hint: HINTS.claimed });
    if (e instanceof AgentKeyRevokedError)
      return json(403, {
        error: "key_revoked",
        hint: "This agent key no longer grants update access to this doc.",
      });
    if (e instanceof IngestError)
      return json(ingestStatus(e.code), {
        error: e.code,
        message: e.message,
        hint: "Docs are one self-contained HTML page, 2MB max including inlined assets.",
      });
    throw e;
  }
}
