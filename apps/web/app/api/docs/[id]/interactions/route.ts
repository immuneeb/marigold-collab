import { eq } from "drizzle-orm";
import { authorize, MGID_RE } from "@marigold/core";
import { db, docs, users } from "@marigold/db";
import { currentActor } from "@/lib/actor";
import {
  displayNameInUse,
  sanitizeGuestName,
  versionBelongsToDoc,
} from "@/lib/comments";
import { emitDocEvent } from "@/lib/events";
import { json } from "@/lib/http";
import {
  clearInteraction,
  listInteractions,
  readerKeyFor,
  sanitizeControlType,
  sanitizeInteractionValue,
  upsertInteraction,
  CONTROL_NAME_RE,
} from "@/lib/interactions";
import { quickKeyGrants, requestQuickKey } from "@/lib/quick";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

// The viewer shell hydrates in-doc <mg-control>s with the reader's OWN saved
// values (never other readers' — per-reader state stays private in the viewer;
// the owner's agent reads the full picture over MCP get_state). Guests identify
// by `?author=<name>` alongside their quick key, mirroring how they comment.
export async function GET(req: Request, { params }: Params) {
  const { id } = await params;
  const actor = await currentActor();
  const { ok } = await authorize(id, actor, "view");
  // Additive quick-doc branch: a live key on an unclaimed doc grants view.
  if (!ok) {
    const doc = (
      await db.select().from(docs).where(eq(docs.id, id)).limit(1)
    )[0];
    const quick =
      !!doc && !doc.quarantined && quickKeyGrants(doc, requestQuickKey(req));
    if (!quick) return json(actor.userId ? 403 : 401, { error: "forbidden" });
  }
  const author = sanitizeGuestName(new URL(req.url).searchParams.get("author"));
  const readerKey = readerKeyFor(actor.userId, author);
  if (!readerKey) return json(200, { interactions: [] });
  const rows = await listInteractions(id, { readerKey });
  return json(200, {
    interactions: rows.map((r) => ({
      name: r.name,
      controlType: r.controlType,
      value: r.value,
      updatedAt: r.updatedAt,
    })),
  });
}

