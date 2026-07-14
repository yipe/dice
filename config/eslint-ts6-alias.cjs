// config/eslint-ts6-alias.cjs
//
// Preloaded (node -r) before ESLint runs. typescript-eslint (through 8.x)
// crashes on load against the Go-native TypeScript 7 API — it reads compiler
// enums such as `ts.Extension.Cjs` that 7.0 removed. Until typescript-eslint
// ships TS 7 support, we route every `require("typescript")` inside the ESLint
// process to the @typescript/typescript6 bridge (the TS 6.0 API re-published
// under a distinct package name) while the project's own `tsc` stays on the
// native 7.0 compiler.
//
// typescript-eslint's packages are CommonJS, so patching Module._resolveFilename
// intercepts their `require("typescript")` calls. Everything else resolves
// normally.

const Module = require("node:module");

const originalResolve = Module._resolveFilename;

Module._resolveFilename = function (request, ...rest) {
  // `typescript` -> bridge package root; `typescript/<subpath>` -> same subpath.
  if (request === "typescript" || request.startsWith("typescript/")) {
    return require.resolve("@typescript/typescript6" + request.slice("typescript".length));
  }
  return originalResolve.call(this, request, ...rest);
};
