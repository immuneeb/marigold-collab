import { exportPKCS8, exportSPKI, generateKeyPair, type KeyLike } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { handleRender } from "../src/render";
import { importRenderPublicKey, signRenderToken } from "../src/tokens";
import type { BlobReader } from "../src/types";

// A doc stored BEFORE commenting shipped: no marigold ids, no agent tag.
const LEGACY_HTML =
  "<!doctype html><html><body><h1>Legacy doc</h1><p>Old content here</p></body></html>";

const storage: BlobReader = {
  async getBlob(sha) {
    return sha === "sha-legacy" ? new TextEncoder().encode(LEGACY_HTML) : null;
  },
  async getManifest(versionId) {
    return versionId === "ver_legacy" ? { "index.html": "sha-legacy" } : null;
  },
};

let publicKey: KeyLike;

beforeAll(async () => {
  const kp = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  process.env.RENDER_TOKEN_PRIVATE_KEY = await exportPKCS8(kp.privateKey);
  publicKey = await importRenderPublicKey(await exportSPKI(kp.publicKey));
});

describe("render: legacy docs get instrumented at serve time", () => {
  it("injects marigold ids + the anchor agent into uninstrumented HTML", async () => {
    const token = await signRenderToken({
      doc: "doc_1",
      ver: "ver_legacy",
      sub: "usr_1",
    });
    const res = await handleRender(
      new Request(`https://d-x.example.com/ver_legacy/index.html?t=${token}`),
      { storage, publicKey, appOrigin: "https://app.example.com" },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/data-marigold-id="mg-[0-9a-f]{10}"/);
    expect(html).toContain("/__mg/agent.js");
  });

  it("is deterministic — same ids on every request", async () => {
    const token = await signRenderToken({
      doc: "doc_1",
      ver: "ver_legacy",
      sub: "usr_1",
    });
    const get = async () =>
      (
        await handleRender(
          new Request(`https://d-x.example.com/ver_legacy/index.html?t=${token}`),
          { storage, publicKey, appOrigin: "https://app.example.com" },
        )
      ).text();
    expect(await get()).toBe(await get());
  });
});
