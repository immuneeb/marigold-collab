import { describe, expect, it } from "vitest";
import { canonicalManifest, contentHashOf, sha256Hex } from "../src/hash";

describe("hashing + content identity", () => {
  it("canonical manifest is order-independent", () => {
    expect(canonicalManifest({ b: "2", a: "1" })).toBe(
      canonicalManifest({ a: "1", b: "2" }),
    );
  });

  it("content hash is stable and 64 hex chars", () => {
    const h = contentHashOf({ "index.html": "abc" });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(contentHashOf({ "index.html": "abc" })).toBe(h);
  });

  it("different manifests hash differently", () => {
    expect(contentHashOf({ "index.html": "a" })).not.toBe(
      contentHashOf({ "index.html": "b" }),
    );
  });

  it("sha256 matches a known vector", () => {
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});
