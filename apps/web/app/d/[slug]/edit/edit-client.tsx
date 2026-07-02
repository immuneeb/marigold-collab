"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function EditClient(props: {
  docId: string;
  slug: string;
  title: string | null;
  initialHtml: string;
}) {
  const router = useRouter();
  const [html, setHtml] = useState(props.initialHtml);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = html !== props.initialHtml;

  async function save() {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/docs/${props.docId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ html }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(data.message ?? data.error ?? "Save failed");
      return;
    }
    router.push(`/d/${props.slug}`);
  }

  return (
    <div className="viewer">
      <header className="viewer-bar">
        <div className="viewer-left">
          <Link href="/" className="wordmark" style={{ textDecoration: "none" }}>
            🌼
          </Link>
          <span className="viewer-title">
            Editing · {props.title ?? "Untitled"}
          </span>
          <span className="ugc-pill">
            saves as a new version · comments re-anchor
          </span>
        </div>
        <div className="viewer-right">
          <button
            className="btn-ghost"
            onClick={() => setPreview((p) => !p)}
          >
            {preview ? "Hide preview" : "Preview"}
          </button>
          <button
            className="btn btn-inline"
            disabled={busy || !dirty}
            onClick={save}
          >
            {busy ? "Saving…" : "Save"}
          </button>
          <Link href={`/d/${props.slug}`} className="btn-ghost">
            Cancel
          </Link>
        </div>
      </header>

      {error && <p className="error edit-error">{error}</p>}

      <div className="viewer-body">
        <div className="edit-pane">
          <textarea
            className="edit-source"
            value={html}
            spellCheck={false}
            onChange={(e) => setHtml(e.target.value)}
          />
        </div>
        {preview && (
          <div className="edit-pane">
            {/* Sandboxed preview: opaque origin, no access to this app. */}
            <iframe
              className="edit-preview"
              sandbox="allow-scripts"
              srcDoc={html}
              title="preview"
            />
          </div>
        )}
      </div>
    </div>
  );
}
