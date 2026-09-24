import { describe, expect, it } from "vitest";
import { d, roll } from "../src/builder";
import type { Bin } from "../src/index";
import { DiceQuery, PMF } from "../src/index";

describe("PMF moments on a non-unit-mass PMF", () => {
  const slice = new PMF(
    new Map<number, Bin>([
      [1, { p: 1 / 10, count: {} }],
      [4, { p: 1 / 5, count: {} }],
      [6, { p: 1 / 10, count: {} }],
    ]),
    0
  );

  it("mean() is the partial expectation Σ v·p", () => {
    expect(slice.mean()).toBeCloseTo(3 / 2, 15);
  });

  it("variance() is the conditional variance, matching DiceQuery.variance()", () => {
    expect(slice.variance()).toBeCloseTo(51 / 16, 14);
    expect(slice.stdev()).toBeCloseTo(Math.sqrt(51 / 16), 14);
    expect(new DiceQuery([slice]).variance()).toBeCloseTo(slice.variance(), 15);
  });

  it("unit-mass variance is unchanged", () => {
    expect(roll(1, d(6)).toPMF().variance()).toBeCloseTo(35 / 12, 14);
    expect(roll(3, d(6)).toPMF().variance()).toBeCloseTo(35 / 4, 13);
  });
});
