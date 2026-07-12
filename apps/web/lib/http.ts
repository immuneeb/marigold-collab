export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Open-redirect guard for login `callbackUrl` passthrough: only same-app
 * relative paths survive; anything else falls back to "/". A bare
 * startsWith("/") is not enough — browsers treat "//evil.com" (and "/\evil.com")
 * as protocol-relative absolute URLs.
 */
export function safeCallbackUrl(raw: string | string[] | undefined): string {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (!v || !v.startsWith("/") || v.startsWith("//") || v.startsWith("/\\")) {
    return "/";
  }
  return v;
}
