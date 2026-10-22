import { describe, expect, it } from "vitest";
import { d20, d8, flat, keepBestDamage, roll, turn } from "../src/builder";
import type { Rng } from "../src/common/rng";
import type { RowContext } from "../src/turn/types";
import { add, expectLabelled, mixLabelled, point, shift, uniform, type LabelledDist } from "./enumerate-dice";

/**
 * `plusNatural20Damage()`: damage dealt only when the kept d20 shows a natural 20 (Boon of
 * Irresistible Offense, Vicious, Sharpness, Life Stealing), never on a crit from a crit range or
 * a crit-on-hit. A natural 20 always crits, so the extra rides a share of the crit branch:
 * P(natural 20) / P(crit) of it.
 */

/** An extra too large for any other part of the payload to reach: P(total >= EXTRA) = P(natural 20). */
const EXTRA = 100;

const context: RowContext = {
  rollType: "flat",
  autoHit: false,
  critOnHit: false,
  autoFail: false,
  vulnerable: false,
  penaltyDice: [],
  joined: [],
};

const scripted = (faces: number[]): Rng => ({
  die: () => {
    if (faces.length === 0) throw new Error("no faces left");
    return faces.shift()!;
  },
  chance: () => {
    throw new Error("no coins");
  },
});

function labelled(label: string, dist: Map<number, number>): LabelledDist {
  return new Map([...dist].map(([value, p]) => [value, { [label]: p }]));
}

describe("plusNatural20Damage: probability", () => {
  // +5 against AC 10: naturals 5..20 hit (16/20), 1..4 miss.
  const check = d20.plus(5).ac(10);

  it("crit range 18-20, flat: P(natural 20) = 1/20 against P(crit) = 3/20", () => {
    const pmf = check.critOn(18).onHit(d8).plusNatural20Damage(flat(EXTRA)).pmf;
    expect(pmf.outcomeProbability("crit")).toBeCloseTo(3 / 20, 15);
    expect(pmf.tailProbGE(EXTRA)).toBeCloseTo(1 / 20, 15);
  });

  it("advantage: P(natural 20) = 1 - (19/20)^2, P(crit 18-20) = 1 - (17/20)^2", () => {
    const pmf = d20.withAdvantage().plus(5).ac(10).critOn(18).onHit(d8).plusNatural20Damage(flat(EXTRA)).pmf;
    expect(pmf.tailProbGE(EXTRA)).toBeCloseTo(1 - (19 / 20) ** 2, 15);
    expect(pmf.outcomeProbability("crit")).toBeCloseTo(1 - (17 / 20) ** 2, 15);
  });

  it("disadvantage: P(natural 20) = (1/20)^2", () => {
    const pmf = d20.withDisadvantage().plus(5).ac(10).onHit(d8).plusNatural20Damage(flat(EXTRA)).pmf;
    expect(pmf.tailProbGE(EXTRA)).toBeCloseTo(1 / 400, 15);
  });

  it("elven accuracy (three dice): P(natural 20) = 1 - (19/20)^3", () => {
    const pmf = d20.withAdvantage().plus(5).ac(10).threeDiceAdvantage().onHit(d8).plusNatural20Damage(flat(EXTRA)).pmf;
    expect(pmf.tailProbGE(EXTRA)).toBeCloseTo(1 - (19 / 20) ** 3, 15);
  });

  it("a forced crit on a non-20 does not deal it: crit-on-hit and always-hit-always-crit", () => {
    const critOnHit = check.alwaysCrits().onHit(d8).plusNatural20Damage(flat(EXTRA)).pmf;
    expect(critOnHit.outcomeProbability("crit")).toBeCloseTo(16 / 20, 15);
    expect(critOnHit.tailProbGE(EXTRA)).toBeCloseTo(1 / 20, 15);

    const always = d20.alwaysHits().alwaysCrits().onHit(d8).plusNatural20Damage(flat(EXTRA)).pmf;
    expect(always.outcomeProbability("crit")).toBeCloseTo(1, 15);
    expect(always.tailProbGE(EXTRA)).toBeCloseTo(1 / 20, 15);
  });

  it("a turn context re-derives it: granted advantage, granted crit-on-hit", () => {
    const attack = check.critOn(18).onHit(d8).plusNatural20Damage(flat(EXTRA));
    expect(attack.under({ ...context, rollType: "advantage" }).tailProbGE(EXTRA)).toBeCloseTo(1 - (19 / 20) ** 2, 15);
    const paralyzed = attack.under({ ...context, critOnHit: true });
    expect(paralyzed.outcomeProbability("crit")).toBeCloseTo(16 / 20, 15);
    expect(paralyzed.tailProbGE(EXTRA)).toBeCloseTo(1 / 20, 15);
  });

  it("a check with no d20 never rolls a natural 20", () => {
    expect(flat(5).ac(3).onHit(d8).plusNatural20Damage(flat(EXTRA)).pmf.tailProbGE(EXTRA)).toBe(0);
  });
});

