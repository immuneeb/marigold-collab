import type { R2Bucket } from "@cloudflare/workers-types";
import type { KeyLike } from "jose";
import { handleRender } from "@marigold/core/render";
import { importRenderPublicKey } from "@marigold/core/tokens";

interface Env {
  BLOBS: R2Bucket;
  RENDER_TOKEN_PUBLIC_KEY: string;
  APP_ORIGIN: string;
}

let cachedKey: Promise<KeyLike> | undefined;
function publicKey(pem: string): Promise<KeyLike> {
  if (!cachedKey) cachedKey = importRenderPublicKey(pem);
  return cachedKey;
}

// R2-backed read side (prod). The Worker holds only the public key — it can
// verify capability tokens but never mint them.
function r2Reader(bucket: R2Bucket) {
  return {
    async getBlob(sha: string): Promise<Uint8Array | null> {
      const o = await bucket.get(`blobs/${sha}`);
      return o ? new Uint8Array(await o.arrayBuffer()) : null;
    },
    async getManifest(versionId: string) {
      const o = await bucket.get(`manifests/${versionId}.json`);
      return o ? JSON.parse(await o.text()) : null;
    },
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const key = await publicKey(env.RENDER_TOKEN_PUBLIC_KEY);
    return handleRender(request, {
      storage: r2Reader(env.BLOBS),
      publicKey: key,
      appOrigin: env.APP_ORIGIN,
    });
  },
};