// One tap from an in-doc control: persist a typed, element-anchored,
// reader-attributed value. Last-write-wins per (reader, control); a `null`
// value clears (re-tapping the selected option toggles it off). Auth mirrors
// the comments route exactly: ACL "comment", or a live quick key — a signed-in
// key holder interacts under their account, a signed-out one as a guest.
export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  const actor = await currentActor();
  const { ok } = await authorize(id, actor, "comment");
  let quick = false;
  if (!ok) {
    const doc = (
      await db.select().from(docs).where(eq(docs.id, id)).limit(1)
    )[0];
    quick =
      !!doc && !doc.quarantined && quickKeyGrants(doc, requestQuickKey(req));
    if (!quick) return json(actor.userId ? 403 : 401, { error: "forbidden" });
  }

  let body: {
    name?: unknown;
    controlType?: unknown;
    value?: unknown;
    anchor?: unknown;
    versionId?: string;
    author?: string;
  };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }

  const name = typeof body.name === "string" ? body.name : "";
  if (!CONTROL_NAME_RE.test(name)) {
    return json(400, {
      error: "invalid_name",
      hint: "Control `name` must be 1-64 chars of letters, digits, . _ or -.",
    });
  }
  const value = sanitizeInteractionValue(body.value);
  if (value === undefined) {
    return json(400, {
      error: "invalid_value",
      hint: "`value` must be a string (≤200 chars), number, boolean, or null to clear.",
    });
  }
  if (!body.versionId || !(await versionBelongsToDoc(id, body.versionId))) {
    return json(400, { error: "versionId does not belong to this doc" });
  }
  const controlType = sanitizeControlType(body.controlType);
  // The anchor is best-effort re-anchoring input, never a reason to drop a tap:
  // oversized → stored without one; a malformed marigoldId is stripped (it's
  // interpolated into selectors downstream, so only MGID_RE-shaped ids pass).
  let anchor =
    body.anchor && typeof body.anchor === "object"
      ? (body.anchor as Record<string, unknown>)
      : null;
  if (anchor) {
    try {
      if (JSON.stringify(anchor).length > 8192) anchor = null;
      else if (
        typeof anchor.marigoldId === "string" &&
        !MGID_RE.test(anchor.marigoldId)
      ) {
        anchor = { ...anchor, marigoldId: null };
      }
    } catch {
      anchor = null;
    }
  }

  // Quick-key writes re-verify under a fresh read now the body has arrived
  // (claimed/quarantined mid-flight), exactly as the comment write does.
  if (quick) {
    const fresh = (
      await db.select().from(docs).where(eq(docs.id, id)).limit(1)
    )[0];
    if (!fresh || fresh.quarantined) {
      return json(403, {
        error: "quarantined",
        hint: "This doc has been quarantined by an administrator.",
      });
    }
    if (!quickKeyGrants(fresh, requestQuickKey(req))) {
      return json(403, {
        error: "claimed",
        hint: "The doc was claimed; the quick key no longer grants access.",
      });
    }
  }

  const asGuest = quick && !actor.userId;
  let readerKey: string;
  let readerId: string | null = null;
  let readerName: string | null = null;
  if (asGuest) {
    const authorName = sanitizeGuestName(body.author);
    if (!authorName) {
      return json(400, {
        error: "author_required",
        hint: "Guest interactions need an `author` display name (1–40 chars of plain text).",
      });
    }
    // Impersonation guard: a guest may not adopt a real account's name. NOTE:
    // deliberately NOT the comments route's guest-name-in-use-on-doc guard —
    // interactions are an upsert per (reader, control), so the same guest name
    // MUST keep working on every re-tap.
    if (await displayNameInUse(authorName)) {
      return json(409, {
        error: "name_taken",
        hint: "That name belongs to an account — pick a different one.",
      });
    }
    readerKey = readerKeyFor(null, authorName) as string;
    readerName = authorName;
  } else {
    const userId = actor.userId as string;
    readerKey = userId;
    readerId = userId;
    // Readable reader name for the feedback-feed payload (the row itself joins
    // users at read time, but events are stored verbatim).
    readerName =
      (
        await db
          .select({ displayName: users.displayName })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1)
      )[0]?.displayName ?? null;
  }

  const marigoldId =
    anchor && typeof anchor.marigoldId === "string" ? anchor.marigoldId : null;
  const eventPayload = {
    name,
    controlType,
    value,
    marigoldId,
    reader: { name: readerName, guest: asGuest },
  };
  const eventActor = asGuest ? `guest:${readerName}` : actor.userId;

  // ── Clear (value: null) — re-tap toggled the control off ───────────────────
  if (value === null) {
    const removed = await clearInteraction({ docId: id, name, readerKey });
    if (removed) {
      await emitDocEvent({
        docId: id,
        type: "interaction.cleared",
        actor: eventActor,
        payload: eventPayload,
      });
    }
    return json(200, { ok: true, name, value: null, cleared: removed });
  }

  // ── Set (insert or last-write-wins update) ──────────────────────────────────
  const { created } = await upsertInteraction({
    docId: id,
    name,
    controlType,
    value,
    anchor,
    versionId: body.versionId,
    readerKey,
    readerId,
    readerName,
    guest: asGuest,
  });
  // Feedback feed: a tap is exactly the kind of signal a watching agent wants
  // in ≤1s. Payload is self-contained (name/value/reader) — no enrichment.
  await emitDocEvent({
    docId: id,
    type: created ? "interaction.created" : "interaction.updated",
    actor: eventActor,
    payload: eventPayload,
  });
  return json(200, {
    ok: true,
    name,
    value,
    ...(asGuest ? { guest: true } : {}),
  });
}
