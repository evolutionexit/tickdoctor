// Bundles the API into dist/ with esbuild. Workspace packages (@tickdoctor/shared ships TS source)
// are inlined; npm dependencies stay external and are installed in the runtime image.
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { build } from "esbuild";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const external = Object.keys(pkg.dependencies ?? {}).filter((d) => !d.startsWith("@tickdoctor/"));

await build({
  entryPoints: { index: "src/index.ts", migrate: "src/db/migrate.ts", cli: "src/cli.ts" },
  outdir: "dist",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  external: [...external, ...external.map((d) => `${d}/*`)],
  logLevel: "info",
});
