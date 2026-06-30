import { protectedResourceHandler } from "mcp-handler";
import { oauthConfig } from "@/lib/oauth/config";

export const runtime = "nodejs";

// RFC 9728 Protected Resource Metadata: tells MCP clients which authorization
// server to use. The MCP route returns WWW-Authenticate pointing here on 401.
const handler = protectedResourceHandler({
  authServerUrls: [oauthConfig.authServerUrl],
  resourceUrl: oauthConfig.mcpResourceUrl,
});

export { handler as GET };
