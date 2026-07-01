// App-side config (the render Worker does not import this).
export const config = {
  maxDocBytes: Number(process.env.MAX_DOC_BYTES ?? 2_000_000),
  maxDocFiles: Number(process.env.MAX_DOC_FILES ?? 50),
  renderTokenTtl: Math.min(Number(process.env.RENDER_TOKEN_TTL ?? 60), 60),
  appOrigin: process.env.APP_ORIGIN ?? "http://localhost:3000",
  // Dev: usercontent.localhost:8787. Two-domain prod: marigoldusercontent.com.
  renderBaseHost: process.env.RENDER_BASE_HOST ?? "usercontent.localhost:8787",
  renderBaseScheme: process.env.RENDER_BASE_SCHEME ?? "http",
  // All-Vercel: a single fixed render origin (the render project's *.vercel.app).
  // When set, docs render from it directly (no per-doc subdomain).
  renderOrigin: process.env.RENDER_ORIGIN,
};

/**
 * Origin a doc renders from. If RENDER_ORIGIN is set (all-Vercel: one render
 * project), use it directly. Otherwise a per-doc unguessable subdomain
 * `<scheme>://d-<renderId>.<base host>` (local dev / two-domain prod).
 */
export function renderOriginFor(renderId: string): string {
  if (config.renderOrigin) return config.renderOrigin;
  return `${config.renderBaseScheme}://d-${renderId}.${config.renderBaseHost}`;
}
