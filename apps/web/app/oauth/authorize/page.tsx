import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { getClient } from "@/lib/oauth/store";
import { approveAuthorization } from "./actions";

export const runtime = "nodejs";

type SP = Record<string, string | string[] | undefined>;

function field(sp: SP, key: string): string {
  const v = sp[key];
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v[0] ?? "";
  return "";
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <main className="container center">
      <div className="card">
        <span className="wordmark">🌼 Marigold</span>
        <h1>{title}</h1>
        <p className="muted small">{body}</p>
      </div>
    </main>
  );
}

export default async function AuthorizePage({
  searchParams,
}: {
  searchParams: Promise<SP>;
}) {
  const sp = await searchParams;

  const clientId = field(sp, "client_id");
  const redirectUri = field(sp, "redirect_uri");
  const responseType = field(sp, "response_type");
  const codeChallenge = field(sp, "code_challenge");
  const codeChallengeMethod = field(sp, "code_challenge_method") || "S256";
  const state = field(sp, "state");
  const scope = field(sp, "scope") || "mcp";
  const resource = field(sp, "resource");

  if (responseType !== "code" || !clientId || !redirectUri || !codeChallenge) {
    return (
      <Notice
        title="Invalid request"
        body="Missing or unsupported OAuth parameters (need response_type=code, client_id, redirect_uri, code_challenge)."
      />
    );
  }

  const client = await getClient(clientId);
  if (!client) {
    return <Notice title="Unknown client" body="This application is not registered." />;
  }
  if (!client.redirectUris.includes(redirectUri)) {
    return (
      <Notice
        title="Invalid redirect"
        body="redirect_uri does not match this client's registration."
      />
    );
  }

  const session = await auth();
  if (!session?.user) {
    const qs = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: responseType,
      code_challenge: codeChallenge,
      code_challenge_method: codeChallengeMethod,
      state,
      scope,
      resource,
    });
    redirect(`/login?callbackUrl=${encodeURIComponent(`/oauth/authorize?${qs.toString()}`)}`);
  }

  const who = session.user.name ?? session.user.email ?? "your account";
  const appName = client.clientName ?? "An application";

  return (
    <main className="container center">
      <div className="card">
        <span className="wordmark">🌼 Marigold</span>
        <h1>Authorize {appName}</h1>
        <p className="muted small">
          <strong>{appName}</strong> wants to create and update docs as{" "}
          <strong>{who}</strong>.
        </p>
        <form action={approveAuthorization} className="consent">
          <input type="hidden" name="client_id" value={clientId} />
          <input type="hidden" name="redirect_uri" value={redirectUri} />
          <input type="hidden" name="code_challenge" value={codeChallenge} />
          <input
            type="hidden"
            name="code_challenge_method"
            value={codeChallengeMethod}
          />
          <input type="hidden" name="state" value={state} />
          <input type="hidden" name="scope" value={scope} />
          <input type="hidden" name="resource" value={resource} />
          <button
            className="btn"
            type="submit"
            name="decision"
            value="approve"
          >
            Allow
          </button>
          <button
            className="btn-secondary"
            type="submit"
            name="decision"
            value="deny"
          >
            Deny
          </button>
        </form>
      </div>
    </main>
  );
}
