import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import type { NextConfig } from "next";

// Single source of truth for env: the monorepo-root .env (if present). Next only
// auto-loads .env from the app dir, so we pull the root one in here. Code also
// has sane local defaults, so the app boots with no .env at all.
loadEnv({ path: resolve(process.cwd(), "../../.env") });

// Agent discovery: doc and docs-API responses point at the HTTP reference.
const serviceDoc = [{ key: "Link", value: '</agents.md>; rel="service-doc"' }];

const nextConfig: NextConfig = {
  // Compile the workspace TS packages (they ship raw source).
  // The app talks to Postgres over the wire (postgres.js) — no WASM DB bundled.
  transpilePackages: ["@marigold/db", "@marigold/core"],
  async headers() {
    return [
      { source: "/d/:path*", headers: serviceDoc },
      { source: "/api/docs/:path*", headers: serviceDoc },
      { source: "/api/quick", headers: serviceDoc },
    ];
  },
};

export default nextConfig;
