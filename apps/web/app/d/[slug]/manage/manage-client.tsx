"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

interface Share {
  id: string;
  email: string;
  role: string;
  state: string;
}

export function ManageClient(props: {
  docId: string;
  slug: string;
  title: string | null;
  latestVersionId: string | null;
  publishedVersionId: string | null;
  isPublic: boolean;
  quarantined: boolean;
  initialShares: Share[];
  initialGrants: string[];
}) {
  const router = useRouter();
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const published = props.publishedVersionId === props.latestVersionId;

  async function call(url: string, init: RequestInit) {
    setBusy(true);
    const res = await fetch(url, init);
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    router.refresh();
    return { res, data };
  }

  async function deletePermanently() {
    setBusy(true);
    setDeleteError(null);
    const res = await fetch(`/api/docs/${props.docId}`, { method: "DELETE" });
    if (res.ok) {
      // The doc (and this page) no longer exist — leave, don't refresh.
      router.push("/");
      router.refresh();
      return;
    }
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    setDeleteError(data.error ?? "Delete failed");
  }

  async function addShare(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const { res, data } = await call(`/api/docs/${props.docId}/shares`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: fd.get("email"), role: fd.get("role") }),
    });
    if (res.ok) {
      (e.target as HTMLFormElement).reset();
      setMsg(
        data.invite?.sent
          ? `Invited ${data.email} (${data.state})`
          : `Share saved (${data.state}). Invite link: ${data.invite?.link}`,
      );
    } else setMsg(data.error ?? "Failed");
  }

  return (
    <main className="container">
      <header className="topbar">
        <Link href={`/d/${props.slug}`} className="wordmark" style={{ textDecoration: "none" }}>
          🌼 Marigold
        </Link>
        <Link href={`/d/${props.slug}`} className="btn-ghost">
          Back to doc
        </Link>
      </header>

      <h1>Manage · {props.title ?? "Untitled"}</h1>

      <section className="manage-block">
        <h2 className="manage-h">Publishing</h2>
        <p className="muted small">
          {props.publishedVersionId
            ? published
              ? "Latest version is published — shared viewers see the current version."
              : "You have unpublished changes. Shared viewers still see the older published version."
            : "Not published yet."}
        </p>
        {!published && props.latestVersionId && (
          <button
            className="btn-secondary btn-inline"
            disabled={busy}
            onClick={() =>
              call(`/api/docs/${props.docId}/publish`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ versionId: props.latestVersionId }),
              })
            }
          >
            Publish latest
          </button>
        )}
      </section>

      <section className="manage-block">
        <h2 className="manage-h">General access</h2>
        <p className="muted small">
          {props.isPublic
            ? "Public — anyone with the link can view the published version, no sign-in needed. Editing and commenting still require access below."
            : "Private — only you and the people listed below can open this doc."}
        </p>
        <button
          className="btn-secondary btn-inline"
          disabled={busy}
          onClick={async () => {
            const { res, data } = await call(
              `/api/docs/${props.docId}/visibility`,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ public: !props.isPublic }),
              },
            );
            if (!res.ok) setMsg(data.error ?? "Failed");
          }}
        >
          {props.isPublic ? "Make private" : "Make public"}
        </button>
      </section>

      <section className="manage-block">
        <h2 className="manage-h">People with access</h2>
        <ul className="doclist">
          {props.initialShares.length === 0 && (
            <li className="doclink muted small">No one yet.</li>
          )}
          {props.initialShares.map((s) => (
            <li key={s.id} className="doclink">
              <span>
                {s.email} <span className="muted small">({s.state})</span>
              </span>
              <span className="share-controls">
                <select
                  defaultValue={s.role}
                  disabled={busy}
                  onChange={(e) =>
                    call(`/api/shares/${s.id}`, {
                      method: "PATCH",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({ role: e.target.value }),
                    })
                  }
                >
                  <option value="viewer">viewer</option>
                  <option value="commenter">commenter</option>
                  <option value="editor">editor</option>
                </select>
                <button
                  className="btn-ghost"
                  disabled={busy}
                  onClick={() =>
                    call(`/api/shares/${s.id}`, { method: "DELETE" })
                  }
                >
                  Revoke
                </button>
              </span>
            </li>
          ))}
        </ul>
        <form onSubmit={addShare} className="share-add">
          <input name="email" type="email" placeholder="person@example.com" required />
          <select name="role" defaultValue="viewer">
            <option value="viewer">viewer</option>
            <option value="commenter">commenter</option>
            <option value="editor">editor</option>
          </select>
          <button className="btn-secondary" type="submit" disabled={busy}>
            Share
          </button>
        </form>
        {msg && <p className="muted small">{msg}</p>}
      </section>

      <section className="manage-block">
        <h2 className="manage-h">Network access</h2>
        <p className="muted small">
          By default a doc can make no network calls. Approve origins it may
          reach (e.g. an API it needs).
        </p>
        <ul className="doclist">
          {props.initialGrants.length === 0 && (
            <li className="doclink muted small">No approved origins.</li>
          )}
          {props.initialGrants.map((o) => (
            <li key={o} className="doclink">
              <span>{o}</span>
              <button
                className="btn-ghost"
                disabled={busy}
                onClick={() =>
                  call(`/api/docs/${props.docId}/network-grants`, {
                    method: "DELETE",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ origin: o }),
                  })
                }
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
        <form
          className="share-add"
          onSubmit={async (e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            const { res } = await call(
              `/api/docs/${props.docId}/network-grants`,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ origin: fd.get("origin") }),
              },
            );
            if (res.ok) (e.target as HTMLFormElement).reset();
          }}
        >
          <input
            name="origin"
            type="url"
            placeholder="https://api.example.com"
            required
          />
          <button className="btn-secondary" type="submit" disabled={busy}>
            Approve
          </button>
        </form>
      </section>

      <section className="manage-block">
        <h2 className="manage-h">Danger zone</h2>
        <p className="muted small">
          Quarantine instantly hides this doc from everyone and stops it
          rendering.
        </p>
        <button
          className="btn-ghost"
          disabled={busy}
          onClick={() =>
            call(`/api/docs/${props.docId}/quarantine`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ quarantined: !props.quarantined }),
            })
          }
        >
          {props.quarantined ? "Un-quarantine" : "Quarantine doc"}
        </button>
        <div className="danger-delete">
          <p className="muted small">
            Deleting is permanent: the doc, every version, and all comments and
            shares are removed. This cannot be undone.
          </p>
          {confirmDelete ? (
            <div className="danger-actions">
              <button
                className="btn-danger"
                disabled={busy}
                onClick={deletePermanently}
              >
                Yes, delete permanently
              </button>
              <button
                className="btn-ghost"
                disabled={busy}
                onClick={() => setConfirmDelete(false)}
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              className="btn-danger"
              disabled={busy}
              onClick={() => setConfirmDelete(true)}
            >
              Delete doc…
            </button>
          )}
          {deleteError && <p className="muted small">{deleteError}</p>}
        </div>
      </section>
    </main>
  );
}
