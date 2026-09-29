// The root and `/builder` entries are two bundles of one source tree. Each used to bundle its own
// `PMF` class, so a PMF made through one entry failed `instanceof PMF` in the other and `Turn`
// refused it (`not-an-attack`). This builds the package with the real tsup config and runs a
// child `node` process (`tests/fixtures/entry-probe.mjs`) against the ESM and the CJS output,
// because bundle identity cannot be observed from the source tree.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "tsup";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import tsupConfig from "../config/tsup.config";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const probe = path.join(root, "tests/fixtures/entry-probe.mjs");

interface Observation {
  mean?: number;
  error?: string;
}
interface Probe {
  identity: Record<string, boolean>;
  accepted: Record<string, Observation>;
}

let dist = "";

beforeAll(async () => {
  dist = mkdtempSync(path.join(tmpdir(), "dice-entries-"));
  // Node reads a `.js` file as ESM only under a `"type": "module"` package, as the published one is.
  writeFileSync(path.join(dist, "package.json"), '{ "type": "module" }');
  await build({
    ...(tsupConfig as object),
    config: false,
    entry: [path.join(root, "src/index.ts"), path.join(root, "src/builder/index.ts")],
    outDir: dist,
    clean: false,
    sourcemap: false,
    silent: true,
  });
}, 120_000);

afterAll(() => {
  rmSync(dist, { recursive: true, force: true });
});

const runProbe = (format: "esm" | "cjs"): Probe =>
  JSON.parse(execFileSync(process.execPath, [probe, dist, format], { encoding: "utf8" })) as Probe;

// Hand-computed for `d20 + 8 vs AC 16` with `1d4 + 4`: 12/20 plain hits at 6.5, 1/20 crit at 9.
const HIT = 0.65;
const DAGGER = 4.35;
const EXPECTED_MEANS: Record<string, number> = {
  bareAttack: DAGGER,
  // A bare PMF in the attack list is added as-is.
  rootPmfAsAttack: DAGGER + 3,
  // The attack parsed by the root entry equals the builder's, so a first-hit rider fires on 13/20.
  rootParsedAttackAsSource: DAGGER + HIT * 3,
  // 0.6 * 5 + 0.05 * 10, then the rider on the 0.65 that landed.
  rootMixtureAttackAsSource: 0.6 * 5 + 0.05 * 10 + HIT * 3,
  builderMixtureAttackAsSource: 0.6 * 5 + 0.05 * 10 + HIT * 3,
  rootPmfAsRider: DAGGER + HIT * 3,
  rootPmfListAsRider: DAGGER + HIT * (1 + 2),
  // Fires on a crit (1/20) only, and a PMF's crit payload is the `critDamage` given.
  rootPmfAsCritDamage: DAGGER + 0.05 * 5,
  toPMFReturningRootPmf: DAGGER + HIT * 3,
};

describe.each(["esm", "cjs"] as const)("built %s package", (format) => {
  it("both entries share one PMF class, one Mixture class and one error class", () => {
    const { identity } = runProbe(format);
    expect(identity).toEqual({
      builderPmfIsRootPmf: true,
      rootPmfIsBuilderPmf: true,
      turnPmfIsRootPmf: true,
      sameConstructor: true,
      builderMixtureIsRootMixture: true,
      builderMixturePmfIsRootPmf: true,
      builderParseErrorIsRootError: true,
    });
  });

  it("Turn accepts a PMF made by the root entry wherever it takes a PMF", () => {
    const { accepted } = runProbe(format);
    expect(Object.keys(accepted).sort()).toEqual(Object.keys(EXPECTED_MEANS).sort());
    for (const [name, expected] of Object.entries(EXPECTED_MEANS)) {
      expect(accepted[name], name).toEqual({ mean: expect.closeTo(expected, 12) });
    }
  });
});
