import { describe, expect, it } from "vitest";
import "../src/builder/ac";
import { d, d20, d4, d6, d8, roll } from "../src/builder/factory";
import type { AttackBuilder } from "../src/builder/attack";
import { parse } from "../src/parser/parser";
import { AmbiguousCritDoublingError } from "../src/parser/scaleDice";
import type { PMF } from "../src/pmf/pmf";
import { turn } from "../src/turn";

/**
 * Edge shapes of parse(): the builder is the oracle, bin for bin (≤1e-12) and label by label.
 * Exact fractions come from an independent enumeration over the natural d20 and the bonus dice.
 */

const LABELS = ["hit", "crit", "missNone", "missDamage"] as const;

function expectSamePMF(actual: PMF, expected: PMF): void {
  const support = new Set([...actual.support(), ...expected.support()]);
  for (const value of support) {
    expect(Math.abs(actual.pAt(value) - expected.pAt(value)), `bin ${value}`).toBeLessThanOrEqual(1e-12);
  }
}

/** Same bins, same hit/crit/miss weights, and the same damage under each label. */
function expectSameAttack(expression: string, built: AttackBuilder): void {
  const parsed = parse(expression);
  const reference = built.toPMF();
  expectSamePMF(parsed, reference);
  for (const label of LABELS) {
    expect(parsed.outcomeProbability(label), `${expression} ${label}`).toBeCloseTo(reference.outcomeProbability(label), 12);
    expectSamePMF(parsed.filterOutcome(label), reference.filterOutcome(label));
  }
}

/** Two strings that parse to the same bins and the same damage under each hit/crit/miss label. */
function expectSameParse(a: string, b: string): void {
  const left = parse(a);
  const right = parse(b);
  expectSamePMF(left, right);
  for (const label of LABELS) expectSamePMF(left.filterOutcome(label), right.filterOutcome(label));
}

describe("a trailing hit-only term is part of the hit payload: its dice double on a crit, its flats do not", () => {
  it("`+` after the payload adds to non-zero totals only, exactly like parenthesising it into the payload", () => {
    // The grammar associates left to right and `+` is add-if-non-zero, so a miss (0) stays 0.
    const trailing = parse("(d20 + 5 AC 15) * (1d8) + 1d6");
    expectSamePMF(trailing, parse("(d20 + 5 AC 15) * ((1d8) + 1d6)"));
    expect(trailing.outcomeProbability("missNone")).toBeCloseTo(9 / 20, 12);
  });

  it("(d20 + 5 AC 15) * (1d8) + 1d6 crits as 2d8 + 2d6: mean 24/5, like onHit(roll(1,d8).plus(roll(1,d6)))", () => {
    const built = d20.plus(5).ac(15).onHit(roll(1, d8).plus(roll(1, d6)));
    expectSameAttack("(d20 + 5 AC 15) * (1d8) + 1d6", built);
    expectSameAttack("d20 + 5 AC 15 * 1d8 + 1d6", built);
    expect(parse("(d20 + 5 AC 15) * (1d8) + 1d6").mean()).toBeCloseTo(24 / 5, 12); // was 4.625
    expectSamePMF(parse("(d20 + 5 AC 15) * (1d8) + 1d6").filterOutcome("crit"), roll(2, d8).plus(roll(2, d6)).toPMF().scaleMass(0.05));
  });

  it("a trailing flat keeps every label and is added once on a crit", () => {
    expectSameAttack("(d20+5 AC 12) * (2d6) + 3", d20.plus(5).ac(12).onHit(roll(2, d6).plus(3)));
    expectSameAttack("d20 + 5 AC 15 * 1d8 + 3", d20.plus(5).ac(15).onHit(roll(1, d8).plus(3)));
    const parsed = parse("(d20+5 AC 12) * (2d6) + 3");
    expect(parsed.outcomeProbability("crit")).toBeCloseTo(0.05, 12); // was 0
    expect(parsed.mean()).toBeCloseTo(147 / 20, 12);
  });

  it("(d20+5 AC 12) * (2d6) + 3 gives the exact figures on every path that reads crit status", () => {
    const attack = () => parse("(d20+5 AC 12) * (2d6) + 3");
    const base = turn([attack()]);
    const anyCrit = turn([attack()]).rider({ id: "smite", damage: roll(1, d4), on: "any-crit" });
    expect(anyCrit.mean() - base.mean()).toBeCloseTo(0.25, 10); // was 0
    expect(anyCrit.fireProbability("smite")).toBeCloseTo(0.05, 12); // was 0
    const firstHit = turn([attack()]).rider({ damage: roll(1, d4), on: "first-hit" });
    expect(firstHit.mean() - base.mean()).toBeCloseTo(15 / 8, 10); // was 1.75
  });

  it("every hit-only operator (`*`, `**`, `/`, `//`) doubles through the whole payload, like a parsed onHit string", () => {
    for (const tail of ["* (1d4)", "** 2", "/ 2", "// 2", "+ 1d4 + 2"]) {
      expectSameAttack(`(d20 + 5 AC 12) * (2d6) ${tail}`, d20.plus(5).ac(12).onHit(`(2d6) ${tail}`));
    }
  });

  it("a crit clause still wins: a trailing term is added to its payload as written, and the labels survive", () => {
    const built = d20.plus(5).ac(15).onHit(roll(1, d8).plus(roll(1, d6))).onCrit(roll(2, d8).plus(roll(1, d6)));
    expectSameAttack("(d20 + 5 AC 15) * (1d8) crit (2d8) + 1d6", built);
  });

  it("a miss clause keeps its label, and a trailing `+` adds to its non-zero damage too", () => {
    const built = d20.plus(5).ac(15).onHit(roll(2, d6).plus(3)).onMiss(roll(1, d6).plus(3));
    expectSameAttack("(d20 + 5 AC 15) * (2d6) miss (1d6) + 3", built);
    expect(parse("(d20 + 5 AC 15) * (2d6) miss (1d6) + 3").mean()).toBeCloseTo(351 / 40, 12);
  });
});

