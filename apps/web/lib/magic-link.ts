import { and, count, eq, gt, isNull } from "drizzle-orm";
import { config, generateQuickKey, hashQuickKey } from "@marigold/core";
import { db, loginTokens } from "@marigold/db";
import { normalizeEmail, sendMagicLinkEmail } from "./email";

// Magic-link sign-in (MUN-77). Shares are email-keyed and only activate when
// the invitee signs in with that verified address — Google-only sign-in left
// every non-Google invitee stranded. A magic link proves mailbox control the
// same way Google does, so consuming one runs the identical share-binding path.
//
// Token custody mirrors quick docs: 128-bit base62 key in the URL, sha256 in
// the DB, single use, short TTL.

export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000; // 15 minutes
export const MAX_OUTSTANDING_LINKS = 3; // unconsumed+unexpired per email

/**
 * Mint a sign-in token for this address and email the link. Silently a no-op
 * beyond the outstanding-token cap (anti-spam: a stranger repeatedly submitting
 * someone's address can flood their inbox, not our token table). Callers must
 * answer identically whether or not anything was sent — no account enumeration.
 */
export async function requestMagicLink(
  rawEmail: string,
  callbackUrl: string,
): Promise<void> {
  const email = normalizeEmail(rawEmail);
  const now = new Date();

  const outstanding = await db
    .select({ n: count() })
    .from(loginTokens)
    .where(
      and(
        eq(loginTokens.email, email),
        isNull(loginTokens.consumedAt),
        gt(loginTokens.expiresAt, now),
      ),
    );
  if ((outstanding[0]?.n ?? 0) >= MAX_OUTSTANDING_LINKS) return;

  const token = generateQuickKey();
  await db.insert(loginTokens).values({
    tokenHash: hashQuickKey(token),
    email,
    expiresAt: new Date(now.getTime() + MAGIC_LINK_TTL_MS),
  });

  const link = `${config.appOrigin}/login/verify?token=${token}&callbackUrl=${encodeURIComponent(callbackUrl)}`;
  // Deliver to the address as typed (normalization strips +tags, which some
  // mail systems treat as routable); identity/shares key on the normalized form.
  await sendMagicLinkEmail({ to: rawEmail.trim(), link });
}

/**
 * Consume a presented token: single atomic UPDATE … WHERE consumed_at IS NULL
 * RETURNING, so two concurrent clicks race on the row and exactly one wins.
 * Returns the normalized email the token was minted for, or null if the token
 * is unknown, expired, or already consumed.
 */
export async function consumeMagicLinkToken(
  token: string,
): Promise<{ email: string } | null> {
  const now = new Date();
  const rows = await db
    .update(loginTokens)
    .set({ consumedAt: now })
    .where(
      and(
        eq(loginTokens.tokenHash, hashQuickKey(token)),
        isNull(loginTokens.consumedAt),
        gt(loginTokens.expiresAt, now),
      ),
    )
    .returning({ email: loginTokens.email });
  return rows[0] ?? null;
}
