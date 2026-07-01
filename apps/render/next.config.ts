import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import type { NextConfig } from "next";

// Local: pull the monorepo-root .env. On Vercel, env comes from project settings.
loadEnv({ path: resolve(process.cwd(), "../../.env") });

const nextConfig: NextConfig = {
  transpilePackages: ["@marigold/db", "@marigold/core"],
};

export default nextConfig;
