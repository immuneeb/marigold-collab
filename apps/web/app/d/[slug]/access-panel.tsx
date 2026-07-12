"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

// Owner's at-a-glance access panel (MUN-74): who can open this doc — email
// grants, the public flag, and live minted agent keys (with revoke). Fully
// self-contained (fetches its own data, renders its own trigger + modal) so
// the viewer hook-in is a single line — viewer-client.tsx has parallel work
// in flight and must stay conflict-free.

interface ShareRow {
  id: string;
  email: string;
  role: string;
  state: string;
}
interface KeyRow {
  id: string;
  label: string;
  roleCap: string;
  minter: { id: string; name?: string | null; email?: string | null };
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

function ago(iso: string | null): string {
  if (!iso) return "never used";
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "used just now";
  if (mins < 60) return `used ${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `used ${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `used ${days}d ago`;
}

export function AccessPanel(props: { docId: string; slug: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPublic, setIsPublic] = useState<boolean | null>(null);
  const [shares, setShares] = useState<ShareRow[]>([]);
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [docRes, sharesRes, keysRes] = await Promise.all([
        fetch(`/api/docs/${props.docId}`),
        fetch(`/api/docs/${props.docId}/shares`),
        fetch(`/api/docs/${props.docId}/agent-keys`),
      ]);
      if (!docRes.ok || !sharesRes.ok || !keysRes.ok)
        throw new Error("Couldn't load access info");
      const doc = await docRes.json();
      const sharesData = await sharesRes.json();
      const keysData = await keysRes.json();
      setIsPublic(!!doc.doc?.isPublic);
      setShares(sharesData.shares ?? []);
      setKeys(
        (keysData.keys ?? []).filter((k: KeyRow) => !k.revokedAt),
      );
    } catch (e) {
      setError((e as Error).message);
    }
    setLoading(false);
  }, [props.docId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  async function revoke(keyId: string) {
    setBusyKey(keyId);
    const res = await fetch(
      `/api/docs/${props.docId}/agent-keys/${keyId}`,
      { method: "DELETE" },
    );
    setBusyKey(null);
    if (res.ok) setKeys((ks) => ks.filter((k) => k.id !== keyId));
    else setError("Couldn't revoke the key");
  }

  return (
    <>
      <button
        className="btn-ghost"
        onClick={() => setOpen(true)}
        title="Who can open this doc — grants, visibility, agent keys"
      >
        Access
      </button>
      {open && (
        <div className="name-modal-backdrop" onClick={() => setOpen(false)}>
          <div
            className="name-modal"
            style={{ maxWidth: 520, maxHeight: "80vh", overflowY: "auto" }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="Doc access"
          >
            <p className="name-modal-title">Access</p>
            {loading && <p className="muted small">Loading…</p>}
            {error && <p className="error small">{error}</p>}
            {!loading && !error && (
              <>
                <section className="manage-block">
                  <h2 className="manage-h">General</h2>
                  <p className="muted small">
                    {isPublic
                      ? "Public — anyone with the link can view the published version."
                      : "Private — only you and the people below can open this doc."}
                  </p>
                </section>
                <section className="manage-block">
                  <h2 className="manage-h">People</h2>
                  <ul className="doclist">
                    {shares.length === 0 && (
                      <li className="doclink muted small">No one yet.</li>
                    )}
                    {shares.map((s) => (
                      <li key={s.id} className="doclink">
                        <span className="small">{s.email}</span>
                        <span className="muted small">
                          {s.role} · {s.state}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
                <section className="manage-block">
                  <h2 className="manage-h">Agent keys</h2>
                  <p className="muted small">
                    Bearer keys your agents send as X-Marigold-Key. Each is
                    capped at a role and dies the moment you revoke it.
                  </p>
                  <ul className="doclist">
                    {keys.length === 0 && (
                      <li className="doclink muted small">
                        No live keys. Mint one: POST
                        /api/docs/{props.docId}/agent-keys
                      </li>
                    )}
                    {keys.map((k) => (
                      <li key={k.id} className="doclink">
                        <span className="small">
                          <strong>{k.label}</strong>{" "}
                          <span className="muted">
                            {k.roleCap} · {ago(k.lastUsedAt)}
                          </span>
                        </span>
                        <button
                          className="btn-ghost"
                          disabled={busyKey === k.id}
                          onClick={() => void revoke(k.id)}
                        >
                          {busyKey === k.id ? "Revoking…" : "Revoke"}
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
                <div className="name-modal-actions">
                  <Link
                    href={`/d/${props.slug}/manage`}
                    className="btn-ghost"
                  >
                    Full sharing controls
                  </Link>
                  <button className="btn-ghost" onClick={() => setOpen(false)}>
                    Close
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
