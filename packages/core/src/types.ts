// Runtime-free types shared by the app and the render Worker. Importing this
// from the Worker drags in no Node-only code.

export type Manifest = Record<string, string>; // path -> sha256

/** Read side used by the render handler (Worker: R2 binding; local: FS). */
export interface BlobReader {
  getBlob(sha256: string): Promise<Uint8Array | null>;
  getManifest(versionId: string): Promise<Manifest | null>;
}

/** Full store used app-side at publish time. */
export interface BlobStore extends BlobReader {
  hasBlob(sha256: string): Promise<boolean>;
  putBlob(sha256: string, bytes: Uint8Array): Promise<void>;
  putManifest(versionId: string, manifest: Manifest): Promise<void>;
  /** Idempotent: deleting a missing blob/manifest is a no-op, not an error. */
  deleteBlob(sha256: string): Promise<void>;
  deleteManifest(versionId: string): Promise<void>;
}
