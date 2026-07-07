import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { verifyQuickKey } from "@marigold/core";
import { db, docs } from "@marigold/db";
import { currentActor } from "@/lib/actor";
import { ClaimClient } from "./claim-client";

export const runtime = "nodejs";

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ k?: string }>;
};

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

// The browser leg of graduation: holder of the ?k= URL signs in (if needed)
// and confirms; the actual claim is the same POST /api/docs/:id/claim the API
// uses. Claiming burns the key — the old link stops granting access.
export default async function ClaimPage({ params, searchParams }: Props) {
  const { id } = await params;
  const { k } = await searchParams;

  const doc = (
    await db.select().from(docs).where(eq(docs.id, id)).limit(1)
  )[0];
  if (!doc) notFound();

  const actor = await currentActor();
  if (!actor.userId) {
    redirect(
      `/login?callbackUrl=${encodeURIComponent(`/claim/${id}?k=${k ?? ""}`)}`,
    );
  }

  if (doc.ownerId) {
    // Already graduated. The owner just goes to the doc; anyone else gets the
    // standard no-access story on the viewer.
    if (doc.ownerId === actor.userId) redirect(`/d/${doc.slug}`);
    return (
      <Notice
        title="Already claimed"
        body="This doc already belongs to an account, so it can't be claimed again. Ask the owner to share it with you."
      />
    );
  }

  if (!verifyQuickKey(k ?? null, doc.quickKeyHash)) {
    return (
      <Notice
        title="Invalid claim link"
        body="This link is missing the doc's key. Open the original quick-doc URL (with ?k=) and use its Claim button."
      />
    );
  }

  return (
    <main className="container center">
      <div className="card">
        <span className="wordmark">🌼 Marigold</span>
        <h1>Claim this doc</h1>
        <p className="muted small">
          &ldquo;{doc.title ?? "Untitled"}&rdquo; becomes a private doc in your
          account: it stops expiring, you control who can see or edit it, and
          the current quick link stops granting access to anyone else.
        </p>
        <ClaimClient docId={doc.id} slug={doc.slug} claimKey={k ?? ""} />
      </div>
    </main>
  );
}
