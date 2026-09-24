import { describe, expect, it } from "vitest";
import { d20, d4, d6, flat, hd20, roll } from "../src/builder";
import type { RollBuilder } from "../src/builder";
import { parse } from "../src/parser/parser";
import type { PMF } from "../src/pmf/pmf";

/**
 * A check's natural roll is its d20 (or, with no d20, its largest die): the die whose 1 misses and
 * whose 20 hits and crits. Every other die is a bonus die added to the total, and a check with no
 * die at all is a plain comparison of its flat total against the target.
 *
 * References come from an independent enumeration over the natural d20, the bonus dice and the
 * damage dice; no engine code computes an expected value.
 */

type Kind = "flat" | "advantage" | "disadvantage";
type Dist = Map<number, number>;

function naturalD20(kind: Kind): Dist {
  const lifted = (c: number): number =>
    kind === "advantage" ? c ** 2 : kind === "disadvantage" ? 1 - (1 - c) ** 2 : c;
  const out: Dist = new Map();
  for (let r = 1; r <= 20; r++) out.set(r, lifted(r / 20) - lifted((r - 1) / 20));
  return out;
}

function diceSum(count: number, sides: number): Dist {
  let dist: Dist = new Map([[0, 1]]);
  for (let i = 0; i < count; i++) {
    const next: Dist = new Map();
    for (const [v, p] of dist) {
      for (let f = 1; f <= sides; f++) next.set(v + f, (next.get(v + f) ?? 0) + p / sides);
    }
    dist = next;
  }
  return dist;
}

function addInto(out: Dist, dist: Dist, weight: number, shift = 0): void {
  for (const [v, p] of dist) out.set(v + shift, (out.get(v + shift) ?? 0) + p * weight);
}

/** d20 (+ bonus dice) + flat vs AC, `hit` on a hit and `crit` on a crit (natural 20 only). */
function enumerateAttack(kind: Kind, bonus: Dist, mod: number, ac: number, hit: Dist, crit: Dist) {
  let pHit = 0;
  let pCrit = 0;
  for (const [r, pr] of naturalD20(kind)) {
    if (r === 1) continue;
    if (r === 20) {
      pCrit += pr;
      continue;
    }
    for (const [b, pb] of bonus) if (r + b + mod >= ac) pHit += pr * pb;
  }
  const pmf: Dist = new Map();
  addInto(pmf, hit, pHit);
  addInto(pmf, crit, pCrit);
  pmf.set(0, (pmf.get(0) ?? 0) + 1 - pHit - pCrit);
  return { pHit, pCrit, pmf };
}

function expectBins(actual: PMF, expected: Dist | PMF): void {
  const reference: Dist =
    expected instanceof Map ? expected : new Map([...expected.support()].map((k) => [k, expected.pAt(k)]));
  const keys = new Set<number>([...actual.support(), ...reference.keys()]);
  for (const k of keys) {
    expect(actual.pAt(k), `bin ${k}`).toBeCloseTo(reference.get(k) ?? 0, 12);
  }
}

describe("a check with no die compares its flat total against the target", () => {
  it("hits for certain when the flat total reaches the AC, with no crit and no natural-1 miss", () => {
    const res = flat(15).ac(12).onHit(roll(1, d6)).resolve(0);
    expect(res.weights.hit).toBe(1);
    expect(res.weights.crit).toBe(0);
    expect(res.weights.miss).toBe(0);
    expectBins(res.pmf, diceSum(1, 6));
  });

  it("misses for certain when the flat total falls short, matching the string grammar", () => {
    const attack = flat(10).ac(12).onHit(roll(1, d6));
    expect(attack.toPMF().pAt(0)).toBe(1);
    expect(attack.toPMF().mean()).toBe(parse("(10 AC 12) * (1d6)").mean());
  });

  it("adds bonus dice to the flat total with no natural roll among them", () => {
    // 10 + d4 >= 12 on a 2, 3 or 4.
    const res = flat(10).plus(d4).ac(12).onHit(roll(1, d6)).resolve(0);
    expect(res.weights.hit).toBeCloseTo(3 / 4, 15);
    expect(res.weights.crit).toBe(0);
    expect(res.pmf.mean()).toBeCloseTo((3 / 4) * (7 / 2), 14);
  });

  it("resolves the raw check PMF as the flat total when it reaches the AC", () => {
    expectBins(flat(15).ac(12).toPMF(), new Map([[15, 1]]));
    expectBins(flat(10).ac(12).toPMF(), new Map([[0, 1]]));
  });

  it("succeeds or fails a save for certain on the flat total alone", () => {
    const fails = flat(10).dc(12).onSaveFailure(roll(2, d6)).resolve(0);
    expect(fails.weights.fail).toBe(1);
    expect(fails.pmf.mean()).toBeCloseTo(7, 14);
    expect(flat(15).dc(12).toPMF().pAt(1)).toBe(0);
    expect(flat(12).dc(12).onSaveFailure(roll(2, d6)).toPMF().pAt(0)).toBe(1);
  });
});

