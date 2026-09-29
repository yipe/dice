// tsup.config.ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/builder/index.ts"],
  format: ["esm", "cjs"],
  // Declarations are emitted by the native TypeScript 7 compiler (see the
  // "types" script). tsup's rollup-plugin-dts path relies on the pre-7 tsc
  // compiler API, which the Go-native tsc 7.x no longer exposes.
  dts: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
  minify: false,
  target: "es2020",
  outDir: "dist",
  // The root and `/builder` entries share modules (`PMF`, the error classes, the caches).
  // Without splitting each entry bundles its own copy, so a `PMF` built through one entry
  // fails `instanceof PMF` in the other and `Turn` refuses it (`not-an-attack`). Splitting
  // moves the shared modules into one chunk both entries import. `splitting` also covers
  // the CJS output (tsup's `cjsSplitting` follows it).
  splitting: true,
});
