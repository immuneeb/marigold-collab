import { createHash, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  db,
  oauthClients,
  oauthCodes,
  oauthRefreshTokens,
} from "@marigold/db";
import { oauthConfig } from "./config";

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// ── clients (DCR) ────────────────────────────────────────────────────────────

export interface ClientRow {
  clientId: string;
  clientName: string | null;
  redirectUris: string[];
}

export async function createClient(meta: {
  clientName?: string | null;
  redirectUris: string[];
}): Promise<ClientRow> {
  const clientId = `mcp_${randomToken(16)}`;
  await db.insert(oauthClients).values({
    clientId,
    clientName: meta.clientName ?? null,
    redirectUris: meta.redirectUris,
  });
  return {
    clientId,
    clientName: meta.clientName ?? null,
    redirectUris: meta.redirectUris,
  };
}

export async function getClient(clientId: string): Promise<ClientRow | null> {
  const row = (
    await db
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.clientId, clientId))
      .limit(1)
  )[0];
  if (!row) return null;
  return {
    clientId: row.clientId,
    clientName: row.clientName,
    redirectUris: (row.redirectUris as string[]) ?? [],
  };
}

// ── authorization codes (one-time) ───────────────────────────────────────────

export interface NewCode {
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  resource: string | null;
  scope: string;
}

export async function createCode(data: NewCode): Promise<string> {
  const code = randomToken(32);
  await db.insert(oauthCodes).values({
    code,
    ...data,
    expiresAt: new Date(Date.now() + oauthConfig.codeTtl * 1000),
  });
  return code;
}

/** Fetch and delete the code (one-time use). Returns null if absent. */
export async function consumeCode(code: string) {
  const row = (
    await db.select().from(oauthCodes).where(eq(oauthCodes.code, code)).limit(1)
  )[0];
  if (row) await db.delete(oauthCodes).where(eq(oauthCodes.code, code));
  return row ?? null;
}

// ── refresh tokens (opaque, hashed at rest) ──────────────────────────────────

export async function createRefreshToken(data: {
  clientId: string;
  userId: string;
  scope: string;
  resource: string | null;
}): Promise<string> {
  const token = randomToken(32);
  await db
    .insert(oauthRefreshTokens)
    .values({ tokenHash: hashToken(token), ...data });
  return token;
}

export async function getRefreshToken(token: string) {
  return (
    (
      await db
        .select()
        .from(oauthRefreshTokens)
        .where(
          and(
            eq(oauthRefreshTokens.tokenHash, hashToken(token)),
            eq(oauthRefreshTokens.revoked, false),
          ),
        )
        .limit(1)
    )[0] ?? null
  );
}
