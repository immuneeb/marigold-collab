import { createClient } from "@/lib/oauth/store";

export const runtime = "nodejs";

// RFC 7591 Dynamic Client Registration. Open registration for public PKCE
// clients (no secret). Redirect URIs are stored and exact-matched at authorize.
export async function POST(req: Request) {
  let body: { client_name?: string; redirect_uris?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json(
      { error: "invalid_client_metadata", error_description: "invalid JSON" },
      { status: 400 },
    );
  }

  const redirectUris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.filter((u): u is string => typeof u === "string")
    : [];
  if (redirectUris.length === 0) {
    return Response.json(
      {
        error: "invalid_redirect_uri",
        error_description: "redirect_uris is required",
      },
      { status: 400 },
    );
  }

  const client = await createClient({
    clientName: body.client_name ?? null,
    redirectUris,
  });

  return Response.json(
    {
      client_id: client.clientId,
      client_name: client.clientName ?? undefined,
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
    { status: 201 },
  );
}
