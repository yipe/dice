import { expect, it } from "vitest";
import type { Rng } from "../../src/common/rng";
import { lcgRng } from "./lcg";

/** Three fixed seeds, one snapshot: the draw order of `sample` is a contract (A5b's SAMPLER_VERSION rule). */
export function snapshotSamples(name: string, sample: (rng: Rng) => unknown): void {
  it(`${name}: fixed seeds, fixed draws`, () => {
    expect([1, 2, 3].map((seed) => sample(lcgRng(seed)))).toMatchSnapshot();
  });
}
