import { exportPKCS8, exportSPKI, generateKeyPair, type KeyLike } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { AGENT_VERSION } from "../src/instrument";
import { handleRender } from "../src/render";
import { importRenderPublicKey, signRenderToken } from "../src/tokens";
import type { BlobReader } from "../src/types";

// A doc stored BEFORE commenting shipped: no marigold ids, no agent tag.
const LEGACY_HTML =
  "<!doctype html><html><body><h1>Legacy doc</h1><p>Old content here</p></body></html>";
// A doc instrumented by an OLDER agent version (tag baked at ingest).
const OLD_AGENT_HTML =
  '<!doctype html><html><body><h1 data-marigold-id="mg-0000000000">Hi</h1><script src="/__mg/agent.js?v=1" data-mg-agent></script></body></html>';

const storage: BlobReader = {
  async getBlob(sha) {
    if (sha === "sha-legacy") return new TextEncoder().encode(LEGACY_HTML);
    if (sha === "sha-oldagent") return new TextEncoder().encode(OLD_AGENT_HTML);
    return null;
  },
  async getManifest(versionId) {
    if (versionId === "ver_legacy") return { "index.html": "sha-legacy" };
    if (versionId === "ver_oldagent") return { "index.html": "sha-oldagent" };
    return null;
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

  it("rewrites an older baked agent version to the current one on serve", async () => {
    const token = await signRenderToken({
      doc: "doc_1",
      ver: "ver_oldagent",
      sub: "usr_1",
    });
    const res = await handleRender(
      new Request(`https://d-x.example.com/ver_oldagent/index.html?t=${token}`),
      { storage, publicKey, appOrigin: "https://app.example.com" },
    );
    const html = await res.text();
    expect(html).not.toContain("agent.js?v=1"); // stale version rewritten
    expect(html).toContain(`/__mg/agent.js?v=${AGENT_VERSION}`);
  });
});
