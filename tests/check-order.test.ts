import { describe, expect, it } from "vitest";
import "../src/builder/ac";
import "../src/builder/dc";
import type { ACBuilder } from "../src/builder/ac";
import { d20, d4, d6, roll } from "../src/builder/factory";
import type { RollBuilder } from "../src/builder/roll";
import { parse } from "../src/parser/parser";
import type { PMF } from "../src/pmf/pmf";

/**
 * A check is a sum: the natural d20, its bonus dice (Bless, Bane, Guidance) and its flat bonus.
 * The builder stores a flat `.plus(n)` on whichever group came last, so `d20.plus(d4).plus(5)`
 * puts the 5 on the d4 group. The check must resolve the same however the terms were ordered.
 *
 * The references below come from an independent enumeration over the natural d20 and the bonus
 * dice (no engine code): a natural 1 misses, a natural 20 crits, any other roll in the crit range
 * crits if it reaches the AC, and otherwise the total hits when it reaches the AC.
 */

type Kind = "flat" | "advantage" | "disadvantage" | "elven accuracy";

/** P(natural = r) for a d20 rolled once, or kept high/low from two or three. */
function naturalD20(kind: Kind): Map<number, number> {
  const lifted = (c: number): number =>
    kind === "advantage" ? c ** 2 : kind === "elven accuracy" ? c ** 3 : kind === "disadvantage" ? 1 - (1 - c) ** 2 : c;
  const out = new Map<number, number>();
  for (let r = 1; r <= 20; r++) out.set(r, lifted(r / 20) - lifted((r - 1) / 20));
  return out;
}

/** Bonus dice as signed sides: 4 is +d4 (Bless), -4 is -d4 (Bane). */
function bonusSum(dice: readonly number[]): Map<number, number> {
  let dist = new Map<number, number>([[0, 1]]);
  for (const signed of dice) {
    const sides = Math.abs(signed);
    const sign = Math.sign(signed);
    const next = new Map<number, number>();
    for (const [v, p] of dist) {
      for (let f = 1; f <= sides; f++) next.set(v + sign * f, (next.get(v + sign * f) ?? 0) + p / sides);
    }
    dist = next;
  }
  return dist;
}

function enumerateAttack(
  kind: Kind,
  dice: readonly number[],
  flat: number,
  ac: number,
  critOn: number
): { hit: number; crit: number; miss: number } {
  const bonus = bonusSum(dice);
  let hit = 0;
  let crit = 0;
  let miss = 0;
  for (const [r, pr] of naturalD20(kind)) {
    if (r === 1) {
      miss += pr;
      continue;
    }
    if (r === 20) {
      crit += pr;
      continue;
    }
    let reaches = 0;
    for (const [v, p] of bonus) if (r + v + flat >= ac) reaches += p;
    if (r >= critOn) crit += pr * reaches;
    else hit += pr * reaches;
    miss += pr * (1 - reaches);
  }
  return { hit, crit, miss };
}

function enumerateSaveFail(kind: Kind, dice: readonly number[], flat: number, dc: number): number {
  const bonus = bonusSum(dice);
  let fail = 0;
  for (const [r, pr] of naturalD20(kind)) {
    for (const [v, p] of bonus) if (r + v + flat < dc) fail += pr * p;
  }
  return fail;
}

function expectSamePMF(actual: PMF, expected: PMF, what: string): void {
  const support = new Set([...actual.support(), ...expected.support()]);
  for (const value of support) {
    expect(Math.abs(actual.pAt(value) - expected.pAt(value)), `${what}: bin ${value}`).toBeLessThanOrEqual(1e-12);
  }
}

const ROOTS: ReadonlyArray<{ kind: Kind; die: () => RollBuilder }> = [
  { kind: "flat", die: () => d20 },
  { kind: "advantage", die: () => d20.withAdvantage() },
  { kind: "disadvantage", die: () => d20.withDisadvantage() },
  { kind: "elven accuracy", die: () => d20.withElvenAccuracy() },
];

/** Each row: one check written every way, the bonus dice it holds, and its net flat bonus. */
const ORDERINGS: ReadonlyArray<{
  dice: readonly number[];
  flat: number;
  spellings: ReadonlyArray<{ name: string; build: (root: RollBuilder) => RollBuilder }>;
}> = [
  {
    dice: [4],
    flat: 5,
    spellings: [
      { name: "d20.plus(5).plus(d4)", build: (r) => r.plus(5).plus(d4) },
      { name: "d20.plus(d4).plus(5)", build: (r) => r.plus(d4).plus(5) },
    ],
  },
  {
    dice: [4, 6],
    flat: 5,
    spellings: [
      { name: "d20.plus(5).plus(d4).plus(d6)", build: (r) => r.plus(5).plus(d4).plus(d6) },
      { name: "d20.plus(d4).plus(5).plus(d6)", build: (r) => r.plus(d4).plus(5).plus(d6) },
      { name: "d20.plus(d4).plus(d6).plus(5)", build: (r) => r.plus(d4).plus(d6).plus(5) },
    ],
  },
  {
    dice: [4],
    flat: 3,
    spellings: [
      { name: "d20.plus(3).plus(d4)", build: (r) => r.plus(3).plus(d4) },
      { name: "d20.plus(5).plus(d4).minus(2)", build: (r) => r.plus(5).plus(d4).minus(2) },
      { name: "d20.plus(d4).minus(2).plus(5)", build: (r) => r.plus(d4).minus(2).plus(5) },
    ],
  },
  {
    dice: [-4],
    flat: 5,
    spellings: [
      { name: "d20.plus(5).minus(d4)", build: (r) => r.plus(5).minus(d4) },
      { name: "d20.minus(d4).plus(5)", build: (r) => r.minus(d4).plus(5) },
    ],
  },
];

