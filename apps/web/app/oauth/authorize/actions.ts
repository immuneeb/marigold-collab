"use server";

import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { createCode, getClient } from "@/lib/oauth/store";

// Issue an authorization code (or an access_denied error) and redirect back to
// the client. Re-validates client + redirect_uri since actions are callable
// directly (defense-in-depth against open redirect / confused deputy).
export async function approveAuthorization(formData: FormData) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const clientId = String(formData.get("client_id") ?? "");
  const redirectUri = String(formData.get("redirect_uri") ?? "");
  const codeChallenge = String(formData.get("code_challenge") ?? "");
  const codeChallengeMethod = String(
    formData.get("code_challenge_method") || "S256",
  );
  const state = String(formData.get("state") ?? "");
  const scope = String(formData.get("scope") || "mcp");
  const resource = String(formData.get("resource") ?? "");
  const decision = String(formData.get("decision") ?? "");

  const client = await getClient(clientId);
  if (!client || !client.redirectUris.includes(redirectUri)) {
    redirect("/oauth/authorize?error=invalid_client");
  }

  const url = new URL(redirectUri);
  if (decision !== "approve") {
    url.searchParams.set("error", "access_denied");
    if (state) url.searchParams.set("state", state);
    redirect(url.toString());
  }

  const code = await createCode({
    clientId,
    userId: session.user.id as string,
    redirectUri,
    codeChallenge,
    codeChallengeMethod,
    resource: resource || null,
    scope,
  });
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);
  redirect(url.toString());
}
