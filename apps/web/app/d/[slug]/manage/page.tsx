import { notFound, redirect } from "next/navigation";
import { authorize, getDocBySlug } from "@marigold/core";
import { currentActor } from "@/lib/actor";
import { listNetworkGrants } from "@/lib/network";
import { listShares } from "@/lib/shares";
import { ManageClient } from "./manage-client";

export const runtime = "nodejs";

type Params = { params: Promise<{ slug: string }> };

export default async function ManagePage({ params }: Params) {
  const { slug } = await params;
  const resolved = await getDocBySlug(slug);
  if (!resolved) notFound();

  const { doc } = resolved;
  const actor = await currentActor();
  const { ok } = await authorize(doc.id, actor, "manage");
  if (!ok) {
    if (!actor.userId) redirect("/login");
    redirect(`/d/${slug}`);
  }

  const shares = await listShares(doc.id);
  const grants = await listNetworkGrants(doc.id);

  return (
    <ManageClient
      docId={doc.id}
      slug={slug}
      title={doc.title}
      latestVersionId={doc.latestVersionId}
      publishedVersionId={doc.publishedVersionId}
      quarantined={doc.quarantined}
      initialShares={shares}
      initialGrants={grants.map((g) => g.origin)}
    />
  );
}
