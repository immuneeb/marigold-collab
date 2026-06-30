import { createServer, type IncomingMessage } from "node:http";
import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import { fsBlobStore } from "@marigold/core/blobs";
import { handleRender } from "@marigold/core/render";
import { importRenderPublicKey } from "@marigold/core/tokens";

loadEnv({ path: resolve(process.cwd(), "../../.env") });

const PORT = Number(process.env.RENDER_DEV_PORT ?? 8787);
const appOrigin = process.env.APP_ORIGIN ?? "http://localhost:3000";
const pubPem = process.env.RENDER_TOKEN_PUBLIC_KEY;
if (!pubPem) {
  console.error("[render] RENDER_TOKEN_PUBLIC_KEY is not set");
  process.exit(1);
}

const publicKey = await importRenderPublicKey(pubPem);
const storage = fsBlobStore();

// Convert a Node request into a web-standard Request so the shared handler runs
// identically here and in the Cloudflare Worker.
function toRequest(req: IncomingMessage): Request {
  const host = req.headers.host ?? `127.0.0.1:${PORT}`;
  const url = `http://${host}${req.url ?? "/"}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") headers.set(k, v);
    else if (Array.isArray(v)) headers.set(k, v.join(", "));
  }
  return new Request(url, { method: req.method, headers });
}

const server = createServer(async (req, res) => {
  try {
    const response = await handleRender(toRequest(req), {
      storage,
      publicKey,
      appOrigin,
    });
    res.statusCode = response.status;
    response.headers.forEach((value, key) => res.setHeader(key, value));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    console.error("[render]", e);
    res.statusCode = 500;
    res.end("render error");
  }
});

server.listen(PORT, "127.0.0.1", () =>
  console.log(`[render] dev server on http://127.0.0.1:${PORT} (app ${appOrigin})`),
);