describe("plusNatural20Damage: distribution", () => {
  it("is added verbatim (never doubled) on the natural-20 share of the crit branch", () => {
    // Naturals: 1..4 miss, 5..17 hit (d8), 18..19 crit (2d8), 20 crit (2d8 + 2d6 + 3, the extra not doubled).
    const extra = roll(2, 6).plus(3);
    const pmf = d20.plus(5).ac(10).critOn(18).onHit(d8).plusNatural20Damage(extra).pmf;
    const twoD8 = add(uniform(8), uniform(8));
    expectLabelled(
      pmf,
      mixLabelled(
        [labelled("missNone", point(0)), 4 / 20],
        [labelled("hit", uniform(8)), 13 / 20],
        [labelled("crit", twoD8), 2 / 20],
        [labelled("crit", shift(add(twoD8, uniform(6), uniform(6)), 3)), 1 / 20]
      )
    );
    // Mean: 13/20 * 4.5 + 3/20 * 9 + 1/20 * 10.
    expect(pmf.mean()).toBeCloseTo((13 * 4.5 + 3 * 9 + 10) / 20, 12);
  });

  it("calls accumulate, and stack with plusSeparateDamage (doubled on every crit)", () => {
    const pmf = d20
      .plus(5)
      .ac(10)
      .onHit(d8)
      .plusSeparateDamage(roll(1, 4))
      .plusNatural20Damage(flat(7))
      .plusNatural20Damage(flat(3)).pmf;
    // 5..19 hit: d8 + d4; 20: 2d8 + 2d4 + 10.
    expect(pmf.mean()).toBeCloseTo((15 * (4.5 + 2.5) + (9 + 5 + 10)) / 20, 12);
  });

  it("the crit slice is the crit base payload with the natural-20 share in the separate channel", () => {
    const resolved = d20.plus(5).ac(10).critOn(18).onHit(d8).plusNatural20Damage(flat(EXTRA)).resolve();
    // P(natural 20 | crit) = (1/20) / (3/20).
    expect(resolved.critSeparate.pAt(EXTRA)).toBeCloseTo(1 / 3, 15);
    expect(resolved.critSeparate.pAt(0)).toBeCloseTo(2 / 3, 15);
    expect(resolved.hitSeparate.pAt(0)).toBe(1);
    expect(resolved.hit).not.toBe(resolved.hitBase);
    expect(resolved.crit.mean()).toBeCloseTo(9 + EXTRA / 3, 12);
  });

  it("vulnerability doubles it with the rest of the landing", () => {
    const attack = d20.plus(5).ac(10).onHit(flat(4)).plusNatural20Damage(flat(10));
    // 5..19 hit 4 (doubled 8); 20: 4 + 10 (doubled 28). No dice to double on the crit.
    expect(attack.under({ ...context, vulnerable: true }).mean()).toBeCloseTo((15 * 8 + 28) / 20, 12);
  });
});

describe("plusNatural20Damage: in a turn", () => {
  it("survives a reroll substitution: the extra is outside the base payload the substitute rerolls", () => {
    const base = d20.plus(5).ac(10).critOn(18).onHit(roll(2, 6));
    const boon = base.plusNatural20Damage(flat(5));
    const withBoon = turn([boon, boon]).onFirstHit(keepBestDamage()).mean();
    const without = turn([base, base]).onFirstHit(keepBestDamage()).mean();
    // Each attack adds 5 on its natural 20, whatever the substitute does to the base dice.
    expect(withBoon - without).toBeCloseTo(2 * (5 / 20), 12);
  });

  it("a turn of one attack is the attack", () => {
    const boon = d20.plus(5).ac(10).critOn(18).onHit(d8).plusNatural20Damage(flat(5));
    expect(turn([boon]).mean()).toBeCloseTo(boon.mean(), 12);
  });
});

describe("plusNatural20Damage: sample", () => {
  const attack = d20.plus(5).ac(10).critOn(18).onHit(d8).plusNatural20Damage(flat(10));

  it("a natural 20 deals it", () => {
    const sample = attack.sample(scripted([20, 3, 4]));
    expect(sample.outcome).toBe("crit");
    expect(sample.total).toBe(3 + 4 + 10);
  });

  it("a natural 18 crits without it", () => {
    const sample = attack.sample(scripted([18, 3, 4]));
    expect(sample.outcome).toBe("crit");
    expect(sample.total).toBe(3 + 4);
  });

  it("with advantage the kept die decides", () => {
    const advantaged = d20.withAdvantage().plus(5).ac(10).onHit(d8).plusNatural20Damage(flat(10));
    expect(advantaged.sample(scripted([2, 20, 3, 4])).total).toBe(3 + 4 + 10);
  });

  it("always-hit-always-crit rolls its d20 to see a natural 20", () => {
    const always = d20.alwaysHits().alwaysCrits().onHit(d8).plusNatural20Damage(flat(10));
    expect(always.sample(scripted([20, 3, 4])).total).toBe(3 + 4 + 10);
    expect(always.sample(scripted([19, 3, 4])).total).toBe(3 + 4);
  });
});

describe("plusNatural20Damage: refusals", () => {
  it("refuses noCrit(), in either order: a natural 20 that is no crit has no branch to ride", () => {
    const attack = d20.plus(5).ac(10).onHit(d8);
    expect(() => attack.noCrit().plusNatural20Damage(flat(10))).toThrow(/noCrit/);
    expect(() => attack.plusNatural20Damage(flat(10)).noCrit()).toThrow(/noCrit/);
  });

  it("toExpression() has no spelling for it", () => {
    expect(() => d20.plus(5).ac(10).onHit(d8).plusNatural20Damage(flat(10)).toExpression()).toThrow(/plusNatural20Damage/);
  });

  it("is part of the cache key", () => {
    const a = d20.plus(5).ac(10).onHit(d8).plusNatural20Damage(flat(10));
    const b = d20.plus(5).ac(10).onHit(d8).plusNatural20Damage(flat(11));
    expect(a.mean()).not.toBeCloseTo(b.mean(), 6);
  });
});
