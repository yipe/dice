// Bundles the Rust-backed @yipe/dice drop-in package into rust/dice-node/pkg (see build-pkg.sh).
import { build } from "esbuild";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync, cpSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const srcDir = join(repo, "src") + "/";
const facadeDir = join(here, "ts") + "/";
const pkg = join(here, "pkg");
const dist = join(pkg, "dist");

/** Same redirect as vitest.rust.config.ts: src/<path>.ts -> rust/dice-node/ts/<path>.ts when it exists. */
const rustFacade = {
  name: "dice-rust-facade",
  setup(b) {
    b.onResolve({ filter: /^\.\.?(\/|$)/ }, async (args) => {
      if (args.pluginData === "facade-skip" || args.importer.startsWith(facadeDir)) return null;
      const r = await b.resolve(args.path, {
        importer: args.importer,
        resolveDir: args.resolveDir,
        kind: args.kind,
        pluginData: "facade-skip",
      });
      if (r.errors.length || !r.path.startsWith(srcDir) || !r.path.endsWith(".ts")) return null;
      const facade = join(facadeDir, r.path.slice(srcDir.length));
      return existsSync(facade) ? { path: facade } : null;
    });
  },
};

rmSync(pkg, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const entries = { index: "src/index.ts", "builder/index": "src/builder/index.ts", "dnd5e/index": "src/dnd5e/index.ts" };
const common = {
  absWorkingDir: repo,
  bundle: true,
  platform: "node",
  target: "node20",
  sourcemap: true,
  plugins: [rustFacade],
  logLevel: "warning",
  // native.ts locates dice.node as `../dice.node` relative to import.meta.url; every bundle file lives
  // in dist/ (shared chunks, core) so that resolves to pkg/dice.node.
  define: { "import.meta.url": "__diceBundleUrl" },
};

// ESM: code splitting puts the shared modules (PMF, error classes, caches) in chunks both entries
// import, so `instanceof PMF` holds across entry points (same reason as config/tsup.config.ts).
await build({
  ...common,
  entryPoints: entries,
  outdir: dist,
  format: "esm",
  splitting: true,
  chunkNames: "chunk-[hash]",
  banner: { js: 'const __diceBundleUrl = import.meta.url;' },
});

// CJS: esbuild cannot split CJS, so one `core.cjs` holds everything and the entries re-export it.
const core = join(pkg, "core-entry.ts");
writeFileSync(
  core,
  Object.entries({ index: "src/index", builder: "src/builder/index", dnd5e: "src/dnd5e/index" })
    .map(([name, path]) => `export * as ${name} from ${JSON.stringify(join(repo, path))};`)
    .join("\n") + "\n"
);
await build({
  ...common,
  entryPoints: { core: core },
  outdir: dist,
  format: "cjs",
  outExtension: { ".js": ".cjs" },
  banner: { js: 'const __diceBundleUrl = require("node:url").pathToFileURL(__filename).href;' },
});
rmSync(core);
for (const [name, entry] of [
  ["index", "index"],
  ["builder/index", "builder"],
  ["dnd5e/index", "dnd5e"],
]) {
  const depth = name.split("/").length - 1;
  const rel = (depth ? "../".repeat(depth) : "./") + "core.cjs";
  mkdirSync(dirname(join(dist, name)), { recursive: true });
  writeFileSync(join(dist, `${name}.cjs`), `"use strict";\nmodule.exports = require(${JSON.stringify(rel)}).${entry};\n`);
}

// package.json: the published one with the scripts/devDependencies stripped.
const published = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
const out = {
  name: published.name,
  version: published.version,
  description: published.description + " (Rust-backed build)",
  license: published.license,
  type: "module",
  exports: published.exports,
  main: published.main,
  module: published.module,
  types: published.types,
  typesVersions: published.typesVersions,
  sideEffects: published.sideEffects,
  files: ["dist", "dice.node"],
};
writeFileSync(join(pkg, "package.json"), JSON.stringify(out, null, 2) + "\n");
copyFileSync(join(here, "dice.node"), join(pkg, "dice.node"));
console.log(`built ${pkg}`);
