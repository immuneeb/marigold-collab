import { and, asc, isNotNull, isNull, lt } from "drizzle-orm";
import { db, docs, loginTokens, quickCreations } from "@marigold/db";
import { deleteDocDeep } from "./versioning";

// Purge job (MUN-66): `expiresAt` only GATES access — this is the thing that
// actually removes expired unclaimed quick docs (doc rows, cascaded version
// rows, and content-addressed blob bytes) plus stale per-IP-per-day rate-limit
// buckets. Runs from the daily cron route (apps/web/app/api/cron/purge).

/**
 * Grace window between "expired" (access gated) and "purged" (rows gone).
 * Claiming RESCUES an expired doc — "sign in and claim to restore" — so purge
 * must never fire the moment a doc expires. Default 14 days: restorable for
 * two weeks after expiry, then gone for good.
 */
export const DEFAULT_PURGE_GRACE_DAYS = 14;

/** Docs deleted per run. Each doc is its own transaction, so a slow/failed run
 * makes forward progress; the next daily run drains the rest. */
export const DEFAULT_PURGE_BATCH = 100;

/** `quick_creations` rows are per-IP-per-UTC-day buckets — only today's bucket
 * is ever read, so anything older than a week is pure dead weight. */
export const QUICK_CREATIONS_RETENTION_DAYS = 7;

/** Magic-link tokens are single-use with a 15-min TTL; a week past expiry they
 * are dead weight (consumed or not). Kept a few days only for support/forensics. */
export const LOGIN_TOKENS_RETENTION_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Grace days: `PURGE_GRACE_DAYS` env override, else the 14-day default. */
export function purgeGraceDays(): number {
  const raw = process.env.PURGE_GRACE_DAYS;
  if (raw != null && raw.trim() !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return DEFAULT_PURGE_GRACE_DAYS;
}

export interface PurgeDocsResult {
  /** Candidates matched this run (≤ batch); if it equals batch there may be
   * more — the next run picks them up. */
  candidates: number;
  docs: number;
  versions: number;
  blobs: number;
  graceDays: number;
  cutoff: string; // ISO timestamp: purged docs expired before this
}

/**
 * Purge unclaimed quick docs whose expiry is more than `graceDays` in the
 * past. Criteria (also re-checked per doc under the row lock in
 * deleteDocDeep, so a concurrent claim always wins):
 *
 *   ownerId IS NULL AND expiresAt IS NOT NULL AND expiresAt < now - graceDays
 *
 * Claimed docs are never touched (claiming sets ownerId and clears expiresAt).
 * Blobs are content-addressed and shared across docs; deleteDocDeep only
 * removes a blob once no surviving version of ANY doc references its sha.
 * Idempotent: a second run over the same data deletes nothing.
 */
export async function purgeExpiredQuickDocs(
  opts: { graceDays?: number; batch?: number; now?: Date } = {},
): Promise<PurgeDocsResult> {
  const graceDays = opts.graceDays ?? purgeGraceDays();
  const batch = opts.batch ?? DEFAULT_PURGE_BATCH;
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - graceDays * DAY_MS);

  const candidates = await db
    .select({ id: docs.id })
    .from(docs)
    .where(
      and(
        isNull(docs.ownerId),
        isNotNull(docs.expiresAt),
        lt(docs.expiresAt, cutoff),
      ),
    )
    .orderBy(asc(docs.expiresAt))
    .limit(batch);

  let docsPurged = 0;
  let versionsPurged = 0;
  let blobsPurged = 0;
  for (const { id } of candidates) {
    const detail = await deleteDocDeep(
      id,
      (d) =>
        d.ownerId === null &&
        d.expiresAt !== null &&
        d.expiresAt.getTime() < cutoff.getTime(),
    );
    if (!detail) continue; // claimed (or gone) since selection — skip, never delete
    docsPurged += 1;
    versionsPurged += detail.versionIds.length;
    blobsPurged += detail.orphanShas.length;
  }

  return {
    candidates: candidates.length,
    docs: docsPurged,
    versions: versionsPurged,
    blobs: blobsPurged,
    graceDays,
    cutoff: cutoff.toISOString(),
  };
}

export interface PurgeQuickCreationsResult {
  rows: number;
  cutoffDay: string; // UTC "YYYY-MM-DD": rows with day < this were removed
}

/**
 * Delete `quick_creations` rate-limit rows older than the retention window
 * (default 7 days). `day` is a UTC "YYYY-MM-DD" string, so a plain `<` string
 * comparison is chronological. Idempotent.
 */
export async function purgeStaleQuickCreations(
  opts: { retentionDays?: number; now?: Date } = {},
): Promise<PurgeQuickCreationsResult> {
  const retentionDays = opts.retentionDays ?? QUICK_CREATIONS_RETENTION_DAYS;
  const now = opts.now ?? new Date();
  const cutoffDay = new Date(now.getTime() - retentionDays * DAY_MS)
    .toISOString()
    .slice(0, 10);

  const deleted = await db
    .delete(quickCreations)
    .where(lt(quickCreations.day, cutoffDay))
    .returning({ day: quickCreations.day });

  return { rows: deleted.length, cutoffDay };
}

export interface PurgeLoginTokensResult {
  rows: number;
  cutoff: string; // ISO timestamp: tokens that expired before this were removed
}

/**
 * Delete magic-link tokens whose expiry is more than the retention window
 * (default 7 days) in the past — consumed or not. They are single-use and
 * short-TTL, so a long-expired row can never authenticate anything; this just
 * keeps `login_tokens` from growing without bound. Idempotent.
 */
export async function purgeStaleLoginTokens(
  opts: { retentionDays?: number; now?: Date } = {},
): Promise<PurgeLoginTokensResult> {
  const retentionDays = opts.retentionDays ?? LOGIN_TOKENS_RETENTION_DAYS;
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);

  const deleted = await db
    .delete(loginTokens)
    .where(lt(loginTokens.expiresAt, cutoff))
    .returning({ tokenHash: loginTokens.tokenHash });

  return { rows: deleted.length, cutoff: cutoff.toISOString() };
}
