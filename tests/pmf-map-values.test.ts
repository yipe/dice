import { describe, expect, it } from "vitest";
import type { Bin } from "../src/index";
import { PMF } from "../src/index";

function pmfOf(bins: Array<[number, Bin]>): PMF {
  return new PMF(new Map(bins), 0);
}

const labelled = () =>
  pmfOf([
    [0, { p: 1 / 2, count: { missNone: 1 / 2 } }],
    [5, { p: 1 / 4, count: { hit: 1 / 4 } }],
    [8, { p: 1 / 4, count: { crit: 1 / 4 } }],
  ]);

describe("PMF.mapValues", () => {
  it("carries outcome counts to the mapped values by default", () => {
    const out = labelled().mapValues((v) => v + 1);
    expect(out.support()).toEqual([1, 6, 9]);
    expect(out.outcomeProbability("hit")).toBeCloseTo(1 / 4, 15);
    expect(out.outcomeProbability("crit")).toBeCloseTo(1 / 4, 15);
    expect(out.outcomeAt(1, "missNone")).toBeCloseTo(1 / 2, 15);
    expect(out.mean()).toBeCloseTo(17 / 4, 15);
  });

  it("merges counts of values that map to the same result", () => {
    const out = labelled().mapValues((v) => v / 2, undefined, { rounding: "floor" });
    // 5 → 2, 8 → 4, 0 → 0
    expect(out.outcomeAt(2, "hit")).toBeCloseTo(1 / 4, 15);
    const merged = labelled().mapValues((v) => (v > 0 ? 1 : 0));
    expect(merged.pAt(1)).toBeCloseTo(1 / 2, 15);
    expect(merged.outcomeAt(1, "hit")).toBeCloseTo(1 / 4, 15);
    expect(merged.outcomeAt(1, "crit")).toBeCloseTo(1 / 4, 15);
  });

  it("drops counts when preserveCounts is false", () => {
    const out = labelled().mapValues((v) => v + 1, undefined, { preserveCounts: false });
    expect(out.outcomes()).toEqual([]);
    expect(out.pAt(6)).toBeCloseTo(1 / 4, 15);
  });

  it("keeps tiny bins and the original mass", () => {
    const x = pmfOf([
      [0, { p: 1 - 1e-13, count: {} }],
      [1000, { p: 1e-13, count: {} }],
    ]);
    expect(x.mapValues((v) => v).mean()).toBeCloseTo(1e-10, 20);
    const half = pmfOf([
      [2, { p: 1 / 4, count: {} }],
      [4, { p: 1 / 4, count: {} }],
    ]);
    expect(half.mapValues((v) => v * 3).mass()).toBeCloseTo(1 / 2, 15);
  });

  it("throws on a non-finite or non-integer mapped value", () => {
    expect(() => labelled().mapValues((v) => v / 0)).toThrow(/mapValues/);
    expect(() => labelled().mapValues((v) => v / 3)).toThrow(/mapValues/);
  });
});
