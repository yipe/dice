import { describe, expect, it } from "vitest";
import { explodingPoolMatchProbability, jointSumAndMatch } from "../src/index";

/** One die's face probabilities (1-indexed): threshold reroll once, then floor at `min`. */
function dieWeights(faces: number, min = 0, reroll = 0): number[] {
  const weights = new Array<number>(faces).fill(0);
  for (let raw = 1; raw <= faces; raw++) {
    const outcomes = raw <= reroll ? Array.from({ length: faces }, (_, i) => i + 1) : [raw];
    for (const value of outcomes) {
      const floored = Math.max(value, min);
      weights[floored - 1] += 1 / faces / outcomes.length;
    }
  }
  return weights;
}

/**
 * P(some face repeats) for `count` dice sharing a pool-wide budget of `budget`
 * explosions, by walking every roll: a die showing the max face while budget
 * remains spends one and adds a die; every die rolled counts toward the match.
 */
function bruteExplodingMatch(weights: readonly number[], count: number, budget: number): number {
  const max = weights.length;
  let total = 0;
  const walk = (pending: number, left: number, seen: number[], p: number): void => {
    if (p === 0) return;
    if (pending === 0) {
      if (new Set(seen).size < seen.length) total += p;
      return;
    }
    weights.forEach((weight, index) => {
      const face = index + 1;
      if (face === max && left > 0) walk(pending, left - 1, [...seen, face], p * weight);
      else walk(pending - 1, left, [...seen, face], p * weight);
    });
  };
  walk(count, budget, [], 1);
  return total;
}

describe("explodingPoolMatchProbability", () => {
  it("uses the pool's real face weights for the dice that did not roll max", () => {
    const minimum3 = dieWeights(8, 3);
    expect(explodingPoolMatchProbability(minimum3, 3, 0)).toBeCloseTo(17 / 32, 14);
    for (const budget of [1, 2, 3]) {
      expect(explodingPoolMatchProbability(minimum3, 3, budget)).toBeCloseTo(661 / 1024, 14);
    }
  });

  it("agrees with walking every roll across dice, minimums, rerolls, counts and budgets", () => {
    for (const faces of [4, 6, 8]) {
      for (const [min, reroll] of [
        [0, 0],
        [2, 0],
        [3, 0],
        [0, 2],
        [3, 1],
      ]) {
        const weights = dieWeights(faces, min, reroll);
        for (const count of [1, 2, 3]) {
          for (const budget of [0, 1, 2]) {
            expect(explodingPoolMatchProbability(weights, count, budget)).toBeCloseTo(
              bruteExplodingMatch(weights, count, budget),
              13
            );
          }
        }
      }
    }
  });
});

describe("jointSumAndMatch support", () => {
  /** Sums reachable by a roll of `dice` d`faces` with a repeated face. */
  function matchingSums(dice: number, faces: number): Set<number> {
    const sums = new Set<number>();
    const walk = (values: number[]): void => {
      if (values.length === dice) {
        if (new Set(values).size < dice) sums.add(values.reduce((a, b) => a + b, 0));
        return;
      }
      for (let face = 1; face <= faces; face++) walk([...values, face]);
    };
    walk([]);
    return sums;
  }

  it("has no bin at a sum no matching roll reaches", () => {
    const d6 = dieWeights(6);
    expect(jointSumAndMatch(2, d6).has(7)).toBe(false);
    const d12 = dieWeights(12);
    for (const odd of [7, 9, 11, 13, 15, 17, 19]) {
      expect(jointSumAndMatch(2, d12).has(odd)).toBe(false);
    }
  });

  it("puts bins at exactly the sums a matching roll reaches", () => {
    for (const faces of [4, 6, 8, 10, 12]) {
      for (const dice of [2, 3, 4]) {
        const bins = [...jointSumAndMatch(dice, dieWeights(faces)).keys()].sort((a, b) => a - b);
        const expected = [...matchingSums(dice, faces)].sort((a, b) => a - b);
        expect(bins).toEqual(expected);
      }
    }
  });
});