describe("the d20 is the natural roll wherever it appears in the check", () => {
  const damage = diceSum(2, 6);
  const critDamage = diceSum(4, 6);

  it("treats a leading bonus die as a bonus die", () => {
    const expected = enumerateAttack("flat", diceSum(1, 4), 5, 15, damage, critDamage);
    const res = d4.plus(d20).plus(5).ac(15).onHit(roll(2, d6)).resolve(0);
    expect(res.weights.crit).toBeCloseTo(1 / 20, 15);
    expect(res.weights.hit).toBeCloseTo(5 / 8, 15);
    expect(res.pmf.mean()).toBeCloseTo(203 / 40, 13);
    expectBins(res.pmf, expected.pmf);
    expectBins(res.pmf, d20.plus(d4).plus(5).ac(15).onHit(roll(2, d6)).resolve(0).pmf);
  });

  it("prefers the d20 over a larger bonus die", () => {
    const res = roll(1, 100).plus(d20).ac(200).onHit(roll(2, d6)).resolve(0);
    // Only a natural 20 reaches AC 200.
    expect(res.weights.crit).toBeCloseTo(1 / 20, 15);
    expect(res.weights.hit).toBe(0);
  });

  it("uses the largest die as the natural roll when there is no d20", () => {
    // d8 natural: its 1 misses; the d4 is a bonus die.
    const res = d4.plus(roll(1, 8)).ac(2).onHit(roll(1, d6)).resolve(0);
    expect(res.weights.miss).toBeCloseTo(1 / 8, 15);
    expect(res.weights.crit).toBe(0);
  });
});

describe("advantage and disadvantage apply to the natural d20 whatever the call order", () => {
  it("advantage after a bonus die advantages the d20", () => {
    const check = d20.plus(d4).withAdvantage().plus(5);
    expect(check.rollType).toBe("advantage");
    const expected = enumerateAttack("advantage", diceSum(1, 4), 5, 15, diceSum(2, 6), diceSum(4, 6));
    const res = check.ac(15).onHit(roll(2, d6)).resolve(0);
    expect(res.weights.hit).toBeCloseTo(127 / 160, 15);
    expect(res.weights.crit).toBeCloseTo(39 / 400, 15);
    expect(res.pmf.mean()).toBeCloseTo(5537 / 800, 13);
    expectBins(res.pmf, expected.pmf);
    expectBins(res.pmf, d20.withAdvantage().plus(d4).plus(5).ac(15).onHit(roll(2, d6)).resolve(0).pmf);
  });

  it("disadvantage after a bonus die disadvantages a save's d20", () => {
    // P(d20 low of two + d4 + 3 >= 15), enumerated.
    let pSuccess = 0;
    for (const [r, pr] of naturalD20("disadvantage")) {
      for (let b = 1; b <= 4; b++) if (r + b + 3 >= 15) pSuccess += pr / 4;
    }
    expect(pSuccess).toBeCloseTo(267 / 800, 15);
    const save = d20.plus(d4).withDisadvantage().plus(3).dc(15);
    expect(save.toPMF().pAt(0)).toBeCloseTo(267 / 800, 15);
    expect(save.onSaveFailure(roll(2, d6)).resolve(0).weights.success).toBeCloseTo(267 / 800, 15);
  });

  it("elven accuracy after a bonus die applies to the d20", () => {
    const res = d20.plus(d4).withElvenAccuracy().plus(5).ac(30).onHit(roll(1, d6)).resolve(0);
    // Only a natural 20 reaches AC 30: best of three d20s shows a 20 with probability 1141/8000.
    expect(res.weights.crit).toBeCloseTo(1141 / 8000, 15);
  });
});

describe("a check whose natural roll is not one die is refused", () => {
  const cases: [string, () => RollBuilder][] = [
    ["roll(2, d20)", () => roll(2, d20).plus(5)],
    ["d20 + d20", () => d20.plus(d20).plus(5)],
    ["hd20 + d20", () => hd20.plus(d20)],
  ];
  for (const [name, build] of cases) {
    it(`${name} as an attack or a save throws`, () => {
      expect(() => build().ac(15).onHit(roll(1, d6)).resolve(0)).toThrow(/natural roll is not one die/);
      expect(() => build().ac(15).toPMF()).toThrow(/natural roll is not one die/);
      expect(() => build().dc(15).toPMF()).toThrow(/natural roll is not one die/);
      expect(() => build().dc(15).onSaveFailure(roll(1, d6)).resolve(0)).toThrow(/natural roll is not one die/);
    });
  }
});
