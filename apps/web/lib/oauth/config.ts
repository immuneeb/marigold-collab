const appOrigin = process.env.APP_ORIGIN ?? "http://localhost:3000";

export const oauthConfig = {
  issuer: appOrigin,
  authServerUrl: appOrigin,
  authorizationEndpoint: `${appOrigin}/oauth/authorize`,
  tokenEndpoint: `${appOrigin}/oauth/token`,
  registrationEndpoint: `${appOrigin}/oauth/register`,
  // Canonical MCP resource (RFC 8707). The Streamable HTTP endpoint is /api/mcp.
  mcpResourceUrl: `${appOrigin}/api/mcp`,
  scopesSupported: ["mcp"],
  accessTokenTtl: 3600, // 1h; refresh tokens keep "authorize once" working
  codeTtl: 600, // 10m
};
