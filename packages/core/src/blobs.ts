import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { BlobStore, Manifest } from "./types";

const require = createRequire(import.meta.url);

function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function defaultBlobDir(): string {
  const env = process.env.BLOB_FS_DIR;
  if (env && isAbsolute(env)) return env;
  return resolve(repoRoot(), env ?? ".blobs");
}

/**
 * Local dev blob store: the app writes here and the local render dev server
 * reads from the same dir. blobs/<sha256> + manifests/<versionId>.json.
 */
export function fsBlobStore(dir: string = defaultBlobDir()): BlobStore {
  const blobPath = (sha: string) => join(dir, "blobs", sha);
  const manifestPath = (v: string) => join(dir, "manifests", `${v}.json`);

  return {
    async hasBlob(sha) {
      return existsSync(blobPath(sha));
    },
    async putBlob(sha, bytes) {
      await mkdir(join(dir, "blobs"), { recursive: true });
      if (!existsSync(blobPath(sha))) await writeFile(blobPath(sha), bytes);
    },
    async getBlob(sha) {
      try {
        return new Uint8Array(await readFile(blobPath(sha)));
      } catch {
        return null;
      }
    },
    async putManifest(v, manifest) {
      await mkdir(join(dir, "manifests"), { recursive: true });
      await writeFile(manifestPath(v), JSON.stringify(manifest));
    },
    async getManifest(v) {
      try {
        return JSON.parse(await readFile(manifestPath(v), "utf8")) as Manifest;
      } catch {
        return null;
      }
    },
  };
}

/** Prod blob store: Cloudflare R2 over the S3 API (app-side writes). */
export function s3BlobStore(opts: {
  endpoint: string;
  region?: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}): BlobStore {
  // Lazy require so the AWS SDK never loads in the fs/local path or the Worker.
  const {
    S3Client,
    GetObjectCommand,
    PutObjectCommand,
    HeadObjectCommand,
    // eslint-disable-next-line @typescript-eslint/no-var-requires
  } = require("@aws-sdk/client-s3") as typeof import("@aws-sdk/client-s3");

  const s3 = new S3Client({
    endpoint: opts.endpoint,
    region: opts.region ?? "auto",
    credentials: {
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
    },
  });
  const blobKey = (sha: string) => `blobs/${sha}`;
  const manifestKey = (v: string) => `manifests/${v}.json`;

  return {
    async hasBlob(sha) {
      try {
        await s3.send(
          new HeadObjectCommand({ Bucket: opts.bucket, Key: blobKey(sha) }),
        );
        return true;
      } catch {
        return false;
      }
    },
    async putBlob(sha, bytes) {
      if (await this.hasBlob(sha)) return;
      await s3.send(
        new PutObjectCommand({
          Bucket: opts.bucket,
          Key: blobKey(sha),
          Body: bytes,
        }),
      );
    },
    async getBlob(sha) {
      try {
        const res = await s3.send(
          new GetObjectCommand({ Bucket: opts.bucket, Key: blobKey(sha) }),
        );
        const arr = await res.Body?.transformToByteArray();
        return arr ? new Uint8Array(arr) : null;
      } catch {
        return null;
      }
    },
    async putManifest(v, manifest) {
      await s3.send(
        new PutObjectCommand({
          Bucket: opts.bucket,
          Key: manifestKey(v),
          Body: JSON.stringify(manifest),
          ContentType: "application/json",
        }),
      );
    },
    async getManifest(v) {
      try {
        const res = await s3.send(
          new GetObjectCommand({ Bucket: opts.bucket, Key: manifestKey(v) }),
        );
        const text = await res.Body?.transformToString();
        return text ? (JSON.parse(text) as Manifest) : null;
      } catch {
        return null;
      }
    },
  };
}

let cached: BlobStore | undefined;

/** App-side factory: BLOB_DRIVER=fs (local) | r2 (prod). */
export function getBlobStore(): BlobStore {
  if (cached) return cached;
  const driver = process.env.BLOB_DRIVER ?? "fs";
  if (driver === "r2") {
    cached = s3BlobStore({
      endpoint: must("R2_ENDPOINT"),
      bucket: must("R2_BUCKET"),
      accessKeyId: must("R2_ACCESS_KEY_ID"),
      secretAccessKey: must("R2_SECRET_ACCESS_KEY"),
    });
  } else {
    cached = fsBlobStore();
  }
  return cached;
}

function must(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`${key} is required when BLOB_DRIVER=r2`);
  return v;
}
