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

// Matches the specifier in `from "..."` and bare `import "..."` clauses.
const SPECIFIER = /(\bfrom\s*|\bimport\s*)(["'])(\.\.?\/[^"']*)\2/g;

function addExtension(specifier) {
  // Leave anything that already carries a recognized extension.
  if (/\.(js|cjs|mjs|json|d\.ts)$/.test(specifier)) return specifier;
  return `${specifier}.js`;
}

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith(".d.ts")) yield full;
  }
}

let patched = 0;
for await (const file of walk(distDir)) {
  const src = await readFile(file, "utf8");
  const out = src.replace(
    SPECIFIER,
    (_m, kw, quote, spec) => `${kw}${quote}${addExtension(spec)}${quote}`,
  );
  if (out !== src) {
    await writeFile(file, out);
    patched++;
  }
}

console.log(`postbuild-dts: rewrote relative specifiers in ${patched} .d.ts file(s)`);
