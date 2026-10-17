import { describe, expect, it } from "vitest";
import { SAMPLER_VERSION } from "../src/turn";
import { BUILDER_FIXTURES, FIXTURES } from "./helpers/fixtures";
import { lcgRng } from "./helpers/lcg";
import { snapshotSamples } from "./helpers/snapshotHarness";

describe("draw order is a contract: builders", () => {
  for (const [name, builder] of Object.entries(BUILDER_FIXTURES)) {
    snapshotSamples(name, (rng) => builder.sample(rng));
  }
});

describe("FIXTURES", () => {
  it("has the 17 turns and each resolves to a PMF", () => {
    expect(Object.keys(FIXTURES)).toHaveLength(17);
    for (const build of Object.values(FIXTURES)) expect(build().pmf.mean()).toBeGreaterThan(0);
  });
  it("paralyzed fixture auto-crits the later melee attack", () => {
    const plain = FIXTURES["advantage grant until next attack"]().pmf.mean();
    expect(FIXTURES["paralyzed condition (auto-crit on later melee)"]().pmf.mean()).toBeGreaterThan(plain);
  });
});

describe("draw order is a contract: Turn.sample", () => {
  for (const [name, build] of Object.entries(FIXTURES)) snapshotSamples(name, (rng) => build().sample(rng));
  it("stamps the sampler version", () => {
    expect(FIXTURES["two attacks + sneak attack"]().sample(lcgRng(1)).samplerVersion).toBe(SAMPLER_VERSION);
  });
});
