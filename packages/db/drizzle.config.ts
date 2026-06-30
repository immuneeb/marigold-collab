import { defineConfig } from "drizzle-kit";

// `generate` only needs the schema + dialect (no DB connection). Migrations are
// emitted as SQL into ./drizzle and applied by src/migrate.ts (PGlite locally,
// or `drizzle-kit migrate` against Neon in prod).
export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
});
