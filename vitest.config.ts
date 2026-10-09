import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // L0 compat recorder: inert unless COMPAT=capture|check (see tests/compat/recorder.ts).
    setupFiles: ["./tests/compat/recorder.ts"],
    globalSetup: ["./tests/compat/global.ts"],
  },
});
