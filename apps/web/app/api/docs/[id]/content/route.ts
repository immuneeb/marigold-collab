import { and, eq, isNull } from "drizzle-orm";
import {
  authorize,
  deinstrumentHtml,
  DocClaimedError,
  getBlobStore,
  IngestError,
  quickDocExpiry,
  roleCan,
  updateDoc,
} from "@marigold/core";
import { db, docs, docVersions } from "@marigold/db";
import { currentActor } from "@/lib/actor";
import { emitDocEvent } from "@/lib/events";
import { json } from "@/lib/http";
import { quickAccess, requestQuickKey } from "@/lib/quick";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

// Content as JSON — the agent-facing read/write surface for quick docs
// (see /agents.md). GET also accepts a normal session (any viewer role);
// PUT is the quick-key write path only — owned docs update via PATCH
// /api/docs/:id or MCP, exactly as before.

function ingestStatus(code: string): number {
  return code === "too_large" || code === "too_many_files" ? 413 : 400;
}

const HINTS = {
  claimed:
    "This doc belongs to an account, so the quick key is burned and grants nothing. The owner works with it signed in (dashboard, PATCH /api/docs/:id, or MCP at /api/mcp).",
  expired:
    "This unclaimed quick doc has expired (~30 days after its last write). Sign in and claim it — POST /api/docs/:id/claim with the key — to restore and keep it, or create a fresh doc via POST /api/quick.",
  invalid_key:
    "The key doesn't match this doc. Pass the editKey from POST /api/quick as ?k=<key> or the X-Marigold-Key header.",
  key_required:
    "Writes need the doc's edit key: ?k=<key> or the X-Marigold-Key header. Keys come from POST /api/quick; claimed docs are edited through the owner's account instead.",
};

async function versionPayload(versionId: string, title: string | null) {
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
  return {
    html: deinstrumentHtml(new TextDecoder().decode(bytes)),
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

  // A live quick key reads the working draft (the key IS the edit capability).
  if (access === "granted") {
    const versionId = doc.latestVersionId ?? doc.publishedVersionId;
    if (!versionId)
      return json(404, { error: "no_content", hint: "Doc has no versions yet." });
    const payload = await versionPayload(versionId, doc.title);
    if (!payload) return json(404, { error: "content_missing" });
    // Surface the pinned theme so an agent knows it can send content-only writes.
    return json(200, { ...payload, theme: doc.theme, themeVersion: doc.themeVersion });
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
  const versionId =
    role && roleCan(role, "update")
      ? (doc.latestVersionId ?? doc.publishedVersionId)
      : doc.publishedVersionId;
  if (!versionId)
    return json(404, { error: "no_content", hint: "Doc has no published version." });
  const payload = await versionPayload(versionId, doc.title);
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
  if (access === "claimed")
    return json(403, { error: "claimed", hint: HINTS.claimed });
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

  try {
    const result = await updateDoc({
      docId: id,
      html: body.html,
      title: typeof body.title === "string" ? body.title : undefined,
      assistant: "quick-api",
      requireUnclaimed: true, // burned key must not write into a just-claimed doc
    });
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
    if (e instanceof IngestError)
      return json(ingestStatus(e.code), {
        error: e.code,
        message: e.message,
        hint: "Docs are one self-contained HTML page, 2MB max including inlined assets.",
      });
    throw e;
  }
}
