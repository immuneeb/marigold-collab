import Link from "next/link";
import { currentActor } from "@/lib/actor";
import { NewDocForm } from "./new-doc-form";

export const runtime = "nodejs";

export default async function NewDocPage() {
  const actor = await currentActor();
  const signedIn = Boolean(actor.userId);

  return (
    <main className="container">
      <header className="topbar">
        <Link href="/" className="wordmark" style={{ textDecoration: "none" }}>
          🌼 Marigold
        </Link>
        <Link href="/" className="btn-ghost">
          Back
        </Link>
      </header>
      <section>
        <h1>New doc</h1>
        <p className="muted small">
          {signedIn
            ? "Paste HTML. It is published immediately and rendered in a sandboxed, isolated origin."
            : "Paste HTML — no account needed. You get a private link instantly, rendered in a sandboxed, isolated origin."}
        </p>
        <NewDocForm signedIn={signedIn} />
      </section>
    </main>
  );
}
