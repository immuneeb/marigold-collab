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
  // Only trust values a platform proxy sets, never the client-controlled end
  // of the chain. Vercel provides x-vercel-forwarded-for / x-real-ip itself;
  // for generic proxies that APPEND to x-forwarded-for, the LAST hop is the
  // one written by the proxy nearest us — the leftmost hop is attacker-chosen
  // and would let one caller mint a fresh rate-limit bucket per request.
  const vercel = req.headers.get("x-vercel-forwarded-for");
  if (vercel) return vercel.split(",")[0]!.trim();
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  const fwd = req.headers.get("x-forwarded-for");
  const last = fwd?.split(",").at(-1)?.trim();
  return last || "local";
}

export function quickCreateCap(): number {
  return Number(process.env.QUICK_CREATES_PER_DAY ?? 20);
}

/**
 * Count an unclaimed-doc creation against the caller's hashed IP for today
 * (UTC). Atomic upsert — concurrent creates can't slip past the cap. Only a
 * salted hash of the IP is ever stored.
 */
function limitBucket(req: Request): { ipHash: string; day: string } {
  return {
    ipHash: sha256Hex(
      `${process.env.AUTH_SECRET ?? ""}:quick:${clientIpOf(req)}`,
    ),
    day: new Date().toISOString().slice(0, 10),
  };
}

export async function checkQuickCreateLimit(
  req: Request,
): Promise<{ ok: boolean; cap: number }> {
  const cap = quickCreateCap();
  const { ipHash, day } = limitBucket(req);
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

/** Best-effort refund when a reserved creation fails validation (e.g. an
 * oversized page): the caller shouldn't lose daily budget to a rejection. */
export async function refundQuickCreate(req: Request): Promise<void> {
  const { ipHash, day } = limitBucket(req);
  await db
    .update(quickCreations)
    .set({ count: sql`greatest(${quickCreations.count} - 1, 0)` })
    .where(
      sql`${quickCreations.ipHash} = ${ipHash} and ${quickCreations.day} = ${day}`,
    );
}
