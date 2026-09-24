import { describe, expect, it } from "vitest";
import { DiceParseError } from "../src/common/errors";
import { parse } from "../src/parser/parser";
import type { PMF } from "../src/pmf/pmf";

/**
 * A leading `-` negates the argument after it, the whole repeat chain included (`-2d6` is
 * `-(2d6)`), so a subtraction can be written as `+ -X` and a string can start with a minus.
 */

type Dist = Map<number, number>;

const die = (sides: number): Dist => new Map(Array.from({ length: sides }, (_, i) => [i + 1, 1 / sides]));

function combine(a: Dist, b: Dist, op: (x: number, y: number) => number): Dist {
  const out: Dist = new Map();
  for (const [x, p] of a) {
    for (const [y, q] of b) out.set(op(x, y), (out.get(op(x, y)) ?? 0) + p * q);
  }
  return out;
}

const flat = (value: number): Dist => new Map([[value, 1]]);

function expectBins(actual: PMF, expected: Dist): void {
  expect(actual.mass()).toBeCloseTo(1, 12);
  const support = new Set([...actual.support(), ...expected.keys()]);
  for (const value of support) {
    expect(Math.abs(actual.pAt(value) - (expected.get(value) ?? 0)), `bin ${value}`).toBeLessThanOrEqual(1e-12);
  }
}

const minus = (x: number, y: number): number => x - y;

describe("unary minus", () => {
  it("1d6 + -3 and 1d6 - -3 are 1d6 - 3 and 1d6 + 3", () => {
    expectBins(parse("1d6 + -3"), combine(die(6), flat(3), minus));
    expect(parse("1d6 + -3").mean()).toBeCloseTo(1 / 2, 12);
    expectBins(parse("1d6 - -3"), combine(die(6), flat(-3), minus));
    expect(parse("1d6 - -3").mean()).toBeCloseTo(13 / 2, 12);
  });

  it("-3 + 1d6 starts at -3", () => {
    expectBins(parse("-3 + 1d6"), combine(die(6), flat(3), minus));
    expectBins(parse("-3"), flat(-3));
  });

  it("-1d8 + 1d6 is 1d6 - 1d8: mean -1", () => {
    const pmf = parse("-1d8 + 1d6");
    expectBins(pmf, combine(die(6), die(8), minus));
    expect(pmf.mean()).toBeCloseTo(-1, 12);
  });

  it("negates the whole repeat chain: -2d6 is -(2d6) and -2(d4 reroll 1) + 2d6 is 2d6 - 2(d4 reroll 1)", () => {
    expectBins(parse("-2d6"), combine(flat(0), combine(die(6), die(6), (x, y) => x + y), minus));
    const reference = parse("2d6 - 2(d4 reroll 1)");
    expectBins(parse("-2(d4 reroll 1) + 2d6"), new Map(reference.support().map((value) => [value, reference.pAt(value)])));
  });

  it("negates a group and nests: -(1d4 + 1) and --3", () => {
    expectBins(parse("-(1d4 + 1)"), combine(flat(0), combine(die(4), flat(1), (x, y) => x + y), minus));
    expectBins(parse("--3"), flat(3));
    expectBins(parse("2 * (-3)"), flat(-3));
  });

  it("a hit payload with a negative term doubles its dice on a crit", () => {
    // (d20 AC 11) * (-1d4 + 1d8): the implicit crit rolls -2d4 + 2d8.
    const pmf = parse("(d20 AC 11) * (-1d4 + 1d8)");
    const hit = combine(die(8), die(4), minus);
    const crit = combine(combine(die(8), die(8), (x, y) => x + y), combine(die(4), die(4), (x, y) => x + y), minus);
    const mean = (dist: Dist): number => [...dist].reduce((total, [value, p]) => total + value * p, 0);
    expect(pmf.mean()).toBeCloseTo((9 / 20) * mean(hit) + (1 / 20) * mean(crit), 12);
  });
});

describe("an unparsable string throws a DiceParseError with a message", () => {
  it.each(["d-6", "", "+3", "1d6 + ", "(", "1d6 + (", "-", "1d6 * -", "2kh1", "1d6 reroll", "1d6 AC", "d20 AC 5 crit"])(
    "%j",
    (expression) => {
      expect(() => parse(expression)).toThrow(DiceParseError);
      expect(() => parse(expression)).not.toThrow(/TypeError|RangeError|undefined is not/);
    }
  );
});