describe("advantage, disadvantage and halfling luck track the natural d20 through bonus to-hit dice", () => {
  it("(d20 > d20 + 5 + 1d4 AC 15) * (2d6): crit 39/400, mean 5537/800", () => {
    expectSameAttack("(d20 > d20 + 5 + 1d4 AC 15) * (2d6)", d20.withAdvantage().plus(5).plus(d4).ac(15).onHit(roll(2, d6)));
    const parsed = parse("(d20 > d20 + 5 + 1d4 AC 15) * (2d6)");
    expect(parsed.outcomeProbability("crit")).toBeCloseTo(39 / 400, 12); // was 0.024375
    expect(parsed.mean()).toBeCloseTo(5537 / 800, 12); // was 6.409375
  });

  it("(hd20 + 5 + 1d4 AC 15) * (2d6): crit 21/400, mean 4263/800", () => {
    expectSameAttack("(hd20 + 5 + 1d4 AC 15) * (2d6)", d20.reroll(1).plus(5).plus(d4).ac(15).onHit(roll(2, d6)));
    const parsed = parse("(hd20 + 5 + 1d4 AC 15) * (2d6)");
    expect(parsed.outcomeProbability("crit")).toBeCloseTo(21 / 400, 12); // was 0.013125
    expect(parsed.mean()).toBeCloseTo(4263 / 800, 12); // was 5.053125
  });

  it("disadvantage, elven accuracy, `!`, `reroll`, parentheses and `1d20` spell the same checks", () => {
    const damage = roll(2, d6);
    const adv = d20.withAdvantage().plus(5).plus(d4).ac(15).onHit(damage);
    expectSameAttack("(d20 < d20 + 5 + 1d4 AC 15) * (2d6)", d20.withDisadvantage().plus(5).plus(d4).ac(15).onHit(damage));
    expectSameAttack("(d20 > d20 > d20 + 5 + 1d4 AC 15) * (2d6)", d20.withElvenAccuracy().plus(5).plus(d4).ac(15).onHit(damage));
    expectSameAttack("(d20! + 5 + 1d4 AC 15) * (2d6)", adv);
    expectSameAttack("((d20 > d20) + 5 + 1d4 AC 15) * (2d6)", adv);
    expectSameAttack("(d20 reroll 1 + 5 + 1d4 AC 15) * (2d6)", d20.reroll(1).plus(5).plus(d4).ac(15).onHit(damage));
    expectSameAttack("(1d20 + 5 + 1d4 AC 15) * (2d6)", d20.plus(5).plus(d4).ac(15).onHit(damage));
    expect(parse("(d20 > d20 > d20 + 5 + 1d4 AC 15) * (2d6)").mean()).toBeCloseTo(30947 / 4000, 12);
  });

  it("a crit clause reads the same tracked slice", () => {
    expectSameAttack(
      "(d20 > d20 + 5 + 1d4 AC 15) * (1d8 + 3) crit (2d8 + 3)",
      d20.withAdvantage().plus(5).plus(d4).ac(15).onHit(roll(1, d8).plus(3)).onCrit(roll(2, d8).plus(3))
    );
  });

  it("xcrit with a bonus die crits on every natural face in range: crit 1/10, mean 441/80", () => {
    const expression = "(d20 + 5 + 1d4 AC 15) * (1d8 + 3) xcrit2 (2d8 + 3)";
    expectSameAttack(expression, d20.plus(5).plus(d4).ac(15).critOn(19).onHit(roll(1, d8).plus(3)).onCrit(roll(2, d8).plus(3)));
    expect(parse(expression).outcomeProbability("crit")).toBeCloseTo(1 / 10, 12); // was 0.0375
    expect(parse(expression).mean()).toBeCloseTo(441 / 80, 12); // was 5.23125
    expectSameAttack(
      "(d20 > d20 + 5 + 1d4 AC 15) * (1d8 + 3) xcrit2 (2d8 + 3)",
      d20.withAdvantage().plus(5).plus(d4).ac(15).critOn(19).onHit(roll(1, d8).plus(3)).onCrit(roll(2, d8).plus(3))
    );
    expect(parse("(d20 > d20 + 5 + 1d4 AC 15) * (1d8 + 3) xcrit2 (2d8 + 3)").mean()).toBeCloseTo(12063 / 1600, 12);
  });

  it("the natural roll is the check's d20 wherever it sits in the sum: a bonus die before it never crits", () => {
    const damage = roll(2, d6);
    // `d20.plus(5).plus(d4)` and `d20.plus(d4).plus(5)` build the same attack (tests/check-order.test.ts).
    const reference = d20.plus(5).plus(d4).ac(15).onHit(damage);
    for (const expression of [
      "(1d4 + d20 + 5 AC 15) * (2d6)",
      "(1d4 + 1d20 + 5 AC 15) * (2d6)",
      "(5 + 1d4 + d20 AC 15) * (2d6)",
      "(d4 + 5 + d20 AC 15) * (2d6)",
      "(1d4 + d20 + 5 AC 15) * (2d6) crit (4d6)",
    ]) {
      expectSameAttack(expression, reference);
      expect(parse(expression).outcomeProbability("crit"), expression).toBeCloseTo(1 / 20, 12); // was 0.1875
      expect(parse(expression).mean(), expression).toBeCloseTo(203 / 40, 12); // was 6.0375
    }
    // A bonus pool before the d20 is still a bonus: crit 1/20, mean 119/20 (was a throw).
    expectSameAttack("(2d4 + d20 + 5 AC 15) * (2d6)", d20.plus(5).plus(roll(2, d4)).ac(15).onHit(damage));
    expect(parse("(2d4 + d20 + 5 AC 15) * (2d6)").mean()).toBeCloseTo(119 / 20, 12);
    // With no d20, the largest die is the natural roll whichever side it is on: crit 1/12, mean 91/48.
    for (const expression of ["(d12 + 1d4 AC 10) * (1d6) crit (2d6)", "(1d4 + d12 AC 10) * (1d6) crit (2d6)"]) {
      expect(parse(expression).outcomeProbability("crit"), expression).toBeCloseTo(1 / 12, 12);
      expect(parse(expression).mean(), expression).toBeCloseTo(91 / 48, 12);
    }
  });

  it("keep-spelled advantage, disadvantage and elven accuracy keep one natural d20, like `d20 > d20`", () => {
    // With a clause, these are the engine's exact figures.
    for (const [expression, crit, mean] of [
      ["(2kh1(1d20) + 5 AC 15) * (2d6) crit (4d6)", 39 / 400, 1253 / 200],
      ["(2kh1d20 + 5 AC 15) * (2d6) crit (4d6)", 39 / 400, 1253 / 200],
      ["(2kl1(1d20) + 5 AC 15) * (2d6) crit (4d6)", 1 / 400, 427 / 200],
      ["(3kh1(1d20) + 5 AC 15) * (2d6) crit (4d6)", 1141 / 8000, 14721 / 2000],
      ["(2kh1(1d20) + 5 AC 15) * (2d6) xcrit2 (4d6)", 19 / 100, 553 / 80],
      ["(2kh1(1d20) + 5 AC 15) * (1d6)", 39 / 400, 1253 / 400],
    ] as const) {
      expect(parse(expression).outcomeProbability("crit"), expression).toBeCloseTo(crit, 12);
      expect(parse(expression).mean(), expression).toBeCloseTo(mean, 12);
    }
    // With no clause they crit like the builder's advantage, disadvantage and elven accuracy.
    const damage = roll(2, d6);
    expectSameAttack("(2kh1(1d20) + 5 AC 15) * (2d6)", d20.withAdvantage().plus(5).ac(15).onHit(damage));
    expectSameAttack("(2kh1d20 + 5 AC 15) * (2d6)", d20.withAdvantage().plus(5).ac(15).onHit(damage));
    expectSameAttack("(2kl1(1d20) + 5 AC 15) * (2d6)", d20.withDisadvantage().plus(5).ac(15).onHit(damage));
    expectSameAttack("(3kh1(1d20) + 5 AC 15) * (2d6)", d20.withElvenAccuracy().plus(5).ac(15).onHit(damage));
    expectSameAttack("(2kh1(1d20) + 1d4 + 5 AC 15) * (2d6)", d20.withAdvantage().plus(5).plus(d4).ac(15).onHit(damage));
  });

  it("`d20 > d4` crits when the d20's natural 20 is the value kept: crit 1/20, mean 119/40, as on main", () => {
    for (const expression of ["(d20 > d4 + 5 AC 10) * (1d6) crit (2d6)", "(d20 > d4 + 5 AC 10) * (1d6)"]) {
      expect(parse(expression).outcomeProbability("crit"), expression).toBeCloseTo(1 / 20, 12);
      expect(parse(expression).outcomeProbability("hit"), expression).toBeCloseTo(3 / 4, 12);
      expect(parse(expression).mean(), expression).toBeCloseTo(119 / 40, 12);
    }
    // A cap the natural 20 never survives never crits, with or without a clause: hit 4/5, mean 14/5.
    // Main read its crit from the highest totals: 3.85 with `crit`, 4.025 with `xcrit2`.
    for (const expression of [
      "(d20 < 15 + 5 AC 10) * (1d6)",
      "(d20 < 15 + 5 AC 10) * (1d6) crit (2d6)",
      "(d20 < 15 + 5 AC 10) * (1d6) xcrit2 (2d6)",
    ]) {
      const capped = parse(expression);
      expect(capped.outcomeProbability("crit"), expression).toBe(0);
      expect(capped.outcomeProbability("hit"), expression).toBeCloseTo(4 / 5, 12);
      expect(capped.mean(), expression).toBeCloseTo(14 / 5, 12);
    }
  });

  it("the natural roll is the check's one d20, even beside a larger die", () => {
    // Main's exact means, with a clause: 7637/4000, 749/400, 1071/400, 623/300, 3773/1200, 721/240.
    for (const [expression, crit, mean] of [
      ["(d20 + d100 AC 60) * (1d6) crit (2d6)", 61 / 2000, 7637 / 4000],
      ["(d20 + d100 AC 60) * (1d6)", 61 / 2000, 7637 / 4000],
      ["(d100 + d20 AC 60) * (1d6) crit (2d6)", 61 / 2000, 7637 / 4000],
      ["(d20 + 100 - d100 AC 60) * (1d6) crit (2d6)", 3 / 100, 749 / 400],
      ["(d20 + 100 - d100 AC 60) * (1d6)", 3 / 100, 749 / 400],
      // `+` skips a 0 total: a natural 20 less a d100 of 20 stays 0 and misses.
      ["(d20 - d100 + 100 AC 60) * (1d6) crit (2d6)", 59 / 2000, 7343 / 4000],
      ["(d20 - d100 + 100 AC 60) * (1d6)", 59 / 2000, 7343 / 4000],
      ["(d20 + d30 + 5 AC 25) * (1d6)", 1 / 20, 1071 / 400],
      ["(d20 + d30 + 5 AC 25) * (1d6) crit (2d6)", 1 / 20, 1071 / 400],
      ["(d20 + 1d30 AC 25) * (1d6) crit (2d6)", 13 / 300, 623 / 300],
      ["(d20 > d30 AC 10) * (1d6) crit (2d6)", 1 / 30, 3773 / 1200],
      ["(2kh1d20 + d100 AC 60) * (1d6) crit (2d6)", 2379 / 40000, 170163 / 80000],
      ["(d100 & d20 AC 10) * (1d6) crit (2d6)", 1 / 120, 721 / 240],
    ] as const) {
      expect(parse(expression).outcomeProbability("crit"), expression).toBeCloseTo(crit, 12);
      expect(parse(expression).mean(), expression).toBeCloseTo(mean, 12);
    }
    // More than one d20 and no single kept roll: a larger die does not stand in for the natural roll.
    for (const expression of ["(d20 + d20 + d100 AC 60) * (1d6)", "(d100 + 2d20 AC 60) * (1d6) crit (2d6)"]) {
      expect(() => parse(expression), expression).toThrow(/crit rate cannot be computed exactly/);
    }
  });

  it("`&` mixes checks by count: a crit is a d20 branch's natural 20, at that branch's share, in either order", () => {
    // Exact figures for the bare forms, which need a crit clause: 2.1, 2.275, 119/48, 13/6.
    // (Reading the mixed sums from their highest totals would instead give 1.8375 and 1.435.)
    for (const [expression, hit, crit, mean] of [
      ["(d20 & d20 AC 10) * (1d6) crit (2d6)", 1 / 2, 1 / 20, 21 / 10],
      ["(d20 & d20 AC 10) * (1d6)", 1 / 2, 1 / 20, 21 / 10],
      ["(d20 & d20 AC 10) * (1d6) xcrit2 (2d6)", 9 / 20, 1 / 10, 91 / 40],
      ["(d4 & d20 AC 5) * (1d6) crit (2d6)", 5 / 8, 1 / 24, 119 / 48],
      ["(d20 & d4 AC 5) * (1d6) crit (2d6)", 5 / 8, 1 / 24, 119 / 48],
      ["(d4 & d20 AC 5) * (1d6)", 5 / 8, 1 / 24, 119 / 48],
      ["(d20 & d4 AC 5) * (1d6)", 5 / 8, 1 / 24, 119 / 48],
      ["(10 & d20 AC 10) * (1d6) crit (2d6)", 11 / 21, 1 / 21, 13 / 6],
      ["(d20 & 10 AC 10) * (1d6) crit (2d6)", 11 / 21, 1 / 21, 13 / 6],
      ["(10 & d20 AC 10) * (1d6)", 11 / 21, 1 / 21, 13 / 6],
      ["(d20 & 10 AC 10) * (1d6)", 11 / 21, 1 / 21, 13 / 6],
      ["(d20 & d20 + 5 AC 15) * (1d6)", 1 / 2, 1 / 20, 21 / 10],
      ["((d20 + 5) & (d20 + 3) AC 15) * (1d6) crit (2d6)", 9 / 20, 1 / 20, 77 / 40],
      ["((d20 + d4) & d20 AC 15) * (1d6) crit (2d6)", 7 / 20, 1 / 20, 63 / 40],
      ["(d20 & (d20 + d4) AC 15) * (1d6)", 7 / 20, 1 / 20, 63 / 40],
      // An AC gate on either side of `&` makes the mix an attack check, so it crits in either order.
      ["(d4 & (d20 AC 5)) * (1d6)", 19 / 24, 1 / 24, 49 / 16],
      ["((d20 AC 5) & d4) * (1d6)", 19 / 24, 1 / 24, 49 / 16],
      ["(d4 & (d20 AC 5)) * (1d6) crit (2d6)", 19 / 24, 1 / 24, 49 / 16],
      ["(4 & (d20 AC 15)) * (1d6)", 2 / 7, 1 / 21, 4 / 3],
      ["((d20 AC 15) & 4) * (1d6)", 2 / 7, 1 / 21, 4 / 3],
      // A max, advantage, keep or reroll over a mix: exact figures.
      ["((d20 & d4) > d20 AC 15) * (1d6) crit (2d6)", 37 / 96, 43 / 480, 1897 / 960],
      ["((d20 & d4) > d20 AC 15) * (1d6)", 37 / 96, 43 / 480, 1897 / 960],
      ["(d20 > (d20 & d4) AC 15) * (1d6)", 37 / 96, 43 / 480, 1897 / 960],
      ["((d20 & 10) > d20 AC 15) * (1d6) crit (2d6)", 17 / 42, 2 / 21, 25 / 12],
      ["((d20 & d4)! AC 15) * (1d6)", 205 / 576, 47 / 576, 2093 / 1152],
      ["(2kh1(d20 & d20) AC 15) * (1d6) crit (2d6)", 33 / 80, 39 / 400, 1701 / 800],
      ["((d20 & d20) reroll 1 AC 15) * (1d6) crit (2d6)", 21 / 80, 21 / 400, 1029 / 800],
    ] as const) {
      const parsed = parse(expression);
      expect(parsed.outcomeProbability("hit"), expression).toBeCloseTo(hit, 12);
      expect(parsed.outcomeProbability("crit"), expression).toBeCloseTo(crit, 12);
      expect(parsed.mean(), expression).toBeCloseTo(mean, 12);
    }
    // Operand order never matters: bin for bin and label by label, with and without a clause.
    for (const [left, right] of [
      ["(10 & d20 AC 10) * (1d6)", "(d20 & 10 AC 10) * (1d6)"],
      ["(10 & d20 AC 10) * (1d6) crit (2d6)", "(d20 & 10 AC 10) * (1d6) crit (2d6)"],
      ["(d4 & d20 AC 5) * (1d6)", "(d20 & d4 AC 5) * (1d6)"],
      ["(d4 & d20 AC 5) * (1d6) crit (2d6)", "(d20 & d4 AC 5) * (1d6) crit (2d6)"],
      ["((d20 + d4) & d20 AC 15) * (1d6) crit (2d6)", "(d20 & (d20 + d4) AC 15) * (1d6) crit (2d6)"],
      ["((d20 & d4) > d20 AC 15) * (1d6)", "(d20 > (d20 & d4) AC 15) * (1d6)"],
      ["((d20 & d4) > d20 AC 15) * (1d6) crit (2d6)", "(d20 > (d20 & d4) AC 15) * (1d6) crit (2d6)"],
      ["(d4 & (d20 AC 5)) * (1d6)", "((d20 AC 5) & d4) * (1d6)"],
      ["(d4 & (d20 AC 5)) * (1d6) crit (2d6)", "((d20 AC 5) & d4) * (1d6) crit (2d6)"],
      ["(4 & (d20 AC 15)) * (1d6)", "((d20 AC 15) & 4) * (1d6)"],
    ] as const) {
      expectSameParse(left, right);
    }
  });

  it("`&` with a branch whose d20 is not one natural roll throws; a mix of numbers never crits", () => {
    for (const expression of [
      "((d20 + d20) & d20 AC 15) * (1d6) crit (2d6)",
      "(d20 & (d20 + d20) AC 15) * (1d6)",
      "(2d20 & d20 AC 15) * (1d6)",
      // A reroll draws again from the whole mix, not per branch. (1.1088 is not exact either:
      // Dice.reroll weights a mix's faces as if each were one face of a die. Exact: 637/576.)
      "((d20 & d4) reroll 1 AC 15) * (1d6) crit (2d6)",
      // A repeat, keep or advantage of a mix with a smaller die in it has no one natural roll to
      // replay per branch, so it is refused rather than approximated. Formerly exact: 119/48 and
      // 2093/1152, and 1951145/663552 for `!!`.
      "(1(d20 & d4) AC 5) * (1d6) crit (2d6)",
      "(2kh1(d20 & d4) AC 15) * (1d6) crit (2d6)",
      "((d20 & d4)!! AC 15) * (1d6)",
    ]) {
      expect(() => parse(expression), expression).toThrow(/crit rate cannot be computed exactly/);
    }
    for (const expression of ["(10 & 5 AC 8) * (1d6) crit (2d6)", "(10 & 5 AC 8) * (1d6)"]) {
      const parsed = parse(expression);
      expect(parsed.outcomeProbability("crit"), expression).toBe(0);
      expect(parsed.mean(), expression).toBeCloseTo(7 / 4, 12);
    }
  });

  it("`&` with an attack split into outcomes, a save beside a non-save, or a clause after it, throws", () => {
    // A mix weights each side by its count of outcomes. An attack's crit/miss/save split renormalises
    // its counts, so it has no count to weight by; a save mixed with a non-save has no one set of
    // labels; and a clause after the mix splits its left side alone (`d4 & (d20 AC 5) crit (d6)` crit
    // on the d4's 4, at 1/4). Each used to take its labels, and with a trailing term its mean, from
    // the left side.
    for (const expression of [
      "((d20 AC 5) * (1d6)) & d4",
      "d4 & ((d20 AC 5) * (1d6))",
      "(d4 & ((d20 AC 5) * (1d6))) * (1d6)",
      "(d20 + 5 AC 15) * (1d6) & 3",
      "((d20 AC 10) * (1d6) crit (2d6)) & ((d20 AC 15) * (1d6) crit (2d6))",
      "((d20 DC 12) * (8d6) save half) & 3",
      "d4 & (d20 DC 12)",
      "(d20 DC 12) & d4",
      "(d20 AC 10) & (d20 DC 12)",
      "(d20 + 5 AC 15) & (1d6) crit (2d6)",
      "d4 & (d20 AC 5) crit (d6)",
      "(d20 + 5 AC 15) & (1d6) miss (1)",
      "(d20 + 5 DC 15) & (d20 DC 12) save half",
    ]) {
      expect(() => parse(expression), expression).toThrow(/an `&` mix/);
    }
    // A check with no crit to split off, and two saves, still mix.
    expectSamePMF(parse("((15 AC 12) * (1d6)) & 1"), parse("1d6 & 1"));
    expectSameParse("((d20 DC 12) & (d20 DC 15)) * (8d6)", "((d20 DC 15) & (d20 DC 12)) * (8d6)");
  });

  it("`&` in a hit payload that doubles has no single doubled meaning: it throws; a crit clause resolves", () => {
    // `1d6 & 3` doubled as `2d6 & 3` moves the flat side's share of the mix from 1/7 to 1/37: the
    // engine gave 2.0588803 where keeping each side's share gives 57/28. Refused, not approximated.
    for (const expression of [
      "(d20 + 5 AC 15) * (1d6 & 3)",
      "(d20 + 5 AC 15) * (1d4 & 1d6)",
      "(d20 + 5 AC 15) * (d6 & d6 & 3)",
      "(d20 + 5 AC 15) * (3 & 1d6) miss (1)",
      "(d20 + 5 AC 15) * (1d6) + (1d4 & 2)",
    ]) {
      expect(() => parse(expression), expression).toThrow(/the mix `.*` has no single doubled meaning/);
    }
    for (const payload of ["1d6 & 3", "3 & 1d6", "2(1d6 & 3)", "2kh1(1d6 & 3)", "1d8 + (1d4 & 2)"]) {
      expect(() => d(payload).doubleDice(), payload).toThrow(AmbiguousCritDoublingError);
    }
    expect(() => d20.plus(5).ac(15).onHit("1d6 & 3").resolve()).toThrow(AmbiguousCritDoublingError);
    // A mix of flats has no dice to double; a crit clause gives the crit as written (2133/1036).
    expect(d("(3 & 4) + 1d6").doubleDice().toPMF().mean()).toBeCloseTo(21 / 2, 12);
    const explicit = parse("(d20 + 5 AC 15) * (1d6 & 3) crit (2d6 & 3)");
    expect(explicit.outcomeProbability("crit")).toBeCloseTo(1 / 20, 12);
    expect(explicit.mean()).toBeCloseTo(2133 / 1036, 12);
  });

  it("a check with no single natural die to crit on throws instead of guessing", () => {
    for (const expression of [
      "(2d20 + 5 AC 30) * (1d6)",
      "(2d20 + 5 AC 30) * (1d6) crit (2d6)",
      "(d20 + d20 + 5 AC 30) * (1d6)",
      "(d20 + d20 + 5 AC 30) * (1d6) crit (2d6)",
      "(1d4 + 2d20 AC 30) * (1d6)",
      "(2kh2(1d20) + 5 AC 30) * (1d6)",
      "((d20 + 1d4)! AC 15) * (1d6)",
      "(d20 + 5 > d20 AC 15) * (1d6)",
    ]) {
      expect(() => parse(expression), expression).toThrow(/crit rate cannot be computed exactly/);
    }
    // Without a crit there is nothing to compute: the same checks still parse.
    expect(parse("2d20 + 5 AC 30").mass()).toBeCloseTo(1, 12);
  });

  it("a check with no die in it has no natural roll: crit mass exactly 0, no throw, as on main", () => {
    // The builder's dieless check agrees: `roll.flat(15).ac(12)` hits for certain and never crits.
    expectSameAttack("(15 AC 12) * (1d6)", roll.flat(15).alwaysHits().onHit(roll(1, d6)).noCrit());
    expectSameAttack("(15 AC 12) * (1d6)", roll.flat(15).ac(12).onHit(roll(1, d6)));
    expectSameAttack("(10 + 5 AC 12) * (2d6) + 3", roll.flat(15).alwaysHits().onHit(roll(2, d6).plus(3)).noCrit());
    // A die on the AC side is the target's roll, never the attack's natural roll.
    expectSameAttack("(25 AC d20) * (1d6)", roll.flat(25).alwaysHits().onHit(roll(1, d6)).noCrit());
    for (const [expression, mean, hit] of [
      ["(15 AC 12) * (1d6)", 7 / 2, 1],
      ["15 AC 12 * 1d6 + 3", 13 / 2, 1],
      ["((15) AC 12) * (1d6) miss (1)", 7 / 2, 1],
      ["(15 AC 20) * (1d6)", 0, 0],
      ["(2(5) + 5 AC 12) * (1d6)", 7 / 2, 1],
      ["(3 ** 5 AC 16) * (1d6 + 2)", 0, 0],
      ["(25 AC d20) * (1d6)", 7 / 2, 1],
      // A crit clause on it can never fire: the clause is inert and the hit payload applies as written.
      ["(15 AC 12) * (1d6) crit (2d6)", 7 / 2, 1],
      ["(15 AC 12) * (1d6) xcrit2 (2d6)", 7 / 2, 1],
      ["(15 AC 20) * (1d6) crit (2d6)", 0, 0],
      ["(25 AC d20) * (1d6) crit (2d6)", 7 / 2, 1],
    ] as const) {
      const parsed = parse(expression);
      expect(parsed.outcomeProbability("crit"), expression).toBe(0);
      expect(parsed.outcomeProbability("hit"), expression).toBeCloseTo(hit, 12);
      expect(parsed.mean(), expression).toBeCloseTo(mean, 12);
    }
    expect(parse("(15 AC 20) * (1d6) crit (2d6)").outcomeProbability("missNone")).toBeCloseTo(1, 12);
    // The builder's flat check round-trips through its own string to the same mean.
    const flat = roll.flat(15).ac(12).onHit(d6);
    expect(flat.toExpression()).toBe("(15 AC 12) * (1d6) crit (2d6)");
    expect(parse(flat.toExpression()).mean()).toBeCloseTo(flat.toPMF().mean(), 12);
  });
});

