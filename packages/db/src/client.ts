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
  return process.env.DATABASE_URL ?? "postgres://127.0.0.1:5432/marigold";
}

const globalForDb = globalThis as unknown as {
  __marigoldSql?: ReturnType<typeof postgres>;
  __marigoldDb?: DB;
};

function createClient() {
  // prepare:false keeps us compatible with the PGlite socket server and poolers.
  return postgres(connectionUrl(), { prepare: false, max: 10 });
}

const sql = globalForDb.__marigoldSql ?? createClient();
export const db: DB = globalForDb.__marigoldDb ?? drizzle(sql, { schema });

if (process.env.NODE_ENV !== "production") {
  globalForDb.__marigoldSql = sql;
  globalForDb.__marigoldDb = db;
}

export { schema };
