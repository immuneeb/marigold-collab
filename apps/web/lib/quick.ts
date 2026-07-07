import { sql } from "drizzle-orm";
import { sha256Hex, verifyQuickKey } from "@marigold/core";
import { db, quickCreations } from "@marigold/db";

// Quick-doc plumbing for the HTTP door: key extraction from requests, the
// unclaimed/claimed/expired access decision, and DB-backed creation rate
// limiting. Key checks are additive branches for unclaimed docs only — owned
// docs never consult any of this.

/** The quick key as presented by the caller: `?k=` or `X-Marigold-Key`. */
export function requestQuickKey(req: Request): string | null {
  const header = req.headers.get("x-marigold-key");
  if (header) return header.trim();
  const k = new URL(req.url).searchParams.get("k");
  return k ? k.trim() : null;
}

export type QuickDocRow = {
  ownerId: string | null;
  quickKeyHash: string | null;
  expiresAt: Date | null;
};

export type QuickAccess = "granted" | "expired" | "invalid_key" | "claimed";

/**
 * Can this key act on this doc? `claimed` covers owned docs and burned keys
 * (both have quickKeyHash null); `expired` only ever fires for a VALID key on
 * an unclaimed doc — an attacker never learns expiry state from a bad key.
 */
export function quickAccess(doc: QuickDocRow, key: string | null): QuickAccess {
  if (doc.ownerId !== null || !doc.quickKeyHash) return "claimed";
  if (!verifyQuickKey(key, doc.quickKeyHash)) return "invalid_key";
  if (doc.expiresAt && doc.expiresAt.getTime() <= Date.now()) return "expired";
  return "granted";
}

/** True only for a live, unclaimed quick doc opened with its valid key. */
export function quickKeyGrants(doc: QuickDocRow, key: string | null): boolean {
  return quickAccess(doc, key) === "granted";
}

function clientIpOf(req: Request): string {
  // Vercel/most proxies: first hop of x-forwarded-for is the client.
  const fwd = req.headers.get("x-forwarded-for");
  const first = fwd?.split(",")[0]?.trim();
  if (first) return first;
  return req.headers.get("x-real-ip") ?? "local";
}

export function quickCreateCap(): number {
  return Number(process.env.QUICK_CREATES_PER_DAY ?? 20);
}

/**
 * Count an unclaimed-doc creation against the caller's hashed IP for today
 * (UTC). Atomic upsert — concurrent creates can't slip past the cap. Only a
 * salted hash of the IP is ever stored.
 */
export async function checkQuickCreateLimit(
  req: Request,
): Promise<{ ok: boolean; cap: number }> {
  const cap = quickCreateCap();
  const ipHash = sha256Hex(
    `${process.env.AUTH_SECRET ?? ""}:quick:${clientIpOf(req)}`,
  );
  const day = new Date().toISOString().slice(0, 10);
  const row = (
    await db
      .insert(quickCreations)
      .values({ ipHash, day, count: 1 })
      .onConflictDoUpdate({
        target: [quickCreations.ipHash, quickCreations.day],
        set: { count: sql`${quickCreations.count} + 1` },
      })
      .returning({ count: quickCreations.count })
  )[0];
  return { ok: (row?.count ?? 1) <= cap, cap };
}
