import { oauthConfig } from "@/lib/oauth/config";

export const runtime = "nodejs";

// RFC 8414 Authorization Server Metadata.
export function GET() {
  return Response.json({
    issuer: oauthConfig.issuer,
    authorization_endpoint: oauthConfig.authorizationEndpoint,
    token_endpoint: oauthConfig.tokenEndpoint,
    registration_endpoint: oauthConfig.registrationEndpoint,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: oauthConfig.scopesSupported,
  });
}
