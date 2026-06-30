import Link from "next/link";
import { redirect } from "next/navigation";
import { currentActor } from "@/lib/actor";
import { NewDocForm } from "./new-doc-form";

export const runtime = "nodejs";

export default async function NewDocPage() {
  const actor = await currentActor();
  if (!actor.userId) redirect("/login");

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
          Paste HTML. It is published immediately and rendered in a sandboxed,
          isolated origin.
        </p>
        <NewDocForm />
      </section>
    </main>
  );
}
