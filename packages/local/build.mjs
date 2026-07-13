import { chmodSync } from "node:fs";
import { build } from "esbuild";

await build({
  entryPoints: ["src/cli.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: "dist/cli.cjs",
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "info",
});
chmodSync("dist/cli.cjs", 0o755);
