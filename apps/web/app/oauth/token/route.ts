import { verifyPkce } from "@/lib/oauth/pkce";
import {
  consumeCode,
  createRefreshToken,
  getRefreshToken,
} from "@/lib/oauth/store";
import { signAccessToken } from "@/lib/oauth/tokens";

export const runtime = "nodejs";

function oauthError(code: string, description: string, status = 400): Response {
  return Response.json({ error: code, error_description: description }, { status });
}

function expiresIn(expiresAt: number): number {
  return Math.max(0, expiresAt - Math.floor(Date.now() / 1000));
}

export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return oauthError("invalid_request", "expected form-encoded body");
  }
  const grantType = String(form.get("grant_type") ?? "");

  if (grantType === "authorization_code") {
    const code = String(form.get("code") ?? "");
    const clientId = String(form.get("client_id") ?? "");
    const redirectUri = String(form.get("redirect_uri") ?? "");
    const verifier = String(form.get("code_verifier") ?? "");

    const row = await consumeCode(code); // one-time use
    if (!row) return oauthError("invalid_grant", "unknown or used code");
    if (new Date(row.expiresAt).getTime() < Date.now())
      return oauthError("invalid_grant", "code expired");
    if (row.clientId !== clientId)
      return oauthError("invalid_grant", "client mismatch");
    if (row.redirectUri !== redirectUri)
      return oauthError("invalid_grant", "redirect_uri mismatch");
    if (!verifyPkce(verifier, row.codeChallenge, row.codeChallengeMethod))
      return oauthError("invalid_grant", "PKCE verification failed");

    const { token, expiresAt } = await signAccessToken({
      userId: row.userId,
      clientId,
      scope: row.scope,
    });
    const refresh = await createRefreshToken({
      clientId,
      userId: row.userId,
      scope: row.scope,
      resource: row.resource,
    });

    return Response.json({
      access_token: token,
      token_type: "Bearer",
      expires_in: expiresIn(expiresAt),
      refresh_token: refresh,
      scope: row.scope,
    });
  }

  if (grantType === "refresh_token") {
    const refresh = String(form.get("refresh_token") ?? "");
    const row = await getRefreshToken(refresh);
    if (!row) return oauthError("invalid_grant", "unknown or revoked refresh token");

    const { token, expiresAt } = await signAccessToken({
      userId: row.userId,
      clientId: row.clientId,
      scope: row.scope,
    });
    return Response.json({
      access_token: token,
      token_type: "Bearer",
      expires_in: expiresIn(expiresAt),
      scope: row.scope,
    });
  }

  return oauthError("unsupported_grant_type", `unsupported: ${grantType}`);
}