const AC = 15;

describe("a check resolves the same however its flat bonus and bonus dice are ordered", () => {
  it("d20.plus(d4).plus(5) vs AC 15, 2d6 on a hit: hit 5/8, crit 1/20, miss 13/40, mean 203/40", () => {
    const pmf = d20.plus(d4).plus(5).ac(AC).onHit(roll(2, d6)).toPMF();
    expect(pmf.outcomeProbability("hit")).toBeCloseTo(5 / 8, 12);
    expect(pmf.outcomeProbability("crit")).toBeCloseTo(1 / 20, 12);
    expect(pmf.outcomeProbability("missNone")).toBeCloseTo(13 / 40, 12);
    expect(pmf.mean()).toBeCloseTo(203 / 40, 12);
  });

  for (const { kind, die } of ROOTS) {
    for (const critOn of [20, 19]) {
      describe(`${kind}, crit on ${critOn}`, () => {
        for (const { dice, flat, spellings } of ORDERINGS) {
          const exact = enumerateAttack(kind, dice, flat, AC, critOn);
          const withCrit = (check: RollBuilder): ACBuilder =>
            critOn === 20 ? check.ac(AC) : check.ac(AC).critOn(critOn);
          const referenceAttack = withCrit(spellings[0].build(die())).onHit(roll(2, d6));
          const reference = referenceAttack.toPMF();
          // parse() has no natural-1 auto-miss, so it agrees with the builder only where a natural
          // 1 cannot reach the AC anyway. Every spelling still has to parse to the same attack.
          const naturalOneCanHit = 1 + flat + dice.reduce((sum, s) => sum + Math.max(s, -1), 0) >= AC;

          for (const { name, build } of spellings) {
            it(`${name}: hit/crit/miss match the enumeration and the attack matches ${spellings[0].name} bin for bin`, () => {
              const check = withCrit(build(die()));
              const attack = check.onHit(roll(2, d6));
              const pmf = attack.toPMF();
              expect(pmf.outcomeProbability("hit")).toBeCloseTo(exact.hit, 12);
              expect(pmf.outcomeProbability("crit")).toBeCloseTo(exact.crit, 12);
              expect(pmf.outcomeProbability("missNone")).toBeCloseTo(exact.miss, 12);
              expectSamePMF(pmf, reference, name);
              expectSamePMF(check.toPMF(), withCrit(spellings[0].build(die())).toPMF(), `${name} check`);
              const roundTrip = parse(attack.toExpression());
              expectSamePMF(roundTrip, parse(referenceAttack.toExpression()), `${name} round trip`);
              if (!naturalOneCanHit) expectSamePMF(roundTrip, pmf, `${name} round trip vs builder`);
            });
          }
        }
      });
    }
  }
});

describe("a save resolves the same however its flat bonus and bonus dice are ordered", () => {
  // dc() refuses an elven-accuracy roll: elven accuracy is an attack feature.
  for (const { kind, die } of ROOTS.filter((root) => root.kind !== "elven accuracy")) {
    for (const { dice, flat, spellings } of ORDERINGS) {
      const fail = enumerateSaveFail(kind, dice, flat, AC);
      for (const { name, build } of spellings) {
        it(`${kind} ${name} vs DC 15: P(fail) matches the enumeration`, () => {
          const save = build(die()).dc(AC);
          expect(save.onSaveFailure(roll.flat(10)).toPMF().mean()).toBeCloseTo(10 * fail, 12);
          expect(save.toPMF().pAt(1)).toBeCloseTo(fail, 12);
        });
      }
    }
  }
});

describe("an always-crit attack resolves the same however its flat bonus and bonus dice are ordered", () => {
  // Every hit is a crit: the mean is P(hit or crit) × 14 (4d6). Main added the 5 twice when it
  // followed the d4: 12.775 for d20.plus(d4).plus(5), 9.45 for d20.minus(d4).plus(5).
  for (const { name, dice, p, spellings } of [
    { name: "d20 + d4 + 5: 27/40 × 14 = 9.45", dice: [4], p: 27 / 40, spellings: [(r: RollBuilder) => r.plus(d4).plus(5), (r: RollBuilder) => r.plus(5).plus(d4)] },
    { name: "d20 - d4 + 5: 17/40 × 14 = 5.95", dice: [-4], p: 17 / 40, spellings: [(r: RollBuilder) => r.minus(d4).plus(5), (r: RollBuilder) => r.plus(5).minus(d4)] },
  ]) {
    it(`${name} vs AC 15, 2d6 on a hit`, () => {
      const exact = enumerateAttack("flat", dice, 5, AC, 20);
      expect(exact.hit + exact.crit).toBeCloseTo(p, 12);
      for (const build of spellings) {
        const pmf = build(d20).ac(AC).alwaysCrits().onHit(roll(2, d6)).toPMF();
        expect(pmf.outcomeProbability("crit")).toBeCloseTo(p, 12);
        expect(pmf.outcomeProbability("hit")).toBeCloseTo(0, 12);
        expect(pmf.mean()).toBeCloseTo(p * 14, 12);
      }
    });
  }
});
