import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  blobs as blobsTable,
  comments,
  db,
  docs,
  docVersions,
  newId,
  newRenderId,
} from "@marigold/db";
import { getBlobStore } from "./blobs";
import { config, renderOriginFor } from "./env";
import { ingest, type IngestResult, type InputFile } from "./ingest";
import { type CommentAnchor, resolveAnchor } from "./instrument";
import { makeSlug } from "./slug";
import type { BlobStore, Manifest } from "./types";

function htmlOf(ing: IngestResult): string | null {
  const f = ing.files.find((x) => x.path === "index.html");
  return f ? new TextDecoder().decode(f.bytes) : null;
}

/**
 * Re-anchor every comment on a doc against a new version's HTML (P5). Resolvable
 * (marigoldId → css → textQuote) → carry forward + refresh the id; open+
 * unresolvable → orphaned (retaining the version it was made on); a previously
 * orphaned comment that resolves again is recovered.
 */
export async function reanchorComments(
  docId: string,
  newVersionId: string,
  newHtml: string,
): Promise<void> {
  const roots = await db
    .select({ id: comments.id, anchor: comments.anchor, status: comments.status })
    .from(comments)
    .where(and(eq(comments.docId, docId), isNull(comments.parentId)));

  for (const c of roots) {
    const anchor = (c.anchor ?? {}) as CommentAnchor;
    const rid = resolveAnchor(newHtml, anchor);
    if (rid) {
      await db
        .update(comments)
        .set({
          anchoredVersionId: newVersionId,
          anchor: { ...anchor, marigoldId: rid },
          status: c.status === "orphaned" ? "open" : c.status,
          updatedAt: new Date(),
        })
        .where(eq(comments.id, c.id));
    } else if (c.status === "open") {
      await db
        .update(comments)
        .set({ status: "orphaned", updatedAt: new Date() })
        .where(eq(comments.id, c.id));
    }
  }
}

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

  // P5: re-anchor comments against the new content.
  if (!existing) {
    const html = htmlOf(ing);
    if (html) await reanchorComments(doc.id, result.versionId, html);
  }

  return {
    docId: doc.id,
    slug: doc.slug,
    versionId: result.versionId,
    ordinal: result.ordinal,
    url: viewerUrl(doc.slug),
    unchanged: false,
  };
}

/**
 * Rename a doc. Title is doc-level metadata — renaming never rolls a version
 * (future versions pick up the new title via updateDoc's `?? doc.title`).
 * Empty/whitespace titles clear to null ("Untitled").
 */
export async function renameDoc(
  docId: string,
  title: string | null,
): Promise<{ title: string | null }> {
  const normalized = title?.trim() ? title.trim().slice(0, 300) : null;
  const updated = await db
    .update(docs)
    .set({ title: normalized })
    .where(eq(docs.id, docId))
    .returning({ id: docs.id });
  if (updated.length === 0) throw new Error(`doc not found: ${docId}`);
  return { title: normalized };
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

/**
 * Permanently delete a doc. The docs row delete cascades to versions, comments,
 * shares, and network grants. Blobs are content-addressed and dedup'd across
 * docs, so a blob is purged only when no surviving version still references its
 * sha — computed inside the same transaction as the delete. External storage
 * cleanup runs after commit and is best-effort: a leftover content-addressed
 * blob is unreachable garbage, never a broken doc.
 * Returns false if the doc does not exist.
 */
export async function deleteDoc(docId: string): Promise<boolean> {
  const result = await db.transaction(async (tx) => {
    const doc = (
      await tx
        .select({ id: docs.id })
        .from(docs)
        .where(eq(docs.id, docId))
        .for("update")
    )[0];
    if (!doc) return null;

    const versions = await tx
      .select({ id: docVersions.id, manifest: docVersions.manifest })
      .from(docVersions)
      .where(eq(docVersions.docId, docId));
    const candidateShas = [
      ...new Set(
        versions.flatMap((v) => Object.values((v.manifest ?? {}) as Manifest)),
      ),
    ];

    await tx.delete(docs).where(eq(docs.id, docId));

    let orphanShas: string[] = [];
    if (candidateShas.length > 0) {
      // Shas still referenced by any surviving version of any doc stay put.
      const shaList = sql.join(
        candidateShas.map((s) => sql`${s}`),
        sql`, `,
      );
      const rows = await tx.execute(sql`
        select distinct e.value as sha
        from ${docVersions}, jsonb_each_text(${docVersions.manifest}) as e
        where e.value in (${shaList})
      `);
      const referenced = new Set(
        Array.from(rows as Iterable<Record<string, unknown>>).map(
          (r) => r.sha as string,
        ),
      );
      orphanShas = candidateShas.filter((s) => !referenced.has(s));
      if (orphanShas.length > 0) {
        await tx.delete(blobsTable).where(inArray(blobsTable.sha256, orphanShas));
      }
    }

    return { versionIds: versions.map((v) => v.id), orphanShas };
  });

  if (!result) return false;

  const store = getBlobStore();
  for (const versionId of result.versionIds) {
    await store.deleteManifest(versionId);
  }
  for (const sha of result.orphanShas) {
    await store.deleteBlob(sha);
  }
  return true;
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
