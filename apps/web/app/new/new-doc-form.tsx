"use client";

import { useState } from "react";

const SAMPLE = `<!doctype html>
<html>
  <body style="font-family: system-ui; padding: 40px; text-align:center">
    <h1 id="title">Hello from Marigold</h1>
    <p>This page runs in an isolated, sandboxed origin.</p>
    <button onclick="document.getElementById('title').textContent='It runs! ' + new Date().toLocaleTimeString()">
      Click me
    </button>
  </body>
</html>`;

// A signed-out create via /api/quick: the URL carries the edit capability (?k=).
interface QuickResult {
  url: string;
  claimUrl: string;
  expiresAt: string;
}

export function NewDocForm({ signedIn }: { signedIn: boolean }) {
  const [error, setError] = useState<React.ReactNode>(null);
  const [busy, setBusy] = useState(false);
  const [quick, setQuick] = useState<QuickResult | null>(null);
  const [copied, setCopied] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const fd = new FormData(e.currentTarget);
    // Signed in → the account door (/api/docs). Signed out → the zero-auth
    // quick door (/api/quick), which returns a capability URL instead of
    // attaching the doc to an account.
    const res = await fetch(signedIn ? "/api/docs" : "/api/quick", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: fd.get("title"), html: fd.get("html") }),
    });
    const data = await res.json();
    if (!res.ok) {
      if (!signedIn && res.status === 429) {
        setError(
          <>
            You&rsquo;ve hit today&rsquo;s limit for quick docs —{" "}
            <a href="/login">sign in</a> to create unlimited docs.
          </>,
        );
      } else {
        setError(data.message ?? data.error ?? "Something went wrong");
      }
      setBusy(false);
      return;
    }
    if (signedIn) {
      window.location.href = `/d/${data.slug}`;
      return;
    }
    setQuick({
      url: data.url,
      claimUrl: data.claimUrl,
      expiresAt: data.expiresAt,
    });
    setBusy(false);
  }

  async function copyUrl() {
    if (!quick) return;
    try {
      await navigator.clipboard.writeText(quick.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard can be blocked (permissions, insecure context) — the URL
      // field selects itself on focus, so manual copy still works.
    }
  }

  if (quick) {
    const expires = new Date(quick.expiresAt).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
    return (
      <section className="quickstart-success">
        <h2>Your doc is live 🌼</h2>
        <div className="quickstart-urlrow">
          <input
            readOnly
            value={quick.url}
            aria-label="Doc URL"
            onFocus={(e) => e.currentTarget.select()}
          />
          <button
            type="button"
            className="btn-secondary btn-inline"
            onClick={copyUrl}
          >
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
        <p className="quickstart-lesson">
          This link is the key — anyone who has it can view and edit. Claim to
          lock it down.
        </p>
        <div className="quickstart-actions">
          <a className="btn btn-inline" href={quick.url}>
            Open doc
          </a>
          <a className="btn-secondary btn-inline" href={quick.claimUrl}>
            Claim this doc
          </a>
        </div>
        <p className="muted small quickstart-expiry">
          Unclaimed docs expire ~30 days after the last edit — this one on{" "}
          {expires} unless it&rsquo;s edited or claimed first.
        </p>
      </section>
    );
  }

  return (
    <form onSubmit={onSubmit} className="newdoc">
      <label className="small muted">Title</label>
      <input name="title" placeholder="My doc" defaultValue="My doc" />
      <label className="small muted">HTML</label>
      <textarea name="html" rows={16} defaultValue={SAMPLE} spellCheck={false} />
      {error && <p className="error">{error}</p>}
      <button className="btn" type="submit" disabled={busy}>
        {busy ? "Publishing…" : "Publish"}
      </button>
    </form>
  );
}
