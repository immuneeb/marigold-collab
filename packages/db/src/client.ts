import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type DB = PostgresJsDatabase<typeof schema>;

/**
 * Local dev: a real Postgres (Homebrew) — see README setup. Prod sets
 * DATABASE_URL to Neon. One driver (postgres.js) covers both. The default
 * connects as the OS user (postgres.js fills the username) to the `marigold` db.
 */
export function connectionUrl(): string {
  // Vercel's Postgres/Neon integration injects POSTGRES_URL(_*); support both.
  return (
    process.env.DATABASE_URL ??
    process.env.POSTGRES_URL ??
    process.env.POSTGRES_PRISMA_URL ??
    "postgres://127.0.0.1:5432/marigold"
  );
}

/**
 * postgres.js client. Sets SSL explicitly (it doesn't reliably honor `sslmode`
 * in the URL) and strips params it mishandles (`channel_binding`). Neon and
 * other hosted PG require TLS; localhost does not. prepare:false is
 * pooler/PGlite-safe.
 */
export function createSql(url: string): ReturnType<typeof postgres> {
  const u = new URL(url);
  u.searchParams.delete("channel_binding");
  const sslmode = u.searchParams.get("sslmode");
  u.searchParams.delete("sslmode");
  const isLocal = /^(localhost|127\.0\.0\.1|\[?::1\]?)$/.test(u.hostname);
  const ssl =
    sslmode === "require" || sslmode === "verify-full" || !isLocal
      ? "require"
      : undefined;
  return postgres(u.toString(), { prepare: false, max: 10, ssl });
}

const globalForDb = globalThis as unknown as {
  __marigoldSql?: ReturnType<typeof postgres>;
  __marigoldDb?: DB;
};

function createClient() {
  return createSql(connectionUrl());
}

const sql = globalForDb.__marigoldSql ?? createClient();
export const db: DB = globalForDb.__marigoldDb ?? drizzle(sql, { schema });

if (process.env.NODE_ENV !== "production") {
  globalForDb.__marigoldSql = sql;
  globalForDb.__marigoldDb = db;
}

export { schema };
