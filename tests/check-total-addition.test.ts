import { describe, expect, it } from "vitest";
import { parse } from "../src/parser/parser";
import type { PMF } from "../src/pmf/pmf";

/**
 * Every term left of `AC`/`DC` builds the check total, so `+` there always adds, even where the
 * running total is 0. Outside a check `+` still adds only to a non-zero total. Expected values
 * come from enumerating the natural d20 and the bonus die by hand.
 */

type Dist = Map<number, number>;

const die = (sides: number): Dist => new Map(Array.from({ length: sides }, (_, i) => [i + 1, 1 / sides]));

function expectBins(actual: PMF, expected: Dist): void {
  expect(actual.mass()).toBeCloseTo(1, 12);
  const support = new Set([...actual.support(), ...expected.keys()]);
  for (const value of support) {
    expect(Math.abs(actual.pAt(value) - (expected.get(value) ?? 0)), `bin ${value}`).toBeLessThanOrEqual(1e-12);
  }
}

/** `(d20 + mod + 1d4 AC ac) * (2d6) crit (4d6)`, enumerated: a crit is a natural 20 that hits. */
function attack(mod: number, ac: number): Dist {
  const twoD6 = new Map<number, number>();
  const fourD6 = new Map<number, number>();
  for (let a = 1; a <= 6; a++) {
    for (let b = 1; b <= 6; b++) {
      twoD6.set(a + b, (twoD6.get(a + b) ?? 0) + 1 / 36);
      for (let c = 1; c <= 6; c++) {
        for (let e = 1; e <= 6; e++) fourD6.set(a + b + c + e, (fourD6.get(a + b + c + e) ?? 0) + 1 / 1296);
      }
    }
  }
  const out: Dist = new Map();
  for (const [natural, p] of die(20)) {
    for (const [bonus, q] of die(4)) {
      const total = natural + mod + bonus;
      if (total < ac || total === 0) {
        out.set(0, (out.get(0) ?? 0) + p * q);
        continue;
      }
      for (const [damage, r] of natural === 20 ? fourD6 : twoD6) out.set(damage, (out.get(damage) ?? 0) + p * q * r);
    }
  }
  return out;
}

describe("`+` inside a check always adds", () => {
  it("(d20 - 5 + 1d4 AC 1) * (2d6) crit (4d6) adds the d4 on a natural 5", () => {
    const pmf = parse("(d20 - 5 + 1d4 AC 1) * (2d6) crit (4d6)");
    expectBins(pmf, attack(-5, 1));
    // Misses: natural + d4 <= 5, 10 of the 80 pairs.
    expect(pmf.pAt(0)).toBeCloseTo(10 / 80, 12);
  });

  it("(d20 - 5 + 1d4 DC 1) * (2d6) saves on every total of 1 or more: P(0) = 70/80", () => {
    expect(parse("(d20 - 5 + 1d4 DC 1) * (2d6)").pAt(0)).toBeCloseTo(70 / 80, 12);
  });

  it("(d20 - 5 + 5 DC 1) * (2d6) always saves: the flat after a zero total is added", () => {
    expect(parse("(d20 - 5 + 5 DC 1) * (2d6)").pAt(0)).toBeCloseTo(1, 12);
  });

  it("a group inside the check total adds too", () => {
    const expected: Dist = new Map();
    for (let natural = 1; natural <= 20; natural++) {
      for (let a = 1; a <= 4; a++) {
        for (let b = 1; b <= 6; b++) {
          const value = natural + a - 1 + b >= 10 ? 1 : 0;
          expected.set(value, (expected.get(value) ?? 0) + 1 / 480);
        }
      }
    }
    expectBins(parse("(d20 + (1d4 - 1 + 1d6) AC 10) * (1)"), expected);
  });
});

describe("`+` outside a check adds only to a non-zero total", () => {
  it("d20 - 5 + 1d4 with no check keeps the total 0 on a natural 5", () => {
    // A natural 5 leaves 0 (1/20); natural + d4 = 5 leaves 0 on the other 4 of 80 pairs.
    expect(parse("d20 - 5 + 1d4").pAt(0)).toBeCloseTo(1 / 10, 12);
    expect(parse("d20 - 5 ~+ 1d4").pAt(0)).toBeCloseTo(4 / 80, 12);
  });

  it("a trailing `+` after the hit payload still adds only where the attack deals damage", () => {
    expect(parse("(d20 + 5 AC 15) * (1d8) + 1d6").outcomeProbability("missNone")).toBeCloseTo(9 / 20, 12);
  });
});
