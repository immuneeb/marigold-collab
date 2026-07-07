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
import { quickAccess } from "@/lib/quick";
import { ViewerClient } from "./viewer-client";

export const runtime = "nodejs";

type Params = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ k?: string }>;
};

function Notice({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: { href: string; label: string };
}) {
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
        {action && (
          <p>
            <Link href={action.href} className="btn btn-inline">
              {action.label}
            </Link>
          </p>
        )}
      </div>
    </main>
  );
}

export default async function ViewerPage({ params, searchParams }: Params) {
  const { slug } = await params;
  const { k } = await searchParams;
  const resolved = await getDocBySlug(slug);
  if (!resolved) notFound();

  const { doc, renderOrigin } = resolved;
  const actor = await currentActor();
  const { ok, role } = await authorize(doc.id, actor, "view");

  // Quick docs: the ?k= URL is the capability — a valid key on a live
  // unclaimed doc grants view + edit, no account. Additive: owned/claimed docs
  // never take this branch (their key hash is null).
  const key = k?.trim() || null;
  const access = quickAccess(doc, key);
  const quick = access === "granted";

  if (!ok && !quick) {
    if (key && access === "expired") {
      return (
        <Notice
          title="Quick doc expired"
          body="This unclaimed doc passed its 30-day expiry. Claim it into an account to restore and keep it."
          action={{ href: `/claim/${doc.id}?k=${key}`, label: "Claim this doc" }}
        />
      );
    }
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
  // see); read-only roles see `published`. A quick key IS edit capability.
  const canEdit = (!!role && roleCan(role, "update")) || quick;
  const versionId = canEdit
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
      canEdit={canEdit}
      isOwner={role === "owner"}
      signedIn={!!actor.userId}
      quick={
        quick
          ? { editKey: key as string, claimUrl: `/claim/${doc.id}?k=${key}` }
          : undefined
      }
    />
  );
}
