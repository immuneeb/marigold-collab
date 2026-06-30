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

export function NewDocForm() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const fd = new FormData(e.currentTarget);
    const res = await fetch("/api/docs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: fd.get("title"), html: fd.get("html") }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.message ?? data.error ?? "Something went wrong");
      setBusy(false);
      return;
    }
    window.location.href = `/d/${data.slug}`;
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
