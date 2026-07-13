import { createHash } from "node:crypto";
import type { Manifest } from "./types";

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Canonical, deterministic serialization of a manifest (sorted by path) so the
 * content hash is stable for identical content. Determinism is what makes dedup
 * and no-op detection work, and what keeps comment anchors safe (P4).
 */
export function canonicalManifest(manifest: Manifest): string {
  const entries = Object.keys(manifest)
    .sort()
    .map((path) => [path, manifest[path]] as const);
  return JSON.stringify(entries);
}

/** The doc-version content identity: sha256 of the canonical manifest. */
export function contentHashOf(manifest: Manifest): string {
  return sha256Hex(canonicalManifest(manifest));
}
