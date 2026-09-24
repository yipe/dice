import { describe, expect, it } from "vitest";
import { DiceParseError } from "../src/common/errors";
import { parse } from "../src/parser/parser";
import type { PMF } from "../src/pmf/pmf";

/**
 * A repeat count of zero rolls nothing: the result is 0 with probability 1, never an empty
 * distribution. Expected bins come from enumerating the dice by hand.
 */

type Dist = Map<number, number>;

const die = (sides: number): Dist => new Map(Array.from({ length: sides }, (_, i) => [i + 1, 1 / sides]));

function sum(a: Dist, b: Dist): Dist {
  const out: Dist = new Map();
  for (const [x, p] of a) for (const [y, q] of b) out.set(x + y, (out.get(x + y) ?? 0) + p * q);
  return out;
}

/** `count` independent copies of `dist`, summed; zero copies are the point mass at 0. */
function copies(count: number, dist: Dist): Dist {
  let out: Dist = new Map([[0, 1]]);
  for (let i = 0; i < count; i++) out = sum(out, dist);
  return out;
}

function expectBins(actual: PMF, expected: Dist): void {
  expect(actual.mass()).toBeCloseTo(1, 12);
  const support = new Set([...actual.support(), ...expected.keys()]);
  for (const value of support) {
    expect(Math.abs(actual.pAt(value) - (expected.get(value) ?? 0)), `bin ${value}`).toBeLessThanOrEqual(1e-12);
  }
}

describe("a zero repeat count is the point mass at 0", () => {
  it.each(["0d6", "0(1d6)", "2(0d6)", "0(2kh1(2d6))", "3kh1(0d6)"])("%s is 0 with probability 1", (expression) => {
    expectBins(parse(expression), new Map([[0, 1]]));
  });

  it("1d8 + 0d6 is the d8 alone: mean 9/2", () => {
    const pmf = parse("1d8 + 0d6");
    expectBins(pmf, die(8));
    expect(pmf.mean()).toBeCloseTo(9 / 2, 12);
  });

  it("0d6 + 3 is 0: `+` adds only to a non-zero total", () => {
    expectBins(parse("0d6 + 3"), new Map([[0, 1]]));
    expectBins(parse("0d6 ~+ 3"), new Map([[3, 1]]));
  });

  it("nd6 at the default n = 0 rolls no dice", () => {
    expectBins(parse("nd6"), new Map([[0, 1]]));
    expectBins(parse("nd6", 2), copies(2, die(6)));
  });

  it("(1d4 - 1)d6 rolls 0 to 3 d6: mean 21/4 with P(0) = 1/4", () => {
    const expected: Dist = new Map();
    for (let count = 0; count <= 3; count++) {
      for (const [value, p] of copies(count, die(6))) expected.set(value, (expected.get(value) ?? 0) + p / 4);
    }
    const pmf = parse("(1d4 - 1)d6");
    expectBins(pmf, expected);
    expect(pmf.mean()).toBeCloseTo(21 / 4, 12);
    expect(pmf.pAt(0)).toBeCloseTo(1 / 4, 12);
  });

  it("(1d2 - 1)(1d6) is 0 or a d6, half the time each: mean 7/4", () => {
    expect(parse("(1d2 - 1)(1d6)").mean()).toBeCloseTo(7 / 4, 12);
    expect(parse("(1d2 - 1)(1d6)").pAt(0)).toBeCloseTo(1 / 2, 12);
  });

  it("a repeat count that can be negative throws a DiceParseError", () => {
    expect(() => parse("(1d4 - 2)d6")).toThrow(DiceParseError);
    expect(() => parse("(1d4 - 2)d6")).toThrow(/repeat count/);
  });
});

describe("a d0 has no faces", () => {
  it("rolled on its own it throws a DiceParseError instead of returning an empty distribution", () => {
    for (const expression of ["d0", "1d0", "d0 + 3", "2kh1(d0)"]) {
      expect(() => parse(expression), expression).toThrow(DiceParseError);
    }
  });
});
