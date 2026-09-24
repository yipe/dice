import { describe, expect, it } from "vitest";
import { calculateBounceOdds, explodingPoolMatchProbability, jointSumAndMatch } from "./bounce";

// Ground-truth oracles from brute-force enumeration. NEVER adjust these to match an implementation.

describe("jointSumAndMatch — exact P(sum ∧ match), K=2", () => {
  const uniformD8 = new Array(8).fill(1 / 8);

  it("3d8 matches the exact per-sum oracle table", () => {
    const oracle: [number, number][] = [
      [3, 1 / 512],
      [6, 1 / 128],
      [10, 3 / 128],
      [12, 5 / 256],
      [13, 3 / 128],
      [18, 5 / 256],
      [24, 1 / 512],
    ];
    const joint = jointSumAndMatch(3, uniformD8);
    for (const [sum, expected] of oracle) {
      expect(joint.get(sum) ?? 0).toBeCloseTo(expected, 8);
    }
  });

  it("3d8 totals: P(match) = 11/32, P(all distinct) = 0.65625", () => {
    const joint = jointSumAndMatch(3, uniformD8);
    const pMatch = [...joint.values()].reduce((a, b) => a + b, 0);
    expect(pMatch).toBeCloseTo(11 / 32, 10);
    expect(1 - pMatch).toBeCloseTo(0.65625, 10);
  });

  it("marginal P(match) agrees with calculateBounceOdds for the no-modifier case", () => {
    for (const dice of [2, 3, 4, 5, 6, 7]) {
      const joint = jointSumAndMatch(dice, uniformD8);
      const pMatch = [...joint.values()].reduce((a, b) => a + b, 0);
      expect(pMatch).toBeCloseTo(calculateBounceOdds(dice, 8), 10);
    }
  });

  it("single die: no match possible", () => {
    expect(jointSumAndMatch(1, uniformD8).size).toBe(0);
    expect(jointSumAndMatch(0, uniformD8).size).toBe(0);
  });

  it("honors non-uniform weights (Elemental Adept minimum collapse)", () => {
    // minimum(3) on a d8: faces 1,2 collapse onto 3, so weights[2] (face 3) carries 3/8.
    const weights = [0, 0, 3 / 8, 1 / 8, 1 / 8, 1 / 8, 1 / 8, 1 / 8];
    const joint = jointSumAndMatch(3, weights);
    const pMatch = [...joint.values()].reduce((a, b) => a + b, 0);
    // Heavier collapsed face raises match odds above the uniform 3d8 baseline (0.34375).
    expect(pMatch).toBeGreaterThan(0.34375);
    expect(pMatch).toBeLessThanOrEqual(1);
  });
});

describe("explodingPoolMatchProbability — match composed with a pool-wide exploding budget", () => {
  const uniformD8 = new Array(8).fill(1 / 8);

  it("2d8 budget 1: exact P(match) = 23/128, not the realized-size-i.i.d. figure 0.176270", () => {
    const p = explodingPoolMatchProbability(uniformD8, 2, 1);
    expect(p).toBeCloseTo(23 / 128, 14);
    expect(p).not.toBeCloseTo(0.176270, 5);
  });

  it("reduces to the plain formula's marginal when budget is 0 (no explosion)", () => {
    const p = explodingPoolMatchProbability(uniformD8, 3, 0);
    expect(p).toBeCloseTo(calculateBounceOdds(3, 8), 10);
  });

  it("a single die matches only its own explosion: max, then max again", () => {
    expect(explodingPoolMatchProbability(uniformD8, 1, 5)).toBeCloseTo(1 / 64, 15);
    expect(explodingPoolMatchProbability(uniformD8, 1, 0)).toBe(0);
    expect(explodingPoolMatchProbability(uniformD8, 0, 5)).toBe(0);
  });

  it("more budget never decreases match probability (monotone in budget)", () => {
    let previous = 0;
    for (const budget of [0, 1, 2, 3, 5]) {
      const p = explodingPoolMatchProbability(uniformD8, 2, budget);
      expect(p).toBeGreaterThanOrEqual(previous - 1e-12);
      previous = p;
    }
  });
});
