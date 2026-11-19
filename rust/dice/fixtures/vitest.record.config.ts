// The repo's vitest config plus the PMF recorder. Run from the repo root:
//   yarn vitest run -c rust/dice/fixtures/vitest.record.config.ts
import { defineConfig, mergeConfig } from "vitest/config";
import base from "../../../vitest.config";

export default mergeConfig(base, defineConfig({
  test: { setupFiles: ["./rust/dice/fixtures/record-pmf.ts"] },
}));
