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
      router.replace(`/d/${props.slug}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <>
      <button className="btn" onClick={claim} disabled={busy}>
        {busy ? "Claiming…" : "Claim into my account"}
      </button>
      {error && <p className="error small">{error}</p>}
    </>
  );
}
