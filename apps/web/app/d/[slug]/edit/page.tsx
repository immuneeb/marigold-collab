import { notFound, redirect } from "next/navigation";
import {
  authorize,
  deinstrumentHtml,
  getBlobStore,
  getDocBySlug,
} from "@marigold/core";
import { currentActor } from "@/lib/actor";
import { EditClient } from "./edit-client";

export const runtime = "nodejs";

type Params = { params: Promise<{ slug: string }> };

export default async function EditPage({ params }: Params) {
  const { slug } = await params;
  const resolved = await getDocBySlug(slug);
  if (!resolved) notFound();

  const { doc } = resolved;
  const actor = await currentActor();
  const { ok } = await authorize(doc.id, actor, "update");
  if (!ok) {
    if (!actor.userId) redirect("/login");
    redirect(`/d/${slug}`);
  }

  // Current clean HTML (Marigold's injected ids + agent stripped).
  let html = "";
  if (doc.latestVersionId) {
    const store = getBlobStore();
    const manifest = await store.getManifest(doc.latestVersionId);
    const sha = manifest?.["index.html"];
    const bytes = sha ? await store.getBlob(sha) : null;
    if (bytes) html = deinstrumentHtml(new TextDecoder().decode(bytes));
  }

  return (
    <EditClient
      docId={doc.id}
      slug={slug}
      title={doc.title}
      initialHtml={html}
    />
  );
}
