import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { connectionUrl, createSql } from "./client";

const migrationsFolder = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../drizzle",
);

const sql = createSql(connectionUrl());
const db = drizzle(sql);
await migrate(db, { migrationsFolder });
await sql.end();
console.log(`[db] migrations applied from ${migrationsFolder}`);
process.exit(0);
