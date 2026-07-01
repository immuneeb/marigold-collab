import { describe, expect, it } from "vitest";
import { contentHashOf } from "../src/hash";
import { IngestError, ingest } from "../src/ingest";

describe("ingest", () => {
  it("turns html shorthand into an index.html manifest", () => {
    const r = ingest({ html: "<h1>hi</h1>" });
    expect(Object.keys(r.manifest)).toEqual(["index.html"]);
    // HTML is instrumented at ingest (ids + agent), so it grows past the raw 11 bytes.
    expect(r.byteSize).toBeGreaterThan(11);
    expect(r.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic — identical input yields identical content hash", () => {
    const a = ingest({ html: "<h1>hi</h1>" });
    const b = ingest({ html: "<h1>hi</h1>" });
    expect(a.contentHash).toBe(b.contentHash);
    expect(contentHashOf(a.manifest)).toBe(b.contentHash);
  });

  it("different content yields a different hash", () => {
    const a = ingest({ html: "<h1>hi</h1>" });
    const b = ingest({ html: "<h1>bye</h1>" });
    expect(a.contentHash).not.toBe(b.contentHash);
  });

  it("content hash is order-independent across files", () => {
    const a = ingest({
      files: [
        { path: "index.html", content: "<h1>hi</h1>" },
        { path: "a.js", content: "1" },
      ],
    });
    const b = ingest({
      files: [
        { path: "a.js", content: "1" },
        { path: "index.html", content: "<h1>hi</h1>" },
      ],
    });
    expect(a.contentHash).toBe(b.contentHash);
  });

  it("requires an index.html entry", () => {
    expect(() =>
      ingest({ files: [{ path: "a.js", content: "x" }] }),
    ).toThrowError(IngestError);
  });

  it("rejects unsafe paths", () => {
    expect(() =>
      ingest({ files: [{ path: "../etc/passwd", content: "x" }] }),
    ).toThrowError(/unsafe file path/);
  });

  it("enforces the byte cap", () => {
    const big = "x".repeat(2_000_001);
    expect(() => ingest({ html: big })).toThrowError(/too large/);
  });
});
