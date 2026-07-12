"use client";

import { useState } from "react";

// "Email me a sign-in link" — the door for invitees without a Google account.
// The server always answers {ok:true} (no account enumeration), so the sent
// state is unconditional: "if that address can receive mail, a link is coming."
export function MagicLinkForm({ callbackUrl }: { callbackUrl: string }) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">(
    "idle",
  );

  if (state === "sent") {
    return (
      <div className="dev" aria-live="polite">
        <p style={{ margin: 0 }}>
          <strong>Check your inbox</strong>
        </p>
        <p className="muted small" style={{ margin: 0 }}>
          We sent a sign-in link to <strong>{email}</strong>. It works once and
          expires in 15 minutes.
        </p>
        <button
          className="btn-ghost"
          type="button"
          onClick={() => setState("idle")}
        >
          Use a different email
        </button>
      </div>
    );
  }

  return (
    <form
      className="dev"
      onSubmit={async (e) => {
        e.preventDefault();
        setState("sending");
        try {
          const res = await fetch("/api/auth/magic-link", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email, callbackUrl }),
          });
          setState(res.ok ? "sent" : "error");
        } catch {
          setState("error");
        }
      }}
    >
      <label className="muted small" htmlFor="magic-link-email">
        Or sign in with your email
      </label>
      <input
        id="magic-link-email"
        name="email"
        type="email"
        placeholder="you@example.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
      />
      {state === "error" && (
        <p className="error small" style={{ margin: 0 }}>
          Something went wrong sending the link. Please try again.
        </p>
      )}
      <button
        className="btn-secondary"
        type="submit"
        disabled={state === "sending"}
      >
        {state === "sending" ? "Sending…" : "Email me a sign-in link"}
      </button>
    </form>
  );
}
