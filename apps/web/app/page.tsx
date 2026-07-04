import { headers } from "next/headers";
import Link from "next/link";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db, docs, shares } from "@marigold/db";
import { auth, signOut } from "@/auth";
import { currentActor } from "@/lib/actor";
import { Landing } from "./landing";

export const runtime = "nodejs";

export default async function HomePage() {
  const session = await auth();
  if (!session?.user) return <Landing />;
  const actor = await currentActor();

  const myDocs = await db
    .select({
      id: docs.id,
      slug: docs.slug,
      title: docs.title,
      createdAt: docs.createdAt,
    })
    .from(docs)
    .where(eq(docs.ownerId, actor.userId as string))
    .orderBy(desc(docs.createdAt));

  const sharedDocs =
    actor.verifiedEmails.length > 0
      ? await db
          .select({
            id: docs.id,
            slug: docs.slug,
            title: docs.title,
            role: shares.role,
          })
          .from(shares)
          .innerJoin(docs, eq(shares.docId, docs.id))
          .where(
            and(
              inArray(shares.email, actor.verifiedEmails),
              eq(shares.state, "active"),
            ),
          )
          .orderBy(desc(docs.createdAt))
      : [];

  const who = session.user.name ?? session.user.email ?? "there";
  const h = await headers();
  const origin = `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host") ?? "marigold-collab-web.vercel.app"}`;

  return (
    <main className="container">
      <header className="topbar">
        <span className="wordmark">🌼 Marigold</span>
        <form
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/login" });
          }}
        >
          <button className="btn-ghost" type="submit">
            Sign out
          </button>
        </form>
      </header>

      <section>
        <div className="row-between">
          <div>
            <h1>Your docs</h1>
            <p className="muted small">Signed in as {who}.</p>
          </div>
          <Link href="/new" className="btn btn-inline">
            New doc
          </Link>
        </div>

        {myDocs.length === 0 ? (
          <div className="empty">
            <p>No docs yet.</p>
            <p className="muted small">
              Paste HTML, or push from your assistant over MCP (Phase 2).
            </p>
          </div>
        ) : (
          <ul className="doclist">
            {myDocs.map((d) => (
              <li key={d.id}>
                <Link href={`/d/${d.slug}`} className="doclink">
                  <span className="doctitle">{d.title ?? "Untitled"}</span>
                  <span className="muted small">/d/{d.slug}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {sharedDocs.length > 0 && (
        <section style={{ marginTop: 36 }}>
          <h1>Shared with me</h1>
          <ul className="doclist">
            {sharedDocs.map((d) => (
              <li key={d.id}>
                <Link href={`/d/${d.slug}`} className="doclink">
                  <span className="doctitle">{d.title ?? "Untitled"}</span>
                  <span className="muted small">{d.role}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="manage-block">
        <h2 className="manage-h">Get set up</h2>
        <div className="actors" style={{ padding: "12px 0 0" }}>
          <div className="actor-card">
            <div className="actor-emoji">☁️</div>
            <strong>Connect your assistant to Marigold</strong>
            <p className="muted small">
              Add a custom connector in Claude (Settings → Connectors) pointing
              at <code>{origin}/api/mcp</code> and authorize once. Your
              assistant can then publish docs here, read comments, and revise —
              say &ldquo;marigold&rdquo; in chat to use it.
            </p>
          </div>
          <div className="actor-card">
            <div className="actor-emoji">💻</div>
            <strong>Draft locally with Marigold Draft</strong>
            <p className="muted small">
              The same review loop on your machine, before anything is shared.
              Give your coding agent this prompt:
            </p>
            <p className="muted small" style={{ userSelect: "all" }}>
              <code>
                Install Marigold Draft for me using `npm i -g marigold-draft`,
                then read {origin}/draft/setup.md and set yourself up to use it.
              </code>
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
