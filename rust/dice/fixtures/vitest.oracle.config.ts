// The repo's vitest config plus the oracle recorder (see record-oracle.ts). Run from the repo root:
//   yarn vitest run -c rust/dice/fixtures/vitest.oracle.config.ts tests/turn-flags.test.ts ...
import { defineConfig, mergeConfig } from "vitest/config";
import base from "../../../vitest.config";

export default mergeConfig(base, defineConfig({
  test: { setupFiles: ["./rust/dice/fixtures/record-oracle.ts"] },
}));
