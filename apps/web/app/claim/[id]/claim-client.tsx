"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function ClaimClient(props: {
  docId: string;
  slug: string;
  claimKey: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Post-claim continuity (MUN-74): claiming burns the ?k= key, which would
  // strand the agent that authored the doc. Default ON: mint an editor-capped
  // agent key right after the claim and show it exactly once.
  const [keepAgent, setKeepAgent] = useState(true);
  const [label, setLabel] = useState("my agent");
  const [claimed, setClaimed] = useState(false);
  const [minted, setMinted] = useState<{ key: string; label: string } | null>(
    null,
  );
  const [mintError, setMintError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function claim() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/docs/${props.docId}/claim`, {
        method: "POST",
        headers: { "x-marigold-key": props.claimKey },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.hint ?? data.error ?? "Claim failed");
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
      return;
    }

    if (!keepAgent) {
      router.replace(`/d/${props.slug}`);
      return;
    }

    // The claim succeeded; mint the continuity key. A mint failure must not
    // look like a claim failure — the doc is already theirs.
    setClaimed(true);
    try {
      const res = await fetch(`/api/docs/${props.docId}/agent-keys`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          label: label.trim() || "my agent",
          roleCap: "editor",
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok)
        throw new Error(data.hint ?? data.error ?? "Key mint failed");
      setMinted({ key: data.key, label: data.label });
    } catch (e) {
      setMintError((e as Error).message);
    }
    setBusy(false);
  }

  async function copyKey() {
    if (!minted) return;
    try {
      await navigator.clipboard.writeText(minted.key);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable — the key is selectable in the input */
    }
  }

  if (claimed) {
    return (
      <div style={{ textAlign: "left" }}>
        <p className="small">
          <strong>Claimed ✓</strong> — this doc now lives in your account.
        </p>
        {minted && (
          <>
            <p className="small">
              <strong>Agent key for &ldquo;{minted.label}&rdquo;</strong> —
              shown once, so copy it now:
            </p>
            <div style={{ display: "flex", gap: 8, margin: "8px 0" }}>
              <input
                readOnly
                value={minted.key}
                aria-label="Agent key"
                onFocus={(e) => e.currentTarget.select()}
                style={{
                  flex: 1,
                  fontFamily: "ui-monospace, monospace",
                  fontSize: 13,
                  padding: "8px 10px",
                }}
              />
              <button className="btn-secondary btn-inline" onClick={copyKey}>
                {copied ? "Copied ✓" : "Copy"}
              </button>
            </div>
            <p className="muted small">
              Give this key to your agent — same API, send it as
              X-Marigold-Key. The old ?k= link no longer works.
            </p>
          </>
        )}
        {mintError && (
          <p className="error small">
            The doc was claimed, but minting the agent key failed: {mintError}.
            You can mint one later from the doc&rsquo;s Access panel.
          </p>
        )}
        <button
          className="btn"
          onClick={() => router.replace(`/d/${props.slug}`)}
        >
          Continue to doc
        </button>
      </div>
    );
  }

  return (
    <>
      <div style={{ textAlign: "left", margin: "12px 0" }}>
        <label
          className="small"
          style={{ display: "flex", alignItems: "center", gap: 8 }}
        >
          <input
            type="checkbox"
            checked={keepAgent}
            onChange={(e) => setKeepAgent(e.target.checked)}
          />
          Keep your agent editing this doc
        </label>
        {keepAgent && (
          <div style={{ marginTop: 8 }}>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={40}
              aria-label="Agent key label"
              placeholder="my agent"
              style={{ width: "100%", padding: "8px 10px", fontSize: 14 }}
            />
            <p className="muted small" style={{ margin: "6px 0 0" }}>
              Claiming burns the ?k= link. We&rsquo;ll mint a fresh editor key
              (shown once) so your agent keeps working over the same API.
            </p>
          </div>
        )}
      </div>
      <button className="btn" onClick={claim} disabled={busy}>
        {busy ? "Claiming…" : "Claim into my account"}
      </button>
      {error && <p className="error small">{error}</p>}
    </>
  );
}
