import { exportPKCS8, exportSPKI, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { signRenderToken, verifyRenderToken } from "../src/tokens";

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", {
    crv: "Ed25519",
    extractable: true,
  });
  process.env.RENDER_TOKEN_PRIVATE_KEY = await exportPKCS8(privateKey);
  process.env.RENDER_TOKEN_PUBLIC_KEY = await exportSPKI(publicKey);
});

describe("render tokens (EdDSA)", () => {
  const claims = { doc: "doc_1", ver: "ver_1", sub: "usr_1" };

  it("round-trips a valid token", async () => {
    const t = await signRenderToken(claims);
    const v = await verifyRenderToken(t);
    expect(v.doc).toBe("doc_1");
    expect(v.ver).toBe("ver_1");
    expect(v.sub).toBe("usr_1");
  });

  it("rejects a tampered token", async () => {
    const t = await signRenderToken(claims);
    const tampered = t.slice(0, -3) + "aaa";
    await expect(verifyRenderToken(tampered)).rejects.toBeTruthy();
  });

  it("rejects a token signed by a different key", async () => {
    const other = await generateKeyPair("EdDSA", {
      crv: "Ed25519",
      extractable: true,
    });
    const forged = await new SignJWT({ doc: "doc_1", ver: "ver_1" })
      .setProtectedHeader({ alg: "EdDSA" })
      .setSubject("usr_1")
      .setAudience("marigold-render")
      .setExpirationTime("60s")
      .sign(other.privateKey);
    await expect(verifyRenderToken(forged)).rejects.toBeTruthy();
  });

  it("rejects an expired token", async () => {
    const { importPKCS8 } = await import("jose");
    const key = await importPKCS8(
      process.env.RENDER_TOKEN_PRIVATE_KEY as string,
      "EdDSA",
    );
    const expired = await new SignJWT({ doc: "doc_1", ver: "ver_1" })
      .setProtectedHeader({ alg: "EdDSA" })
      .setSubject("usr_1")
      .setAudience("marigold-render")
      .setIssuedAt(Math.floor(Date.now() / 1000) - 120)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(key);
    await expect(verifyRenderToken(expired)).rejects.toBeTruthy();
  });

  it("rejects a token for the wrong audience", async () => {
    const key = await import("jose").then((j) =>
      j.importPKCS8(process.env.RENDER_TOKEN_PRIVATE_KEY as string, "EdDSA"),
    );
    const wrongAud = await new SignJWT({ doc: "doc_1", ver: "ver_1" })
      .setProtectedHeader({ alg: "EdDSA" })
      .setSubject("usr_1")
      .setAudience("someone-else")
      .setExpirationTime("60s")
      .sign(key);
    await expect(verifyRenderToken(wrongAud)).rejects.toBeTruthy();
  });
});
