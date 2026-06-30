import { jwtVerify, SignJWT } from "jose";
import { oauthConfig } from "./config";

// MCP access tokens: HS256 is fine here — the same app signs AND verifies (no
// cross-service trust boundary like the render token). Separate secret from auth.
const secret = new TextEncoder().encode(
  process.env.MCP_TOKEN_SECRET ??
    process.env.AUTH_SECRET ??
    "dev-mcp-token-secret-change-me",
);

export interface AccessClaims {
  userId: string;
  clientId: string;
  scope: string;
}

export async function signAccessToken(
  c: AccessClaims,
  ttl = oauthConfig.accessTokenTtl,
): Promise<{ token: string; expiresAt: number }> {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + ttl;
  const token = await new SignJWT({ scope: c.scope, client_id: c.clientId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(oauthConfig.issuer)
    .setSubject(c.userId)
    .setAudience(oauthConfig.mcpResourceUrl)
    .setIssuedAt(now)
    .setExpirationTime(expiresAt)
    .sign(secret);
  return { token, expiresAt };
}

export interface VerifiedAccess {
  userId: string;
  clientId: string;
  scope: string;
  expiresAt: number;
}

export async function verifyAccessToken(
  token: string,
): Promise<VerifiedAccess | null> {
  try {
    const { payload } = await jwtVerify(token, secret, {
      issuer: oauthConfig.issuer,
      audience: oauthConfig.mcpResourceUrl,
    });
    return {
      userId: String(payload.sub),
      clientId: String(payload.client_id ?? ""),
      scope: String(payload.scope ?? ""),
      expiresAt: payload.exp ?? 0,
    };
  } catch {
    return null;
  }
}
