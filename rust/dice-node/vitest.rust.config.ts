import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mergeConfig, type Plugin } from "vite";
import { configDefaults, defineConfig } from "vitest/config";
import base from "../../vitest.config";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const srcDir = join(repo, "src") + "/";
const facadeDir = join(here, "ts") + "/";

/**
 * Redirects every import that resolves to `<repo>/src/<path>.ts` to `rust/dice-node/ts/<path>.ts`
 * when that facade file exists. Test files (entry points, no importer) and the facade files
 * themselves (which import the original constants/types from `src/`) are never redirected.
 */
function rustFacade(): Plugin {
  // DICE_ENGINE=ts runs the same suite on the TypeScript original (no redirect); anything else is Rust.
  if (process.env.DICE_ENGINE === "ts") return { name: "dice-rust-facade-off" };
  return {
    name: "dice-rust-facade",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (!importer || importer.startsWith(facadeDir)) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved) return null;
      const id = resolved.id.split("?")[0];
      if (!id.startsWith(srcDir) || !id.endsWith(".ts")) return null;
      const facade = join(facadeDir, id.slice(srcDir.length));
      return existsSync(facade) ? facade : null;
    },
  };
}

// mergeConfig concatenates arrays, so drop the base config's `rust/**` exclude before merging.
export default mergeConfig(
  { ...base, test: { ...base.test, exclude: configDefaults.exclude } },
  defineConfig({
    root: repo,
    plugins: [rustFacade()],
  })
);