describe("xcrit: the hit/crit split and mean, exact", () => {
  const hit = roll(2, d6).plus(3);
  const crit = roll(4, d6).plus(3);

  it("flat xcrit2: hit 9/20, crit 1/10, mean 31/5", () => {
    const expression = "(d20 + 5 AC 15) * (2d6 + 3) xcrit2 (4d6 + 3)";
    expectSameAttack(expression, d20.plus(5).ac(15).critOn(19).onHit(hit).onCrit(crit));
    const parsed = parse(expression);
    expect(parsed.outcomeProbability("hit")).toBeCloseTo(9 / 20, 12);
    expect(parsed.outcomeProbability("crit")).toBeCloseTo(1 / 10, 12);
    expect(parsed.mean()).toBeCloseTo(31 / 5, 12);
  });

  it("advantage xcrit2: hit 243/400, crit 19/100, mean 1861/200", () => {
    const expression = "(d20 > d20 + 5 AC 15) * (2d6 + 3) xcrit2 (4d6 + 3)";
    expectSameAttack(expression, d20.withAdvantage().plus(5).ac(15).critOn(19).onHit(hit).onCrit(crit));
    const parsed = parse(expression);
    expect(parsed.outcomeProbability("hit")).toBeCloseTo(243 / 400, 12);
    expect(parsed.outcomeProbability("crit")).toBeCloseTo(19 / 100, 12);
    expect(parsed.mean()).toBeCloseTo(1861 / 200, 12);
  });

  it("disadvantage xcrit3: hit 7/25, crit 9/400, mean 1273/400", () => {
    const expression = "(d20 < d20 + 5 AC 15) * (2d6 + 3) xcrit3 (4d6 + 3)";
    expectSameAttack(expression, d20.withDisadvantage().plus(5).ac(15).critOn(18).onHit(hit).onCrit(crit));
    const parsed = parse(expression);
    expect(parsed.outcomeProbability("hit")).toBeCloseTo(7 / 25, 12);
    expect(parsed.outcomeProbability("crit")).toBeCloseTo(9 / 400, 12);
    expect(parsed.mean()).toBeCloseTo(1273 / 400, 12);
  });

  it("a crit range reaching a face that misses: the natural 19 stays a miss, crit 1/20, mean 7/20", () => {
    const expression = "(d20 + 1 AC 21) * (1d6) xcrit2 (2d6)";
    expectSameAttack(expression, d20.plus(1).ac(21).critOn(19).onHit(roll(1, d6)).onCrit(roll(2, d6)));
    const parsed = parse(expression);
    expect(parsed.outcomeProbability("hit")).toBeCloseTo(0, 12);
    expect(parsed.outcomeProbability("crit")).toBeCloseTo(1 / 20, 12);
    expect(parsed.mean()).toBeCloseTo(7 / 20, 12);
  });
});
