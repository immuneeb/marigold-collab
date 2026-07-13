import { chmodSync, readFileSync } from "node:fs";
import { build } from "esbuild";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

await build({
  entryPoints: ["src/cli.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: "dist/cli.cjs",
  banner: { js: "#!/usr/bin/env node" },
  // Version marker sent as X-Marigold-Source on `share` uploads (share.ts) —
  // baked at build time so dist always matches the published version.
  define: { __MARIGOLD_DRAFT_VERSION__: JSON.stringify(pkg.version) },
  logLevel: "info",
});
chmodSync("dist/cli.cjs", 0o755);
