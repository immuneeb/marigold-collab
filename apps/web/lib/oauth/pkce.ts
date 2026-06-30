import { createHash } from "node:crypto";

/** RFC 7636 PKCE verification. We require S256; `plain` accepted as a fallback. */
export function verifyPkce(
  verifier: string,
  challenge: string,
  method = "S256",
): boolean {
  if (!verifier || !challenge) return false;
  if (method === "plain") return verifier === challenge;
  const digest = createHash("sha256").update(verifier).digest("base64url");
  return digest === challenge;
}
