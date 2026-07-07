import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/hash";
import {
  generateQuickKey,
  hashQuickKey,
  QUICK_DOC_TTL_DAYS,
  QUICK_KEY_LENGTH,
  quickDocExpiry,
  verifyQuickKey,
} from "../src/quick";

describe("quick-doc keys", () => {
  it("generates 22-char base62 keys", () => {
    for (let i = 0; i < 50; i++) {
      expect(generateQuickKey()).toMatch(/^[0-9A-Za-z]{22}$/);
    }
    expect(QUICK_KEY_LENGTH).toBe(22);
  });

  it("keys are unique", () => {
    const keys = new Set(Array.from({ length: 200 }, generateQuickKey));
    expect(keys.size).toBe(200);
  });

  it("hash is the sha256 hex of the key", () => {
    const key = generateQuickKey();
    expect(hashQuickKey(key)).toBe(sha256Hex(key));
    expect(hashQuickKey(key)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("verifies the right key against its stored hash", () => {
    const key = generateQuickKey();
    const stored = hashQuickKey(key);
    expect(verifyQuickKey(key, stored)).toBe(true);
    expect(verifyQuickKey(generateQuickKey(), stored)).toBe(false);
    expect(verifyQuickKey("", stored)).toBe(false);
    expect(verifyQuickKey(null, stored)).toBe(false);
    expect(verifyQuickKey(undefined, stored)).toBe(false);
  });

  it("a burned (null) hash never verifies — claimed docs ignore old keys", () => {
    const key = generateQuickKey();
    expect(verifyQuickKey(key, null)).toBe(false);
    expect(verifyQuickKey(key, undefined)).toBe(false);
    expect(verifyQuickKey(key, "")).toBe(false);
  });

  it("expiry is a rolling 30 days from the given instant", () => {
    const from = new Date("2026-01-01T00:00:00Z");
    const exp = quickDocExpiry(from);
    expect(exp.getTime() - from.getTime()).toBe(
      QUICK_DOC_TTL_DAYS * 24 * 60 * 60 * 1000,
    );
  });
});
