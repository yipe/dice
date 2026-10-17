import { describe, expect, it } from "vitest";
import { BUILDER_FIXTURES, FIXTURES } from "./helpers/fixtures";
import { snapshotSamples } from "./helpers/snapshotHarness";

describe("draw order is a contract: builders", () => {
  for (const [name, builder] of Object.entries(BUILDER_FIXTURES)) {
    snapshotSamples(name, (rng) => builder.sample(rng));
  }
});

describe("FIXTURES", () => {
  it("has the 12 turns and each resolves to a PMF", () => {
    expect(Object.keys(FIXTURES)).toHaveLength(12);
    for (const build of Object.values(FIXTURES)) expect(build().pmf.mean()).toBeGreaterThan(0);
  });
  it("stunned fixture auto-crits the later melee attack", () => {
    const plain = FIXTURES["advantage grant until next attack"]().pmf.mean();
    expect(FIXTURES["stunned condition (auto-crit on later melee)"]().pmf.mean()).toBeGreaterThan(plain);
  });
});
