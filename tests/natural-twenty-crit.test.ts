import { describe, expect, it } from "vitest";
import { critOnHit, d20, d6, d8, hd20, roll, turn } from "../src/builder";
import type { RollBuilder } from "../src/builder";

/**
 * A natural 20 always hits and, unless the attack has `noCrit()`, always crits — whatever the AC,
 * the crit threshold, or whether the attack was told every hit is a crit (`alwaysCrits()`, or the
 * turn-level `critOnHit()` grant).
 *
 * `d20 + 5` vs AC 26 lands only on a natural 20, so P(crit) is exactly P(natural 20) under the roll
 * type: 1/20 flat, 1 - (19/20)^2 = 39/400 with advantage, (1/20)^2 = 1/400 with disadvantage,
 * 1 - (19/20)^3 = 1141/8000 best of three, and 1/20 + 1/400 = 21/400 for a Halfling d20.
 */

const damage = roll(1, d8).plus(3);
// E[2d8 + 3] on the crit.
const CRIT_MEAN = 12;

const rollTypes: [string, RollBuilder, number][] = [
  ["flat", d20, 1 / 20],
  ["advantage", d20.withAdvantage(), 39 / 400],
  ["disadvantage", d20.withDisadvantage(), 1 / 400],
  ["elven accuracy", d20.withElvenAccuracy(), 1141 / 8000],
  ["halfling", hd20, 21 / 400],
];

describe("a natural 20 lands when every hit is a crit", () => {
  for (const [name, die, pNat20] of rollTypes) {
    it(`alwaysCrits() at an AC only a natural 20 reaches (${name})`, () => {
      const res = die.plus(5).ac(26).alwaysCrits().onHit(damage).resolve(0);
      expect(res.weights.crit).toBeCloseTo(pNat20, 15);
      expect(res.weights.hit).toBe(0);
      expect(res.weights.miss).toBeCloseTo(1 - pNat20, 15);
      expect(res.pmf.mean()).toBeCloseTo(pNat20 * CRIT_MEAN, 14);
    });
  }

  it("the whole PMF is the crit payload at 1/20 and nothing otherwise", () => {
    const pmf = d20.plus(5).ac(26).alwaysCrits().onHit(damage).toPMF();
    expect(pmf.mean()).toBeCloseTo(3 / 5, 15);
    expect(pmf.pAt(0)).toBeCloseTo(19 / 20, 15);
    for (let a = 1; a <= 8; a++) {
      for (let b = 1; b <= 8; b++) expect(pmf.pAt(a + b + 3)).toBeGreaterThan(0);
    }
    // 2d8 + 3 = 19 on (8,8) only.
    expect(pmf.pAt(19)).toBeCloseTo(1 / 20 / 64, 15);
  });

  it("a crit-on-hit check rebound through withCheck still lands on a natural 20", () => {
    const res = d20
      .plus(5)
      .ac(26)
      .onHit(damage)
      .withCheck((check) => ({ ...check, critOnHit: true }))
      .resolve(0);
    expect(res.weights.crit).toBeCloseTo(1 / 20, 15);
    expect(res.pmf.mean()).toBeCloseTo(3 / 5, 15);
  });

  it("a turn-level critOnHit() grant never lowers the landing chance", () => {
    // Attack 2 lands on a natural 20 (a crit) with or without the grant: 3/5 + 3/5.
    const attack = d20.plus(5).ac(26).onHit(damage);
    const granted = turn([attack, attack]).onFirstHit(critOnHit().untilEndOfTurn());
    expect(granted.mean()).toBeCloseTo(6 / 5, 12);
  });
});

describe("a natural 20 crits an always-hitting attack", () => {
  it("whatever its crit threshold", () => {
    const res = d20.plus(9).alwaysHits().critOn(21).onHit(roll(2, d6)).resolve(0);
    expect(res.weights.crit).toBeCloseTo(1 / 20, 15);
    expect(res.weights.hit).toBeCloseTo(19 / 20, 15);
    expect(res.pmf.mean()).toBeCloseTo((19 / 20) * 7 + (1 / 20) * 14, 14);
  });

  it("but not with noCrit()", () => {
    const res = d20.plus(9).alwaysHits().onHit(roll(2, d6)).noCrit().resolve(0);
    expect(res.weights.crit).toBe(0);
    expect(res.pmf.mean()).toBeCloseTo(7, 14);
  });
});
