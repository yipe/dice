import { describe, expect, it } from "vitest";
import { parse } from "../src/parser/parser";
import type { PMF } from "../src/pmf/pmf";

/**
 * `X reroll R` rolls X once and, where the result is in the face set R, rolls X again and keeps
 * the second roll. Expected bins come from enumerating both rolls by hand, so a non-uniform X
 * (a sum, a max, a min, a floor) is weighted by the mass of each result, not by its face count.
 */

type Dist = Map<number, number>;

const die = (sides: number): Dist => new Map(Array.from({ length: sides }, (_, i) => [i + 1, 1 / sides]));

function pairwise(a: Dist, b: Dist, op: (x: number, y: number) => number): Dist {
  const out: Dist = new Map();
  for (const [x, p] of a) {
    for (const [y, q] of b) {
      const value = op(x, y);
      out.set(value, (out.get(value) ?? 0) + p * q);
    }
  }
  return out;
}

/** Roll `dist`; on a result in `faces`, roll it again and keep the second roll. */
function rerollOnce(dist: Dist, faces: readonly number[]): Dist {
  const out: Dist = new Map();
  for (const [first, p] of dist) {
    if (!faces.includes(first)) {
      out.set(first, (out.get(first) ?? 0) + p);
      continue;
    }
    for (const [second, q] of dist) out.set(second, (out.get(second) ?? 0) + p * q);
  }
  return out;
}

const mean = (dist: Dist): number => [...dist].reduce((total, [value, p]) => total + value * p, 0);

function expectBins(actual: PMF, expected: Dist): void {
  expect(actual.mass()).toBeCloseTo(1, 12);
  const support = new Set([...actual.support(), ...expected.keys()]);
  for (const value of support) {
    expect(Math.abs(actual.pAt(value) - (expected.get(value) ?? 0)), `bin ${value}`).toBeLessThanOrEqual(1e-12);
  }
}

const d6 = die(6);
const d20 = die(20);
const twoD6 = pairwise(d6, d6, (x, y) => x + y);

describe("a reroll of a non-uniform roll weights each result by its probability", () => {
  it("2d6 reroll 2 is 257/36", () => {
    const expected = rerollOnce(twoD6, [2]);
    expect(mean(expected)).toBeCloseTo(257 / 36, 12);
    expectBins(parse("2d6 reroll 2"), expected);
  });

  it("d6 reroll 1 reroll 2 rerolls the rerolled die: 1853/432", () => {
    const expected = rerollOnce(rerollOnce(d6, [1]), [2]);
    expect(mean(expected)).toBeCloseTo(1853 / 432, 12);
    expectBins(parse("d6 reroll 1 reroll 2"), expected);
  });

  it("(d20 > d20) reroll 1 is 221713/16000, with P(1) = 1/400²", () => {
    const expected = rerollOnce(pairwise(d20, d20, Math.max), [1]);
    expect(mean(expected)).toBeCloseTo(221713 / 16000, 12);
    const pmf = parse("(d20 > d20) reroll 1");
    expectBins(pmf, expected);
    expect(pmf.pAt(1)).toBeCloseTo(1 / 160000, 15);
  });

  it("(d20 < d20) reroll 1 rerolls the disadvantage roll's 39/400 of ones", () => {
    const expected = rerollOnce(pairwise(d20, d20, Math.min), [1]);
    expectBins(parse("(d20 < d20) reroll 1"), expected);
    expect(parse("(d20 < d20) reroll 1").pAt(1)).toBeCloseTo((39 / 400) ** 2, 15);
  });

  it("2kh1(1d6) reroll 1 is 5921/1296 and (3>d6) reroll 3 is 9/2", () => {
    const best = rerollOnce(pairwise(d6, d6, Math.max), [1]);
    expect(mean(best)).toBeCloseTo(5921 / 1296, 12);
    expectBins(parse("2kh1(1d6) reroll 1"), best);

    const floored = rerollOnce(pairwise(new Map([[3, 1]]), d6, Math.max), [3]);
    expect(mean(floored)).toBeCloseTo(9 / 2, 12);
    expectBins(parse("(3>d6) reroll 3"), floored);
  });

  it("the crit rate of a rerolled advantage check follows the reroll", () => {
    // Natural 20 of (d20 > d20) reroll 1: P(max = 20) · (1 + P(max = 1)).
    const pmf = parse("((d20 > d20) reroll 1 AC 30) * (2d6) crit (4d6)");
    expect(pmf.outcomeProbability("crit")).toBe(0);
    const hit = parse("((d20 > d20) reroll 1 AC 2) * (2d6) crit (4d6)");
    expect(hit.outcomeProbability("crit")).toBeCloseTo((39 / 400) * (1 + 1 / 400), 15);
  });
});

describe("a reroll of a uniform die", () => {
  it("d20 reroll 1 and hd20 are halfling luck: 439/40 with P(1) = 1/400", () => {
    const expected = rerollOnce(d20, [1]);
    for (const expression of ["d20 reroll 1", "hd20"]) {
      const pmf = parse(expression);
      expectBins(pmf, expected);
      expect(pmf.mean()).toBeCloseTo(439 / 40, 12);
      expect(pmf.pAt(1)).toBe(1 / 400);
    }
  });

  it("reroll N rerolls face N only, reroll dN every face up to N", () => {
    expectBins(parse("d6 reroll 2"), rerollOnce(d6, [2]));
    expect(parse("d6 reroll 2").mean()).toBeCloseTo(15 / 4, 12);
    expectBins(parse("d6 reroll d2"), rerollOnce(d6, [1, 2]));
    expect(parse("d6 reroll d2").mean()).toBeCloseTo(25 / 6, 12);
  });

  it("2d6 reroll 1 rerolls the total, which is never 1; 2(d6 reroll 1) rerolls each die", () => {
    expectBins(parse("2d6 reroll 1"), twoD6);
    const perDie = rerollOnce(d6, [1]);
    expectBins(parse("2(d6 reroll 1)"), pairwise(perDie, perDie, (x, y) => x + y));
    expect(parse("1(d8 reroll 1) + 2(d6 reroll 1)").mean()).toBeCloseTo(613 / 48, 12);
  });

  it("reroll d0 rerolls no face", () => {
    expectBins(parse("d6 reroll d0"), d6);
  });
});
