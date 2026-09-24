import { describe, expect, it } from "vitest";
import { parse } from "../src/parser/parser";
import type { PMF } from "../src/pmf/pmf";

/**
 * `NkhK(X)` / `NklK(X)` is the sum of the K highest (lowest) of N independent copies of X, for
 * any X. Small cases are checked against brute force over every ordered outcome; larger pools,
 * which brute force cannot reach, against exact values.
 */

type Dist = Map<number, number>;

const die = (sides: number): Dist => new Map(Array.from({ length: sides }, (_, i) => [i + 1, 1 / sides]));

function sum(a: Dist, b: Dist): Dist {
  const out: Dist = new Map();
  for (const [x, p] of a) for (const [y, q] of b) out.set(x + y, (out.get(x + y) ?? 0) + p * q);
  return out;
}

/** Every ordered outcome of `count` copies of `dist`, keeping the `kept` highest or lowest. */
function keepBrute(dist: Dist, count: number, kept: number, lowest: boolean): Dist {
  const out: Dist = new Map();
  const faces = [...dist];
  const walk = (index: number, values: number[], weight: number): void => {
    if (index === count) {
      const sorted = [...values].sort((a, b) => (lowest ? a - b : b - a));
      const total = sorted.slice(0, kept).reduce((acc, value) => acc + value, 0);
      out.set(total, (out.get(total) ?? 0) + weight);
      return;
    }
    for (const [value, p] of faces) walk(index + 1, [...values, value], weight * p);
  };
  walk(0, [], 1);
  return out;
}

function expectBins(actual: PMF, expected: Dist, tolerance = 1e-12): void {
  expect(actual.mass()).toBeCloseTo(1, 12);
  const support = new Set([...actual.support(), ...expected.keys()]);
  for (const value of support) {
    expect(Math.abs(actual.pAt(value) - (expected.get(value) ?? 0)), `bin ${value}`).toBeLessThanOrEqual(tolerance);
  }
}

describe("keep K of N matches brute force on every small shape", () => {
  const twoD6 = sum(die(6), die(6));
  it.each([
    ["4kh3d6", die(6), 4, 3, false],
    ["4kl3(1d6)", die(6), 4, 3, true],
    ["3kh2(1d8)", die(8), 3, 2, false],
    ["3kl1(1d20)", die(20), 3, 1, true],
    ["3kh2(2d6)", twoD6, 3, 2, false],
    ["2kl1(2d6)", twoD6, 2, 1, true],
    ["5kh2(1d4)", die(4), 5, 2, false],
    ["4kl2(1d4 - 2 ~+ 1d4)", sum(new Map([...die(4)].map(([v, p]) => [v - 2, p])), die(4)), 4, 2, true],
  ] as const)("%s", (expression, dist, count, kept, lowest) => {
    expectBins(parse(expression), keepBrute(dist, count, kept, lowest));
  });

  it("a skewed, signed per-copy distribution", () => {
    // min(d20, 2) - 3 + max(d20, 3): -2 or -1, plus 3 at 3/20 or 4..20 at 1/20 each.
    const table = "((1d20 < 2) - 3 ~+ (1d20 > 3))";
    const low: Dist = new Map([
      [-2, 1 / 20],
      [-1, 19 / 20],
    ]);
    const high: Dist = new Map([[3, 3 / 20], ...[...die(20)].filter(([v]) => v > 3)]);
    const dist = sum(low, high);
    expectBins(parse(`4kh2(${table})`), keepBrute(dist, 4, 2, false));
    expectBins(parse(`3kl2(${table})`), keepBrute(dist, 3, 2, true));
  });

  it("keeps more than it rolls: the sum of every copy", () => {
    expectBins(parse("2kh3(1d6)"), sum(die(6), die(6)));
  });

  it("keeps none: 0", () => {
    expectBins(parse("3kh0(1d6)"), new Map([[0, 1]]));
  });
});

/**
 * The same keep over unordered outcomes: every way to split `count` copies among the faces, each
 * weighted by its multinomial probability. Reaches pools brute force over ordered outcomes cannot.
 */
function keepMultiset(dist: Dist, count: number, kept: number, lowest: boolean): Dist {
  const faces = [...dist].sort(([a], [b]) => (lowest ? a - b : b - a));
  const factorial = (k: number): number => (k <= 1 ? 1 : k * factorial(k - 1));
  const out: Dist = new Map();
  const walk = (index: number, left: number, taken: number, total: number, weight: number): void => {
    if (index === faces.length - 1) {
      const [value, p] = faces[index];
      const final = total + Math.min(left, kept - taken) * value;
      out.set(final, (out.get(final) ?? 0) + (weight * p ** left) / factorial(left));
      return;
    }
    const [value, p] = faces[index];
    for (let n = 0; n <= left; n++) {
      const take = Math.min(n, kept - taken);
      walk(index + 1, left - n, taken + take, total + take * value, (weight * p ** n) / factorial(n));
    }
  };
  walk(0, count, 0, 0, factorial(count));
  return out;
}

describe("keeps too large to enumerate resolve exactly", () => {
  it("4kh1(2d20) is 188600027019/6400000000", () => {
    const twoD20 = sum(die(20), die(20));
    expectBins(parse("4kh1(2d20)"), keepMultiset(twoD20, 4, 1, false));
    expect(parse("4kh1(2d20)").mean()).toBeCloseTo(188600027019 / 6400000000, 10);
  });

  it("6kh2(1d20) is 51845681/1600000", () => {
    expectBins(parse("6kh2(1d20)"), keepMultiset(die(20), 6, 2, false));
    expect(parse("6kh2(1d20)").mean()).toBeCloseTo(51845681 / 1600000, 10);
  });

  it("9kh3(1d8) and 9kl3(1d8)", () => {
    expectBins(parse("9kh3(1d8)"), keepMultiset(die(8), 9, 3, false));
    expectBins(parse("9kl3(1d8)"), keepMultiset(die(8), 9, 3, true));
  });

  it("the multiset enumeration agrees with brute force", () => {
    const multiset = keepMultiset(sum(die(4), die(4)), 4, 2, true);
    const brute = keepBrute(sum(die(4), die(4)), 4, 2, true);
    for (const value of new Set([...multiset.keys(), ...brute.keys()])) {
      expect(multiset.get(value) ?? 0, `bin ${value}`).toBeCloseTo(brute.get(value) ?? 0, 14);
    }
  });

  it("10kh1d10 is the max of ten d10", () => {
    const pmf = parse("10kh1d10");
    for (let v = 1; v <= 10; v++) expect(pmf.pAt(v)).toBeCloseTo((v / 10) ** 10 - ((v - 1) / 10) ** 10, 14);
  });
});
