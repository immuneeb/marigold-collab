import { desc, eq } from "drizzle-orm";
import { createDoc, IngestError, ThemeError } from "@marigold/core";
import { db, docs } from "@marigold/db";
import { currentActor } from "@/lib/actor";
import { emitDocEvent } from "@/lib/events";
import { json } from "@/lib/http";

export const runtime = "nodejs";

function ingestStatus(code: string): number {
  return code === "too_large" || code === "too_many_files" ? 413 : 400;
}

export async function POST(req: Request) {
  const actor = await currentActor();
  if (!actor.userId) return json(401, { error: "unauthenticated" });

  let body: {
    title?: string;
    html?: string;
    files?: unknown;
    theme?: string;
    content?: string;
  };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }

  try {
    // Additive theme branch: `theme` + `content` styles semantic body content
    // server-side; `html`/`files` authoring is unchanged.
    const result = await createDoc({
      ownerId: actor.userId,
      title: body.title,
      html: body.html,
      files: body.files as never,
      theme: body.theme,
      content: body.content,
    });
    // Feedback feed: the doc's first version is saved — the feed's genesis event.
    await emitDocEvent({
      docId: result.docId,
      type: "version.saved",
      actor: actor.userId,
      payload: { versionId: result.versionId, ordinal: result.ordinal },
    });
    return json(200, result);
  } catch (e) {
    if (e instanceof ThemeError)
      return json(400, {
        error: e.code,
        message: e.message,
        validThemeIds: e.validThemeIds,
      });
    if (e instanceof IngestError)
      return json(ingestStatus(e.code), { error: e.code, message: e.message });
    throw e;
  }
}

export async function GET() {
  const actor = await currentActor();
  if (!actor.userId) return json(401, { error: "unauthenticated" });

  const rows = await db
    .select({
      id: docs.id,
      slug: docs.slug,
      title: docs.title,
      createdAt: docs.createdAt,
      latestVersionId: docs.latestVersionId,
    })
    .from(docs)
    .where(eq(docs.ownerId, actor.userId))
    .orderBy(desc(docs.createdAt));

  return json(200, { docs: rows });
}
