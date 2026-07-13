import { parse } from "node-html-parser";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  agentKeys,
  blobs as blobsTable,
  comments,
  db,
  docInteractions,
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
import { getTheme, listThemes, ThemeError, wrapWithTheme } from "./themes";
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
    .select({
      id: comments.id,
      anchor: comments.anchor,
      status: comments.status,
    })
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

/**
 * Re-anchor reader interactions against a new version. Unlike comments,
 * interactions carry a stable author-chosen key — the control `name` — so
 * resolution is name-first: find the `<mg-control name=...>` in the new HTML
 * and take its (position-derived, possibly shifted) marigoldId. The generic
 * anchor chain is only a fallback; alone it mis-resolves agent-rendered
 * controls after structural edits, because their stored source is an empty
 * element (no text) and a structural id can now belong to a different element.
 * Control gone → orphaned; the value is never dropped, and `updatedAt` is
 * untouched (it means "when the reader tapped", not "when we re-anchored").
 */
export async function reanchorInteractions(
  docId: string,
  newVersionId: string,
  newHtml: string,
): Promise<void> {
  const rows = await db
    .select({
      id: docInteractions.id,
      name: docInteractions.name,
      anchor: docInteractions.anchor,
      orphaned: docInteractions.orphaned,
    })
    .from(docInteractions)
    .where(eq(docInteractions.docId, docId));
  if (rows.length === 0) return;

  // One parse for the whole doc: name → the control's current marigoldId.
  const idByName = new Map<string, string>();
  for (const el of parse(newHtml, { comment: true }).querySelectorAll(
    "mg-control[name]",
  )) {
    const name = el.getAttribute("name");
    const mgid = el.getAttribute("data-marigold-id");
    if (name && mgid && !idByName.has(name)) idByName.set(name, mgid);
  }

  for (const r of rows) {
    const anchor = (r.anchor ?? {}) as CommentAnchor;
    const rid = idByName.get(r.name) ?? resolveAnchor(newHtml, anchor);
    if (rid) {
      await db
        .update(docInteractions)
        .set({
          anchoredVersionId: newVersionId,
          anchor: { ...anchor, marigoldId: rid },
          orphaned: false,
        })
        .where(eq(docInteractions.id, r.id));
    } else if (!r.orphaned) {
      await db
        .update(docInteractions)
        .set({ orphaned: true })
        .where(eq(docInteractions.id, r.id));
    }
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface CreateDocInput {
  // Null = unclaimed quick doc: the ?k= URL is the only capability until claim.
  ownerId: string | null;
  title?: string;
  html?: string;
  files?: InputFile[];
  assistant?: string;
  // Theme-pack authoring (additive): pass a built-in theme id plus semantic body
  // `content` and the server wraps it into a self-contained page at ingest, then
  // pins theme+themeVersion on the doc so later updates can stay content-only.
  // `html`/`files` authoring is unchanged and leaves the doc themeless.
  theme?: string;
  content?: string;
  // Quick-doc fields (set together, only for ownerless creates): the sha256 of
  // the edit key, and the initial rolling expiry.
  quickKeyHash?: string;
  expiresAt?: Date;
}

export interface UpdateDocInput {
  docId: string;
  title?: string;
  html?: string;
  files?: InputFile[];
  // Content-only update for a themed doc: if the doc has a pinned theme and no
  // `html`/`files` are supplied, the server re-wraps `content` with the doc's
  // theme. Sending `html` instead full-replaces the page, exactly as before.
  content?: string;
  assistant?: string;
  autoPublish?: boolean; // P1 default true; P3 review flow sets false
  /** Quick-key writes only: fail with DocClaimedError if the doc has an owner
   * (checked again under the write lock, closing the check-then-claim race). */
  requireUnclaimed?: boolean;
  /** Optimistic concurrency: if set, the write fails with StaleVersionError
   * unless the doc's latest version is still this id when the row lock is taken.
   * Read-modify-write callers (patch, inline-edit) pass the version they read so
   * a concurrent commit in the read→write window can't be silently clobbered. */
  expectedLatestVersionId?: string;
  /** Agent-key writes only: the agent_keys.id backing this request. The row is
   * re-checked `FOR UPDATE` inside the write transaction and the write fails with
   * AgentKeyRevokedError if the key is gone or revoked — closing the window
   * between the route's pre-check and the commit (a concurrent revoke either
   * commits before our lock, so we abort, or blocks until we commit, so it only
   * affects later writes). The quick path gets the same atomicity from
   * requireUnclaimed's in-transaction CAS. */
  requireAgentKeyLive?: string;
}

export interface VersionResult {
  docId: string;
  slug: string;
  versionId: string;
  ordinal: number;
  url: string;
  unchanged: boolean;
  // The doc's pinned theme + CSS version, or null on raw-HTML docs. Lets callers
  // tell an agent a doc is themed (so it can send content-only updates).
  theme?: string | null;
  themeVersion?: number | null;
}

function viewerUrl(slug: string): string {
  return `${config.appOrigin}/d/${slug}`;
}

const themeIds = () => listThemes().map((t) => t.id);

/**
 * Resolve the authoring inputs to the HTML to ingest, enforcing the theme
 * contract so an agent's content is never silently dropped:
 *  - theme + content  → wrap content in the theme (pin it)
 *  - theme + html/files → error (the theme provides the shell; pick one)
 *  - theme, no content  → error (nothing to wrap)
 *  - content, no theme  → error (nothing to wrap it in; send html for raw)
 *  - html/files, no theme → raw authoring, unchanged
 * `themeOf` is the doc's already-pinned theme (updates); null for creates.
 */
function resolveAuthoring(
  input: {
    html?: string;
    files?: InputFile[];
    theme?: string;
    content?: string;
  },
  themeOf: string | null,
): { html?: string; theme: string | null; themeVersion: number | null } {
  const hasFiles = Array.isArray(input.files) && input.files.length > 0;
  const hasContent =
    typeof input.content === "string" && input.content.trim() !== "";

  // Explicit theme on the request → themed authoring.
  if (input.theme != null) {
    const t = getTheme(input.theme); // throws unknown_theme
    if (input.html != null || hasFiles)
      throw new ThemeError(
        "theme_conflicts_with_html",
        "Send `content` with `theme`, not `html`/`files` — the theme provides the page shell.",
        themeIds(),
      );
    if (!hasContent)
      throw new ThemeError(
        "content_required",
        "A themed create needs non-empty `content` (the body HTML to wrap in the theme).",
        themeIds(),
      );
    return {
      html: wrapWithTheme(input.content!, t.id),
      theme: t.id,
      themeVersion: t.version,
    };
  }

  // Content-only against a doc that already has a pinned theme → re-wrap.
  if (input.html == null && !hasFiles && input.content != null) {
    if (!themeOf)
      throw new ThemeError(
        "content_needs_theme",
        "`content` requires a `theme`. Send `html` for a raw self-contained page, or add a `theme`.",
        themeIds(),
      );
    const t = getTheme(themeOf);
    return {
      html: wrapWithTheme(input.content, t.id),
      theme: t.id,
      themeVersion: t.version,
    };
  }

  // Raw html/files authoring — themeless (or leaves an existing pin untouched).
  return { html: input.html, theme: null, themeVersion: null };
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

/**
 * Serialize a writer against the blob GC (deleteDocDeep) per content hash: take
 * a Postgres advisory xact lock on every referenced sha. SORTED, so two writers
 * or a writer+GC touching overlapping sha sets always acquire in the same order
 * and can never deadlock. Held until the surrounding transaction commits. The
 * GC (deleteDocDeep) takes the same locks on its candidate shas before its
 * reference-count query, so the two can never interleave: either the writer's
 * version row commits first (the GC's ref-count sees it and keeps the blob) or
 * the GC deletes first (the writer's recordBlobRows then finds the row gone and
 * re-persists — see recordBlobRows / the post-commit reput in create/updateDoc).
 */
async function lockShas(tx: Tx, shas: string[]): Promise<void> {
  for (const sha of [...new Set(shas)].sort()) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${sha}))`);
  }
}

/**
 * Record content-addressed blob bookkeeping rows for a version. Returns the shas
 * whose row was ABSENT at insert time (a fresh insert, not a dedup conflict):
 * the blob GC deleted that row after our putBlob, having judged the sha orphaned
 * before this version's row committed. The caller re-persists those bytes AFTER
 * commit (a putBlob inside the txn would deadlock the pg driver, which reuses the
 * pooled `db` connection against the row we just row-locked here). Callers MUST
 * hold the per-sha advisory locks (lockShas) so this insert is serialized against
 * the GC's row deletion. (For the fs/r2 drivers the row is only ever created
 * here, so a new sha always reports "absent" and the reput is a harmless
 * idempotent no-op — the signal is precise only for the pg driver, where putBlob
 * creates the row with its bytes.)
 */
async function recordBlobRows(tx: Tx, ing: IngestResult): Promise<string[]> {
  const missing: string[] = [];
  for (const f of ing.files) {
    const inserted = await tx
      .insert(blobsTable)
      .values({
        sha256: f.sha256,
        byteSize: f.bytes.byteLength,
        storageKey: `blobs/${f.sha256}`,
      })
      .onConflictDoNothing()
      .returning({ sha256: blobsTable.sha256 });
    if (inserted.length > 0) missing.push(f.sha256);
  }
  return missing;
}

/** Re-persist bytes for shas the GC removed between our putBlob and our version
 * commit (recordBlobRows flagged their row as freshly (re)created). Runs after
 * the write txn so the committed version reference is never left dangling. */
async function reputMissing(
  store: BlobStore,
  ing: IngestResult,
  missingShas: string[],
): Promise<void> {
  for (const sha of missingShas) {
    const f = ing.files.find((x) => x.sha256 === sha);
    if (f) await store.putBlob(sha, f.bytes);
  }
}

export async function createDoc(input: CreateDocInput): Promise<VersionResult> {
  // Themed authoring: wrap the agent's semantic body content in the theme's
  // stylesheet and pin the theme+version. resolveAuthoring enforces the
  // theme/content/html contract (ThemeError, surfaced as 400 by callers) so an
  // agent's html or content is never silently dropped. Raw html/files authoring
  // leaves the doc themeless — behaves exactly as before.
  const { html, theme, themeVersion } = resolveAuthoring(input, null);

  const ing = ingest({ html, files: input.files });

  const docId = newId("doc");
  const slug = makeSlug(input.title);
  const renderId = newRenderId();
  const versionId = newId("ver");

  // Storage first (blobs + manifest), then the DB refs.
  const store = getBlobStore();
  await persistContent(store, versionId, ing);

  let missingShas: string[] = [];
  await db.transaction(async (tx) => {
    // F0: serialize against the blob GC before touching any blob row.
    await lockShas(tx, ing.files.map((f) => f.sha256));
    await tx.insert(docs).values({
      id: docId,
      slug,
      renderId,
      ownerId: input.ownerId,
      title: input.title ?? null,
      quickKeyHash: input.quickKeyHash ?? null,
      expiresAt: input.expiresAt ?? null,
      theme,
      themeVersion,
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
    missingShas = await recordBlobRows(tx, ing);
    // P1 auto-publishes so paste -> URL renders immediately.
    await tx
      .update(docs)
      .set({ latestVersionId: versionId, publishedVersionId: versionId })
      .where(eq(docs.id, docId));
  });
  await reputMissing(store, ing, missingShas);

  return {
    docId,
    slug,
    versionId,
    ordinal: 1,
    url: viewerUrl(slug),
    unchanged: false,
    theme,
    themeVersion,
  };
}

/** Thrown when a write required an unclaimed doc but the doc was claimed
 * (key burned) between the caller's auth check and the write transaction. */
export class DocClaimedError extends Error {
  constructor(docId: string) {
    super(`doc ${docId} was claimed; quick-key writes no longer apply`);
    this.name = "DocClaimedError";
  }
}

/** Thrown when an optimistic-concurrency write (expectedLatestVersionId) finds
 * the doc has moved on — the caller must re-read and reapply (surfaced as 409). */
export class StaleVersionError extends Error {
  constructor(
    public docId: string,
    public currentVersionId: string | null,
  ) {
    super(`doc ${docId} changed since read (latest is ${currentVersionId})`);
    this.name = "StaleVersionError";
  }
}

/** Thrown when an agent-key write (requireAgentKeyLive) finds the key gone or
 * revoked under the write lock — the key was revoked between the route's
 * pre-check and the commit (surfaced as 403 key_revoked). */
export class AgentKeyRevokedError extends Error {
  constructor(public keyId: string) {
    super(`agent key ${keyId} was revoked; the write no longer applies`);
    this.name = "AgentKeyRevokedError";
  }
}

export async function updateDoc(input: UpdateDocInput): Promise<VersionResult> {
  const doc = (
    await db.select().from(docs).where(eq(docs.id, input.docId)).limit(1)
  )[0];
  if (!doc) throw new Error(`doc not found: ${input.docId}`);
  if (input.requireUnclaimed && doc.ownerId !== null)
    throw new DocClaimedError(doc.id);
  // Fast-fail CAS (also re-checked under the row lock below): if the caller read
  // a version that is already stale, don't even ingest.
  if (
    input.expectedLatestVersionId != null &&
    doc.latestVersionId !== input.expectedLatestVersionId
  )
    throw new StaleVersionError(doc.id, doc.latestVersionId);

  // Resolve authoring inputs (theme contract enforced): content-only against a
  // themed doc re-wraps in the pinned theme; html/files full-replace as before.
  const authored = resolveAuthoring(input, doc.theme);
  const html = authored.html;
  // Re-pin only when we (re-)themed — a raw html/files replace leaves the
  // existing pin untouched; a content-only re-wrap refreshes themeVersion so the
  // pin always matches the CSS actually in the stored page.
  const nextTheme = authored.theme != null ? authored.theme : doc.theme;
  const nextThemeVersion =
    authored.theme != null ? authored.themeVersion : doc.themeVersion;

  const ing = ingest({ html, files: input.files });

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
        theme: nextTheme,
        themeVersion: nextThemeVersion,
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
  const store = getBlobStore();
  const newVersionId = existing ? null : newId("ver");
  if (newVersionId) {
    await persistContent(store, newVersionId, ing);
  }

  let missingShas: string[] = [];
  const result = await db.transaction(async (tx) => {
    // Lock the doc row: serializes ordinal assignment + ref moves against
    // concurrent update_doc calls (no duplicate ordinal).
    const locked = (
      await tx
        .select({
          latestVersionId: docs.latestVersionId,
          ownerId: docs.ownerId,
        })
        .from(docs)
        .where(eq(docs.id, doc.id))
        .for("update")
    )[0];

    // Quick-key writes must not land on a doc claimed after the caller's auth
    // check (the burned key "stops granting anything") — re-verify under the
    // row lock, where a concurrent claim can no longer interleave.
    if (input.requireUnclaimed && locked?.ownerId != null)
      throw new DocClaimedError(doc.id);

    // Agent-key writes: re-check the key IS still live under a row lock, closing
    // the window between the route's pre-check and this commit. A concurrent
    // revoke (plain UPDATE) either committed first — we see revokedAt and abort —
    // or blocks on this lock until we commit, so it only affects later writes.
    // Residual (accepted): revoking the MINTER's underlying grant mid-flight is
    // not caught here (effective role is computed at auth via attenuate); it lands
    // on the next write. Only direct key revocation is made atomic.
    if (input.requireAgentKeyLive != null) {
      const k = (
        await tx
          .select({ id: agentKeys.id, revokedAt: agentKeys.revokedAt })
          .from(agentKeys)
          .where(eq(agentKeys.id, input.requireAgentKeyLive))
          .for("update")
      )[0];
      if (!k || k.revokedAt != null)
        throw new AgentKeyRevokedError(input.requireAgentKeyLive);
    }

    // Optimistic-concurrency CAS under the lock: a read-modify-write caller
    // patched the version it read; if another write committed in between, the
    // patch is stale and would silently clobber it — reject instead.
    if (
      input.expectedLatestVersionId != null &&
      locked?.latestVersionId !== input.expectedLatestVersionId
    )
      throw new StaleVersionError(doc.id, locked?.latestVersionId ?? null);

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
      // F0: serialize against the blob GC before touching any blob row (doc row
      // is already locked above, so lock ordering is doc-row → shas everywhere).
      await lockShas(tx, ing.files.map((f) => f.sha256));
      missingShas = await recordBlobRows(tx, ing);
    }

    const set: {
      latestVersionId: string;
      publishedVersionId?: string;
      theme?: string | null;
      themeVersion?: number | null;
    } = { latestVersionId: versionId };
    if (input.autoPublish !== false) set.publishedVersionId = versionId;
    // Persist the theme pin only when we (re-)themed this write, so themeVersion
    // always matches the CSS in the stored page (a raw replace leaves it alone).
    if (authored.theme != null) {
      set.theme = nextTheme;
      set.themeVersion = nextThemeVersion;
    }
    await tx.update(docs).set(set).where(eq(docs.id, doc.id));

    return { versionId, ordinal };
  });

  await reputMissing(store, ing, missingShas);

  // P5: re-anchor comments (and reader interactions) against the new content.
  if (!existing) {
    const html = htmlOf(ing);
    if (html) {
      await reanchorComments(doc.id, result.versionId, html);
      await reanchorInteractions(doc.id, result.versionId, html);
    }
  }

  return {
    docId: doc.id,
    slug: doc.slug,
    versionId: result.versionId,
    ordinal: result.ordinal,
    url: viewerUrl(doc.slug),
    unchanged: false,
    theme: nextTheme,
    themeVersion: nextThemeVersion,
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

/** What deleteDocDeep removed — the purge job logs/aggregates these counts. */
export interface DeleteDocDetail {
  versionIds: string[];
  orphanShas: string[];
}

/** State of the doc read `FOR UPDATE` just before deletion, handed to a
 * {@link DeleteGuard} so the caller can veto a delete that has been overtaken by
 * a concurrent claim/expiry/quarantine change. */
export interface DeleteGuardState {
  ownerId: string | null;
  expiresAt: Date | null;
  quarantined: boolean;
}

/**
 * Under-row-lock deletion guard: return true to proceed, false to abort. A claim
 * (or any state change) landing between the caller's auth check and this lock
 * flips the state, so the guard fails and the delete is refused — the claim wins
 * the race. Owner-initiated deletes pass no guard (they hold a session ACL, not
 * a race-prone key).
 */
export type DeleteGuard = (state: DeleteGuardState) => boolean;

/**
 * Permanently delete a doc. The docs row delete cascades to versions, comments,
 * shares, and network grants. Blobs are content-addressed and dedup'd across
 * docs, so a blob is purged only when no surviving version still references its
 * sha — computed inside the same transaction as the delete. External storage
 * cleanup runs after commit and is best-effort (F7): a leftover content-addressed
 * blob is unreachable, unreferenced garbage, never a broken doc, so a store error
 * must not fail an already-committed delete.
 *
 * F0 (blob GC vs. concurrent writer): before the reference-count query we take a
 * per-sha advisory xact lock on every candidate sha (see lockShas), the same
 * locks create/updateDoc take on the shas they reference. That serializes this
 * GC against in-flight writers so we can never delete bytes a writer is about to
 * reference: writer-first → our ref-count sees the new version and keeps the
 * blob; GC-first → the writer's recordBlobRows finds the row gone and re-persists.
 * The post-commit store.deleteBlob is only for fs/r2 file removal (the pg driver
 * deleted the bytes with the row, under the lock). For pg that call is a
 * reference-guarded, atomic DELETE (see pgBlobStore.deleteBlob) so it can never
 * stomp a writer's restore. For fs/r2 a narrow residual remains — the file rm is
 * post-commit and not atomic with a reference re-check — but it self-heals on the
 * next write of that content, fs is dev-only, and the deployed driver is pg.
 *
 * `guard`: a predicate re-checked under the row lock (see {@link DeleteGuard}).
 *
 * Returns what was removed, or null if the doc is missing / the guard failed.
 */
export async function deleteDocDeep(
  docId: string,
  guard?: DeleteGuard,
): Promise<DeleteDocDetail | null> {
  const result = await db.transaction(async (tx) => {
    const doc = (
      await tx
        .select({
          id: docs.id,
          ownerId: docs.ownerId,
          expiresAt: docs.expiresAt,
          quarantined: docs.quarantined,
        })
        .from(docs)
        .where(eq(docs.id, docId))
        .for("update")
    )[0];
    if (!doc) return null;
    if (
      guard &&
      !guard({
        ownerId: doc.ownerId,
        expiresAt: doc.expiresAt,
        quarantined: doc.quarantined,
      })
    )
      return null;

    const versions = await tx
      .select({ id: docVersions.id, manifest: docVersions.manifest })
      .from(docVersions)
      .where(eq(docVersions.docId, docId));
    const candidateShas = [
      ...new Set(
        versions.flatMap((v) => Object.values((v.manifest ?? {}) as Manifest)),
      ),
    ];

    // F0: lock every candidate sha BEFORE the reference-count query so a
    // concurrent writer can't reference a sha we're about to judge orphaned.
    await lockShas(tx, candidateShas);

    await tx.delete(docs).where(eq(docs.id, docId));

    let orphanShas: string[] = [];
    if (candidateShas.length > 0) {
      // Shas still referenced by any surviving version of any doc stay put.
      const shaList = sql.join(
        candidateShas.map((s) => sql`${s}`),
        sql`, `,
      );
      const res = await tx.execute(sql`
        select distinct e.value as sha
        from ${docVersions}, jsonb_each_text(${docVersions.manifest}) as e
        where e.value in (${shaList})
      `);
      // Driver-shape tolerant: postgres.js returns an array-like RowList;
      // other pg drivers (e.g. PGlite in tests) return { rows: [...] }.
      const rows: Record<string, unknown>[] = Array.isArray(res)
        ? (res as Record<string, unknown>[])
        : ((res as { rows?: Record<string, unknown>[] }).rows ?? []);
      const referenced = new Set(rows.map((r) => r.sha as string));
      orphanShas = candidateShas.filter((s) => !referenced.has(s));
      if (orphanShas.length > 0) {
        await tx
          .delete(blobsTable)
          .where(inArray(blobsTable.sha256, orphanShas));
      }
    }

    return { versionIds: versions.map((v) => v.id), orphanShas };
  });

  if (!result) return null;

  // F7: post-commit store cleanup is best-effort. The delete already committed;
  // a transient store error here must not turn a done delete into a 500 "failed"
  // lie. Any bytes left behind are content-addressed and unreferenced — harmless
  // garbage the next purge (or a future GC) can reclaim.
  const store = getBlobStore();
  for (const versionId of result.versionIds) {
    try {
      await store.deleteManifest(versionId);
    } catch (e) {
      console.warn(`[delete] manifest cleanup failed for ${versionId}:`, e);
    }
  }
  for (const sha of result.orphanShas) {
    try {
      await store.deleteBlob(sha);
    } catch (e) {
      console.warn(`[delete] blob cleanup failed for ${sha}:`, e);
    }
  }
  return result;
}

/** Permanently delete a doc (owner-initiated path). Returns false if missing. */
export async function deleteDoc(docId: string): Promise<boolean> {
  return (await deleteDocDeep(docId)) !== null;
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
