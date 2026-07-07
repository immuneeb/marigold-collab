import { ulid } from "ulid";

/** Prefixed ULID, e.g. "doc_01J..." — sortable, unique, readable. */
export function newId(
  prefix: "usr" | "doc" | "ver" | "shr" | "cmt" | "evt",
): string {
  return `${prefix}_${ulid()}`;
}

const LABEL_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Unguessable, DNS-safe random label for a doc's render subdomain.
 * The full host is `d-<label>.<RENDER_BASE_HOST>`; `d-` prefix guarantees the
 * label starts with a letter. ~16 chars of [a-z0-9] ≈ 82 bits of entropy.
 */
export function newRenderId(len = 16): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += LABEL_ALPHABET[b % LABEL_ALPHABET.length];
  return out;
}
