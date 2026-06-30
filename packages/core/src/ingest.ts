import { config } from "./env";
import { contentHashOf, sha256Hex } from "./hash";
import type { Manifest } from "./types";

export interface InputFile {
  path: string;
  content: string | Uint8Array;
}

export interface IngestedFile {
  path: string;
  sha256: string;
  bytes: Uint8Array;
}

export interface IngestResult {
  files: IngestedFile[];
  manifest: Manifest;
  contentHash: string;
  byteSize: number;
}

export type IngestErrorCode =
  | "empty"
  | "too_large"
  | "too_many_files"
  | "bad_path"
  | "no_index";

export class IngestError extends Error {
  constructor(
    public code: IngestErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "IngestError";
  }
}

const encoder = new TextEncoder();

export function normalizeInput(input: {
  html?: string;
  files?: InputFile[];
}): InputFile[] {
  if (input.files && input.files.length > 0) return input.files;
  if (typeof input.html === "string")
    return [{ path: "index.html", content: input.html }];
  throw new IngestError("empty", "create requires `html` or `files`");
}

function normalizePath(p: string): string {
  const path = p.trim().replace(/^\.?\/+/, "");
  if (!path || path.startsWith("/") || path.split("/").includes("..")) {
    throw new IngestError("bad_path", `unsafe file path: ${p}`);
  }
  return path;
}

/**
 * Deterministic ingest: hash raw bytes (P1 stores files as-is; deterministic
 * `data-marigold-id` injection is P4), build the manifest, derive the content
 * hash, enforce size/count caps. Identical input -> identical output -> dedup.
 */
export function ingest(input: { html?: string; files?: InputFile[] }): IngestResult {
  const files = normalizeInput(input);
  if (files.length > config.maxDocFiles) {
    throw new IngestError(
      "too_many_files",
      `too many files (max ${config.maxDocFiles})`,
    );
  }

  const ingested: IngestedFile[] = [];
  const manifest: Manifest = {};
  let total = 0;

  for (const f of files) {
    const path = normalizePath(f.path);
    const bytes =
      typeof f.content === "string" ? encoder.encode(f.content) : f.content;
    total += bytes.byteLength;
    if (total > config.maxDocBytes) {
      throw new IngestError(
        "too_large",
        `doc too large (max ${config.maxDocBytes} bytes)`,
      );
    }
    const sha = sha256Hex(bytes);
    manifest[path] = sha;
    ingested.push({ path, sha256: sha, bytes });
  }

  if (!manifest["index.html"]) {
    throw new IngestError("no_index", "an index.html entry is required");
  }

  return {
    files: ingested,
    manifest,
    contentHash: contentHashOf(manifest),
    byteSize: total,
  };
}
