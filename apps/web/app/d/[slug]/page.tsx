import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  authorize,
  config,
  getDocBySlug,
  roleCan,
  signRenderToken,
} from "@marigold/core";
import { currentActor } from "@/lib/actor";
import { ViewerClient } from "./viewer-client";

export const runtime = "nodejs";

type Params = { params: Promise<{ slug: string }> };

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <main className="container">
      <header className="topbar">
        <Link href="/" className="wordmark" style={{ textDecoration: "none" }}>
          🌼 Marigold
        </Link>
      </header>
      <div className="empty">
        <p>
          <strong>{title}</strong>
        </p>
        <p className="muted small">{body}</p>
      </div>
    </main>
  );
}

export default async function ViewerPage({ params }: Params) {
  const { slug } = await params;
  const resolved = await getDocBySlug(slug);
  if (!resolved) notFound();

  const { doc, renderOrigin } = resolved;
  const actor = await currentActor();
  const { ok, role } = await authorize(doc.id, actor, "view");

  if (!ok) {
    if (!actor.userId)
      redirect(`/login?callbackUrl=${encodeURIComponent(`/d/${slug}`)}`);
    return (
      <Notice
        title="No access"
        body="You don't have access to this doc. Ask the owner to share it with you."
      />
    );
  }
  if (doc.quarantined) {
    return (
      <Notice
        title="Doc unavailable"
        body="This doc has been quarantined by an administrator."
      />
    );
  }

  // Anyone who can edit works against `latest` (their edits apply to what they
  // see); read-only roles see `published`.
  const versionId =
    role && roleCan(role, "update")
      ? (doc.latestVersionId ?? doc.publishedVersionId)
      : doc.publishedVersionId;
  if (!versionId) {
    return (
      <Notice title="Not published yet" body="This doc has no published version." />
    );
  }

  // Public docs render for anonymous viewers; the render origin never reads
  // `sub`, it only proves the ACL check happened.
  const token = await signRenderToken(
    { doc: doc.id, ver: versionId, sub: actor.userId ?? "anon" },
    config.renderTokenTtl,
  );
  const iframeSrc = `${renderOrigin}/${versionId}/index.html?t=${encodeURIComponent(token)}`;

  return (
    <ViewerClient
      docId={doc.id}
      slug={slug}
      title={doc.title}
      versionId={versionId}
      iframeSrc={iframeSrc}
      canComment={!!role && roleCan(role, "comment")}
      canEdit={!!role && roleCan(role, "update")}
      isOwner={role === "owner"}
      signedIn={!!actor.userId}
    />
  );
}
