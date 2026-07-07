import { randomBytes, timingSafeEqual } from "node:crypto";
import { sha256Hex } from "./hash";

// Quick docs — the zero-barrier on-ramp. The doc URL carries the edit
// capability: a 22-char base62 key (128 bits) in `?k=`. The DB stores only its
// sha256, so a DB leak never leaks edit capability. Claiming a doc into an
// account nulls the hash ("burns" the key) — from then on the doc is a normal
// private owned doc and the old URL grants nothing.

const BASE62 =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export const QUICK_KEY_LENGTH = 22; // 62^22 > 2^130 — comfortably 128-bit
export const QUICK_DOC_TTL_DAYS = 30;

/** Crypto-random 22-char base62 key. Rejection sampling keeps it uniform. */
export function generateQuickKey(): string {
  let out = "";
  while (out.length < QUICK_KEY_LENGTH) {
    for (const b of randomBytes(QUICK_KEY_LENGTH)) {
      // 248 = 62 * 4: accept only bytes that map uniformly onto the alphabet.
      if (b < 248 && out.length < QUICK_KEY_LENGTH) out += BASE62[b % 62];
    }
  }
  return out;
}

/** What the DB stores: sha256 hex of the key (never the key itself). */
export function hashQuickKey(key: string): string {
  return sha256Hex(key);
}

/** Timing-safe check of a presented key against a stored hash. */
export function verifyQuickKey(
  key: string | null | undefined,
  storedHash: string | null | undefined,
): boolean {
  if (!key || !storedHash) return false;
  const a = Buffer.from(hashQuickKey(key), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Rolling expiry: `from` + 30 days (set on create, extended on each write). */
export function quickDocExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + QUICK_DOC_TTL_DAYS * 24 * 60 * 60 * 1000);
}
