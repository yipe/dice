import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // L0 compat recorder: inert unless COMPAT=capture|check (see tests/compat/recorder.ts).
    setupFiles: ["./tests/compat/recorder.ts"],
    globalSetup: ["./tests/compat/global.ts"],
    // rust/dice-node tests need the native build; they run under rust/dice-node/vitest.rust.config.ts.
    exclude: [...configDefaults.exclude, "rust/**"],
  },
});
