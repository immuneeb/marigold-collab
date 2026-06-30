import { and, eq, sql } from "drizzle-orm";
import {
  blobs as blobsTable,
  db,
  docs,
  docVersions,
  newId,
  newRenderId,
} from "@marigold/db";
import { getBlobStore } from "./blobs";
import { config, renderOriginFor } from "./env";
import { ingest, type IngestResult, type InputFile } from "./ingest";
import { makeSlug } from "./slug";
import type { BlobStore } from "./types";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface CreateDocInput {
  ownerId: string;
  title?: string;
  html?: string;
  files?: InputFile[];
  assistant?: string;
}

export interface UpdateDocInput {
  docId: string;
  title?: string;
  html?: string;
  files?: InputFile[];
  assistant?: string;
  autoPublish?: boolean; // P1 default true; P3 review flow sets false
}

export interface VersionResult {
  docId: string;
  slug: string;
  versionId: string;
  ordinal: number;
  url: string;
  unchanged: boolean;
}

function viewerUrl(slug: string): string {
  return `${config.appOrigin}/d/${slug}`;
}

/** Write content-addressed blobs + the version manifest to storage. Idempotent. */
async function persistContent(
  store: BlobStore,
  versionId: string,
  ing: IngestResult,
): Promise<void> {
  for (const f of ing.files) await store.putBlob(f.sha256, f.bytes);
  // Manifest MUST be durable before any ref points at this version.
  await store.putManifest(versionId, ing.manifest);
}

async function recordBlobRows(tx: Tx, ing: IngestResult): Promise<void> {
  for (const f of ing.files) {
    await tx
      .insert(blobsTable)
      .values({
        sha256: f.sha256,
        byteSize: f.bytes.byteLength,
        storageKey: `blobs/${f.sha256}`,
      })
      .onConflictDoNothing();
  }
}

export async function createDoc(input: CreateDocInput): Promise<VersionResult> {
  const ing = ingest({ html: input.html, files: input.files });

  const docId = newId("doc");
  const slug = makeSlug(input.title);
  const renderId = newRenderId();
  const versionId = newId("ver");

  // Storage first (blobs + manifest), then the DB refs.
  await persistContent(getBlobStore(), versionId, ing);

  await db.transaction(async (tx) => {
    await tx.insert(docs).values({
      id: docId,
      slug,
      renderId,
      ownerId: input.ownerId,
      title: input.title ?? null,
    });
    await tx.insert(docVersions).values({
      id: versionId,
      docId,
      ordinal: 1,
      parentVersionId: null,
      contentHash: ing.contentHash,
      manifest: ing.manifest,
      createdByAssistant: input.assistant ?? null,
      byteSize: ing.byteSize,
      title: input.title ?? null,
    });
    await recordBlobRows(tx, ing);
    // P1 auto-publishes so paste -> URL renders immediately.
    await tx
      .update(docs)
      .set({ latestVersionId: versionId, publishedVersionId: versionId })
      .where(eq(docs.id, docId));
  });

  return {
    docId,
    slug,
    versionId,
    ordinal: 1,
    url: viewerUrl(slug),
    unchanged: false,
  };
}

export async function updateDoc(input: UpdateDocInput): Promise<VersionResult> {
  const doc = (
    await db.select().from(docs).where(eq(docs.id, input.docId)).limit(1)
  )[0];
  if (!doc) throw new Error(`doc not found: ${input.docId}`);

  const ing = ingest({ html: input.html, files: input.files });

  // No-op: identical to the current latest -> no new version, no blob writes.
  if (doc.latestVersionId) {
    const latest = (
      await db
        .select({
          id: docVersions.id,
          ordinal: docVersions.ordinal,
          contentHash: docVersions.contentHash,
        })
        .from(docVersions)
        .where(eq(docVersions.id, doc.latestVersionId))
        .limit(1)
    )[0];
    if (latest && latest.contentHash === ing.contentHash) {
      return {
        docId: doc.id,
        slug: doc.slug,
        versionId: latest.id,
        ordinal: latest.ordinal,
        url: viewerUrl(doc.slug),
        unchanged: true,
      };
    }
  }

  // Revert: this content already exists as a prior version of THIS doc.
  const existing = (
    await db
      .select({ id: docVersions.id, ordinal: docVersions.ordinal })
      .from(docVersions)
      .where(
        and(
          eq(docVersions.docId, doc.id),
          eq(docVersions.contentHash, ing.contentHash),
        ),
      )
      .limit(1)
  )[0];

  // New content: generate the id and persist storage BEFORE the ref-moving txn.
  const newVersionId = existing ? null : newId("ver");
  if (newVersionId) {
    await persistContent(getBlobStore(), newVersionId, ing);
  }

  const result = await db.transaction(async (tx) => {
    // Lock the doc row: serializes ordinal assignment + ref moves against
    // concurrent update_doc calls (no duplicate ordinal).
    const locked = (
      await tx
        .select({ latestVersionId: docs.latestVersionId })
        .from(docs)
        .where(eq(docs.id, doc.id))
        .for("update")
    )[0];

    let versionId: string;
    let ordinal: number;

    if (existing) {
      // Restore = point refs at the existing version; no new ordinal.
      versionId = existing.id;
      ordinal = existing.ordinal;
    } else {
      versionId = newVersionId as string;
      const maxRow = (
        await tx
          .select({ m: sql<number>`coalesce(max(${docVersions.ordinal}), 0)` })
          .from(docVersions)
          .where(eq(docVersions.docId, doc.id))
      )[0];
      ordinal = Number(maxRow?.m ?? 0) + 1;
      await tx.insert(docVersions).values({
        id: versionId,
        docId: doc.id,
        ordinal,
        parentVersionId: locked?.latestVersionId ?? null,
        contentHash: ing.contentHash,
        manifest: ing.manifest,
        createdByAssistant: input.assistant ?? null,
        byteSize: ing.byteSize,
        title: input.title ?? doc.title,
      });
      await recordBlobRows(tx, ing);
    }

    const set: { latestVersionId: string; publishedVersionId?: string } = {
      latestVersionId: versionId,
    };
    if (input.autoPublish !== false) set.publishedVersionId = versionId;
    await tx.update(docs).set(set).where(eq(docs.id, doc.id));

    return { versionId, ordinal };
  });

  return {
    docId: doc.id,
    slug: doc.slug,
    versionId: result.versionId,
    ordinal: result.ordinal,
    url: viewerUrl(doc.slug),
    unchanged: false,
  };
}

export async function publishDoc(
  docId: string,
  versionId: string,
): Promise<void> {
  const v = (
    await db
      .select({ id: docVersions.id })
      .from(docVersions)
      .where(and(eq(docVersions.id, versionId), eq(docVersions.docId, docId)))
      .limit(1)
  )[0];
  if (!v) throw new Error("version does not belong to doc");
  await db
    .update(docs)
    .set({ publishedVersionId: versionId })
    .where(eq(docs.id, docId));
}

export interface ResolvedDoc {
  doc: typeof docs.$inferSelect;
  renderOrigin: string;
}

export async function getDocBySlug(slug: string): Promise<ResolvedDoc | null> {
  const doc = (
    await db.select().from(docs).where(eq(docs.slug, slug)).limit(1)
  )[0];
  if (!doc) return null;
  return { doc, renderOrigin: renderOriginFor(doc.renderId) };
}
