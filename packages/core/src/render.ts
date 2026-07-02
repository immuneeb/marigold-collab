import type { KeyLike } from "jose";
import { ANCHOR_AGENT_JS } from "./agent-src";
import { AGENT_SRC, AGENT_SRC_RE, instrumentHtml } from "./instrument";
import { verifyRenderToken } from "./tokens";
import type { BlobReader } from "./types";

export interface RenderDeps {
  storage: BlobReader;
  publicKey: KeyLike;
  /** The app origin allowed to frame docs (CSP frame-ancestors). */
  appOrigin: string;
  /** Owner-approved outbound origins for a doc (P7 network allowlist). */
  networkGrants?: (docId: string) => Promise<string[]>;
}

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  txt: "text/plain; charset=utf-8",
};

function contentType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/**
 * Security headers for untrusted content. The whole point: the doc runs isolated
 * (separate origin + sandbox iframe), cannot reach the network (`connect-src
 * 'none'`), and can only be framed by the Marigold app. `'unsafe-inline'` is
 * acceptable *because* of the isolation — AI-generated docs inline scripts.
 */
function securityHeaders(
  appOrigin: string,
  contentTypeValue?: string,
  grants: string[] = [],
): Headers {
  const h = new Headers();
  if (contentTypeValue) h.set("Content-Type", contentTypeValue);
  // Default is fully sandboxed (connect-src 'none'). Owner-approved origins
  // (P7 allowlist) relax connect-src + img-src for that doc only.
  const extra = grants.length ? " " + grants.join(" ") : "";
  h.set(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      `img-src 'self' data:${extra}`,
      "font-src 'self' data:",
      grants.length ? `connect-src ${grants.join(" ")}` : "connect-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      `frame-ancestors ${appOrigin}`,
    ].join("; "),
  );
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "no-referrer");
  h.set("Cross-Origin-Resource-Policy", "same-origin");
  return h;
}

function fail(status: number, message: string, appOrigin: string): Response {
  const h = securityHeaders(appOrigin, "text/plain; charset=utf-8");
  return new Response(message, { status, headers: h });
}

/**
 * Validate a capability token, then stream the requested file of that version
 * from storage. Stateless: the token (EdDSA, scoped to {doc, ver}) is the only
 * authorization; no DB. The path's versionId must equal the token's `ver`.
 */
export async function handleRender(
  request: Request,
  deps: RenderDeps,
): Promise<Response> {
  const url = new URL(request.url);
  const segments = url.pathname.replace(/^\/+/, "").split("/");
  const versionId = segments.shift() ?? "";
  const filePath = segments.join("/") || "index.html";

  if (!versionId) return fail(404, "not found", deps.appOrigin);

  // Serve the trusted anchor agent (public, no token — it's Marigold's own code,
  // loaded same-origin by every doc for the commenting layer).
  if (versionId === "__mg") {
    if (filePath === "agent.js") {
      const h = new Headers();
      h.set("Content-Type", "text/javascript; charset=utf-8");
      h.set("Cache-Control", "public, max-age=3600");
      h.set("X-Content-Type-Options", "nosniff");
      return new Response(ANCHOR_AGENT_JS, { status: 200, headers: h });
    }
    return fail(404, "not found", deps.appOrigin);
  }

  // v1: token in the URL (?t=). See plan: cookie-via-redirect conflicts with the
  // cross-site two-domain isolation under third-party-cookie blocking; single-
  // file docs need no cookie, and connect-src 'none' contains the token.
  const token = url.searchParams.get("t");
  if (!token) return fail(401, "missing capability token", deps.appOrigin);

  let claims;
  try {
    claims = await verifyRenderToken(token, deps.publicKey);
  } catch {
    return fail(403, "invalid or expired token", deps.appOrigin);
  }

  // The token is bound to one version; the requested version must match.
  if (claims.ver !== versionId) {
    return fail(403, "token does not authorize this version", deps.appOrigin);
  }

  const manifest = await deps.storage.getManifest(versionId);
  if (!manifest) return fail(404, "version not found", deps.appOrigin);

  const sha = manifest[filePath];
  if (!sha) return fail(404, "file not found in version", deps.appOrigin);

  let bytes = await deps.storage.getBlob(sha);
  if (!bytes) return fail(404, "blob missing", deps.appOrigin);

  if (/\.html?$/.test(filePath)) {
    let text = new TextDecoder().decode(bytes);
    if (!text.includes("data-mg-agent")) {
      // Legacy compatibility: docs ingested before commenting shipped have no
      // marigold ids / anchor agent. Instrument on the fly — deterministic, so
      // anchor ids match what the next ingest would produce.
      text = instrumentHtml(text);
    } else {
      // Normalize the agent tag to the CURRENT version on every serve, so an
      // agent bump busts the browser cache for existing docs too (they baked an
      // older ?v= at ingest and would otherwise keep the stale cached agent).
      text = text.replace(AGENT_SRC_RE, AGENT_SRC);
    }
    bytes = new TextEncoder().encode(text);
  }

  const grants = deps.networkGrants ? await deps.networkGrants(claims.doc) : [];
  const headers = securityHeaders(deps.appOrigin, contentType(filePath), grants);
  // Bytes are immutable; but CSP can change with grants, so shorten cache then.
  headers.set(
    "Cache-Control",
    grants.length
      ? "private, max-age=30"
      : "private, max-age=31536000, immutable",
  );
  return new Response(bytes as BodyInit, { status: 200, headers });
}
