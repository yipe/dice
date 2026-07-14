// config/postbuild-dts.mjs
//
// The native TypeScript 7 compiler emits the declaration tree with module
// specifiers written exactly as they appear in source. This package's source
// uses extensionless relative imports (moduleResolution: "bundler"), so the
// emitted .d.ts files contain `export * from "./parser/parser"` etc.
//
// Consumers on `node16`/`nodenext` module resolution require explicit file
// extensions on relative specifiers, so those extensionless re-exports resolve
// to nothing and every named export appears missing. tsup's old bundled-dts
// output sidestepped this by inlining everything into a single file; the Go
// compiler doesn't bundle declarations, so we add the extensions here instead.
//
// Appending `.js` is correct: TypeScript maps a `./x.js` specifier to the
// adjacent `./x.d.ts` for type resolution, so the result resolves under
// node16, nodenext, and bundler alike, while the runtime (bundled by tsup)
// is unaffected.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const distDir = resolve(fileURLToPath(import.meta.url), "../../dist");

// Matches the relative specifier in the three forms tsc emits into .d.ts:
//   export * from "./x"        import { T } from "./x"        import "./x"
//   import("./x").T            (inferred import-type nodes)
// The optional `(` after `import` captures the dynamic-import-type form.
const SPECIFIER = /(\b(?:from|import)\s*\(?\s*)(["'])(\.\.?\/[^"']*)\2/g;

function addExtension(specifier) {
  // Leave anything that already carries a recognized extension.
  if (/\.(js|cjs|mjs|json|d\.ts)$/.test(specifier)) return specifier;
  return `${specifier}.js`;
}

const files = (await readdir(distDir, { recursive: true })).filter((f) =>
  f.endsWith(".d.ts"),
);

let patched = 0;
for (const rel of files) {
  const file = join(distDir, rel);
  const src = await readFile(file, "utf8");
  const out = src.replace(
    SPECIFIER,
    (_m, prefix, quote, spec) => `${prefix}${quote}${addExtension(spec)}${quote}`,
  );
  if (out !== src) {
    await writeFile(file, out);
    patched++;
  }
}

console.log(`postbuild-dts: rewrote relative specifiers in ${patched} .d.ts file(s)`);
