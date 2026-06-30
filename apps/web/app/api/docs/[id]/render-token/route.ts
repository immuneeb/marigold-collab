import { eq } from "drizzle-orm";
import { authorize, config, renderOriginFor, signRenderToken } from "@marigold/core";
import { db, docs } from "@marigold/db";
import { currentActor } from "@/lib/actor";
import { json } from "@/lib/http";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

// Mint a short-lived capability token AFTER a server-side ACL check. This is the
// only authorization the stateless render origin gets.
export async function POST(_req: Request, { params }: Params) {
  const { id } = await params;
  const actor = await currentActor();
  const { ok, role } = await authorize(id, actor, "view");
  if (!ok || !actor.userId)
    return json(actor.userId ? 403 : 401, { error: "forbidden" });

  const doc = (
    await db.select().from(docs).where(eq(docs.id, id)).limit(1)
  )[0];
  if (!doc) return json(404, { error: "not_found" });
  if (doc.quarantined) return json(403, { error: "quarantined" });

  // Owners preview `latest`; everyone else sees `published`.
  const versionId =
    role === "owner"
      ? (doc.latestVersionId ?? doc.publishedVersionId)
      : doc.publishedVersionId;
  if (!versionId) return json(404, { error: "not_published" });

  const token = await signRenderToken(
    { doc: id, ver: versionId, sub: actor.userId },
    config.renderTokenTtl,
  );
  const renderOrigin = renderOriginFor(doc.renderId);
  return json(200, {
    token,
    versionId,
    renderOrigin,
    iframeSrc: `${renderOrigin}/${versionId}/index.html?t=${encodeURIComponent(token)}`,
  });
}
