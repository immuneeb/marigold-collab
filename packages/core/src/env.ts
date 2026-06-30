// App-side config (the render Worker does not import this).
export const config = {
  maxDocBytes: Number(process.env.MAX_DOC_BYTES ?? 2_000_000),
  maxDocFiles: Number(process.env.MAX_DOC_FILES ?? 50),
  renderTokenTtl: Math.min(Number(process.env.RENDER_TOKEN_TTL ?? 60), 60),
  appOrigin: process.env.APP_ORIGIN ?? "http://localhost:3000",
  // Dev: usercontent.localhost:8787. Prod: marigoldusercontent.com.
  renderBaseHost: process.env.RENDER_BASE_HOST ?? "usercontent.localhost:8787",
  renderBaseScheme: process.env.RENDER_BASE_SCHEME ?? "http",
};

/** Full origin a doc renders from: `<scheme>://d-<renderId>.<base host>`. */
export function renderOriginFor(renderId: string): string {
  return `${config.renderBaseScheme}://d-${renderId}.${config.renderBaseHost}`;
}
