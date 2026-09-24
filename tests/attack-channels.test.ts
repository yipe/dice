import { describe, expect, it } from "vitest";
import { d20, d4, d6, d8, d10, d12, roll } from "../src/builder/factory";
import "../src/builder/ac";
import type { AttackBuilder } from "../src/builder/attack";
import { combine } from "../src/builder/ac";
import type { PMF } from "../src/pmf/pmf";

function expectSamePMF(actual: PMF, expected: PMF): void {
  const support = new Set([...actual.support(), ...expected.support()]);
  for (const value of support) {
    expect(actual.pAt(value), `bin ${value}`).toBeCloseTo(expected.pAt(value), 10);
  }
}

describe("AttackBuilder.plusSeparateDamage (R14, S1 step 2)", () => {
  it("equals the folded expression bin for bin, hit and crit — before any substitution reads the channel", () => {
    const split = d20.plus(9).ac(16).onHit(roll(2, d6).plus(5)).plusSeparateDamage(roll(2, d6));
    const folded = d20.plus(9).ac(16).onHit(roll(2, d6).plus(5).plus(2, d6));

    const splitRes = split.resolve();
    const foldedRes = folded.resolve();
    expectSamePMF(splitRes.hit, foldedRes.hit);
    expectSamePMF(splitRes.crit, foldedRes.crit);
    expect(splitRes.hit.mean()).toBeCloseTo(19, 10); // O10 "plain"
    expect(splitRes.crit.mean()).toBeCloseTo(33, 10);
  });

  it("accumulates across several calls, convolving every channel in", () => {
    const twoChannels = d20
      .plus(9)
      .ac(16)
      .onHit(roll(2, d6).plus(5))
      .plusSeparateDamage(roll(1, d6))
      .plusSeparateDamage(roll(1, d6));
    const oneChannel = d20.plus(9).ac(16).onHit(roll(2, d6).plus(5)).plusSeparateDamage(roll(2, d6));
    expectSamePMF(twoChannels.resolve().hit, oneChannel.resolve().hit);
  });

  it("doubles under an explicit onCrit too — the override describes only the base payload (R14)", () => {
    const attack = d20
      .plus(9)
      .ac(16)
      .onHit(roll(2, d6).plus(5))
      .onCrit(roll(1, d6))
      .plusSeparateDamage(roll(2, d6));
    const res = attack.resolve();
    expect(res.critBase.mean()).toBeCloseTo(3.5, 10); // the explicit 1d6, untouched
    expect(res.crit.mean()).toBeCloseTo(17.5, 10); // 3.5 + doubled 2d6 channel (mean 14)
  });

  it("is excluded from the dice-match descriptor: only the base pool counts toward a match (R14)", () => {
    const withChannel = d20.plus(9).ac(16).onHit(roll(2, d6).plus(5)).plusSeparateDamage(roll(2, d6));
    const baseOnly = d20.plus(9).ac(16).onHit(roll(2, d6).plus(5));
    const withInfo = withChannel.diceMatchInfo();
    const baseInfo = baseOnly.diceMatchInfo();
    expect(withInfo.hit).not.toBeNull();
    for (const [damage, p] of baseInfo.hit!.matchProbabilityByDamage) {
      expect(withInfo.hit!.matchProbabilityByDamage.get(damage)).toBeCloseTo(p, 12);
    }
  });

  it("hitBase/critBase equal hit/crit exactly when there are no channels", () => {
    const attack = d20.plus(9).ac(16).onHit(2, d6, 5);
    const res = attack.resolve();
    expectSamePMF(res.hit, res.hitBase);
    expectSamePMF(res.crit, res.critBase);
  });
});

describe("AttackBuilder.resolve() hitSeparate/critSeparate (S1b amendment)", () => {
  it("hit/crit equal hitBase/critBase convolved with hitSeparate/critSeparate — auto-double crit, one and two channels", () => {
    for (const channels of [[roll(2, d6)], [roll(1, d6), roll(1, d6)]]) {
      let attack = d20.plus(9).ac(16).onHit(roll(2, d6).plus(5));
      for (const ch of channels) attack = attack.plusSeparateDamage(ch);
      const res = attack.resolve();
      expectSamePMF(res.hit, res.hitBase.convolve(res.hitSeparate));
      expectSamePMF(res.crit, res.critBase.convolve(res.critSeparate));
    }
  });

  it("hit/crit equal hitBase/critBase convolved with hitSeparate/critSeparate — explicit onCrit path", () => {
    for (const channels of [[roll(2, d6)], [roll(1, d6), roll(1, d6)]]) {
      let attack = d20.plus(9).ac(16).onHit(roll(2, d6).plus(5)).onCrit(roll(1, d6));
      for (const ch of channels) attack = attack.plusSeparateDamage(ch);
      const res = attack.resolve();
      expectSamePMF(res.hit, res.hitBase.convolve(res.hitSeparate));
      expectSamePMF(res.crit, res.critBase.convolve(res.critSeparate));
    }
  });

  it("hitSeparate/critSeparate are delta(0) mass 1 with no channels, hit/crit unchanged", () => {
    const attack = d20.plus(9).ac(16).onHit(roll(2, d6).plus(5));
    const res = attack.resolve();
    expect(res.hitSeparate.mass()).toBeCloseTo(1, 12);
    expect(res.hitSeparate.pAt(0)).toBeCloseTo(1, 12);
    expect(res.critSeparate.mass()).toBeCloseTo(1, 12);
    expect(res.critSeparate.pAt(0)).toBeCloseTo(1, 12);
    expectSamePMF(res.hit, res.hitBase);
    expectSamePMF(res.crit, res.critBase);
  });

  it("O10 payload level: hitBase.maxOfTwo() convolved with hitSeparate is 20.3719/34.9334, not hit.maxOfTwo()'s 20.9334/35.7296", () => {
    const attack = d20.plus(9).ac(16).onHit(roll(2, d6).plus(5)).plusSeparateDamage(roll(2, d6));
    const res = attack.resolve();
    const correctHit = res.hitBase.maxOfTwo().convolve(res.hitSeparate);
    const correctCrit = res.critBase.maxOfTwo().convolve(res.critSeparate);
    const wrongHit = res.hit.maxOfTwo();
    const wrongCrit = res.crit.maxOfTwo();
    expect(correctHit.mean()).toBeCloseTo(20.3719, 4);
    expect(correctCrit.mean()).toBeCloseTo(34.9334, 4);
    expect(wrongHit.mean()).toBeCloseTo(20.9334, 4);
    expect(wrongCrit.mean()).toBeCloseTo(35.7296, 4);
    expect(correctHit.mean()).not.toBeCloseTo(wrongHit.mean(), 4);
    expect(correctCrit.mean()).not.toBeCloseTo(wrongCrit.mean(), 4);
  });
});

describe("AttackBuilder.rerollDamage / minimumDamageDie (R16, R24, S1 steps 2/8)", () => {
  it("O1: covers every base die group, not just the last one chained", () => {
    const attack = d20.plus(5).ac(15).onHit(roll(1, d8).plus(2, d6)).rerollDamage(1);
    expect(attack.resolve().hitBase.mean()).toBeCloseTo(12.7708, 4);
    // Not the last-group-only binding (roll(1,d8).plus(2,d6).reroll(1) on the low-level chain).
    expect(attack.resolve().hitBase.mean()).not.toBeCloseTo(12.3333, 4);
  });

  it("is a permission cap (R24): monotone non-decreasing in k, peaking at floor(sides/2)", () => {
    const cases: Array<[typeof d4, number, number]> = [
      [d4, 4, 2],
      [d6, 6, 3],
      [d8, 8, 4],
      [d10, 10, 5],
      [d12, 12, 6],
    ];
    for (const [die, sides, peak] of cases) {
      const means: number[] = [];
      for (let k = 1; k <= sides; k++) {
        means.push(d20.plus(5).ac(15).onHit(roll(2, die)).rerollDamage(k).resolve().hitBase.mean());
      }
      for (let k = 1; k < means.length; k++) {
        expect(means[k], `${die === d6 ? "d6" : "die"} k=${k + 1} vs k=${k}`).toBeGreaterThanOrEqual(
          means[k - 1] - 1e-9
        );
      }
      // Plateaus at (and never exceeds) the value at the permission cap.
      expect(means[peak - 1]).toBeCloseTo(means[sides - 1], 6);
    }
  });

  it("rerollDamage(2) on a d6 still equals reroll(2) — a threshold of 2 is unchanged by the cap", () => {
    const viaAttack = d20.plus(5).ac(15).onHit(roll(2, d6)).rerollDamage(2);
    const direct = d20.plus(5).ac(15).onHit(roll(2, d6).reroll(2));
    expectSamePMF(viaAttack.resolve().hitBase, direct.resolve().hitBase);
  });

  it("rerollDamage(5) on a d6 clamps to reroll(3) — 8.5000 for 2d6, not 7.8333, bin for bin hit and crit", () => {
    const attack = d20.plus(5).ac(15).onHit(roll(2, d6)).rerollDamage(5);
    const direct = d20.plus(5).ac(15).onHit(roll(2, d6).reroll(3));
    const resolved = attack.resolve();
    const directResolved = direct.resolve();
    expectSamePMF(resolved.hitBase, directResolved.hitBase);
    expectSamePMF(resolved.critBase, directResolved.critBase);
    expect(resolved.hitBase.mean()).toBeCloseTo(8.5, 4);
    expect(resolved.hitBase.mean()).not.toBeCloseTo(7.8333, 4);
  });

  it("RollBuilder.reroll(5) stays an uncapped obligation — 7.8333 for 2d6", () => {
    const attack = d20.plus(5).ac(15).onHit(roll(2, d6).reroll(5));
    expect(attack.resolve().hitBase.mean()).toBeCloseTo(7.8333, 4);
  });

  it("conflicting rerollDamage() thresholds throw a plain Error; the same value twice is a no-op", () => {
    try {
      void d20.plus(5).ac(15).onHit(roll(2, d6)).rerollDamage(1).rerollDamage(3);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).constructor).toBe(Error);
      expect((e as Error).message).toMatch(/Conflicting rerollDamage/);
    }
    const noop = d20.plus(5).ac(15).onHit(roll(2, d6)).rerollDamage(2).rerollDamage(2);
    expect(noop.resolve().hitBase.mean()).toBeCloseTo(8.3333, 4);
  });

  it("R23: the numbers the conflicting-rerollDamage guard prevents — silent last-wins on the low-level RollBuilder chain", () => {
    expect(roll(2, d6).reroll(1).reroll(3).toPMF().mean()).toBeCloseTo(8.5, 4);
    expect(roll(2, d6).reroll(3).reroll(1).toPMF().mean()).toBeCloseTo(7.8333, 4);
  });

  it("conflicting minimumDamageDie() values throw a plain Error; the same value twice is a no-op", () => {
    try {
      void d20.plus(5).ac(15).onHit(roll(2, d6)).minimumDamageDie(3).minimumDamageDie(4);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).constructor).toBe(Error);
      expect((e as Error).message).toMatch(/Conflicting minimumDamageDie/);
    }
    const noop = d20.plus(5).ac(15).onHit(roll(2, d6)).minimumDamageDie(3).minimumDamageDie(3);
    expect(noop.resolve().hitBase.mean()).toBeCloseTo(8, 10);
  });

  it("order independence: dice-then-fighting-style equals fighting-style-then-dice (R16)", () => {
    const a: AttackBuilder = d20
      .plus(9)
      .ac(16)
      .onHit(roll(2, d6).reroll(2).plus(5))
      .plusSeparateDamage(roll(2, d6));
    const b: AttackBuilder = d20
      .plus(9)
      .ac(16)
      .onHit(roll(2, d6).plus(5))
      .plusSeparateDamage(roll(2, d6))
      .rerollDamage(2);

    expectSamePMF(a.resolve().hit, b.resolve().hit);
    expectSamePMF(a.resolve().crit, b.resolve().crit);
  });

  it("refuses (rather than silently no-oping) a payload with no dice descriptor", () => {
    const parsed = d20.plus(9).ac(16).onHit("2d6+5");
    expect(() => parsed.rerollDamage(2)).toThrow(/dice descriptor/);
    expect(() => parsed.minimumDamageDie(3)).toThrow(/dice descriptor/);
  });

  it("an explicit onCrit gets the same transforms whether it is set before or after them", () => {
    const critBefore = d20
      .plus(5)
      .ac(15)
      .onHit(roll(2, d6))
      .onCrit(roll(4, d6))
      .rerollDamage(2)
      .minimumDamageDie(2);
    const critAfter = d20
      .plus(5)
      .ac(15)
      .onHit(roll(2, d6))
      .rerollDamage(2)
      .minimumDamageDie(2)
      .onCrit(roll(4, d6));
    expectSamePMF(critAfter.resolve().critBase, critBefore.resolve().critBase);
    // 4d6 untransformed is 14; the rerolled-and-floored crit is higher.
    expect(critAfter.resolve().critBase.mean()).toBeGreaterThan(14.5);
  });

  it("an explicit onCrit with no dice descriptor is refused once a transform is set", () => {
    const attack = d20.plus(9).ac(16).onHit(roll(2, d6).plus(5)).rerollDamage(2);
    expect(() => attack.onCrit("4d6+5")).toThrow(/dice descriptor/);
  });
});

describe("AttackBuilder.halfOnMiss (R28, S1 step 4c)", () => {
  it("miss payload is floor(resolved hit payload / 2) — base plus every separate channel, never crit", () => {
    const attack = d20.plus(9).ac(16).onHit(roll(2, d6).plus(5)).plusSeparateDamage(roll(2, d6)).halfOnMiss();
    const res = attack.resolve();
    const directFloor = d20
      .plus(9)
      .ac(16)
      .onHit(roll(4, d6).plus(5))
      .resolve()
      .hit.scaleDamage(0.5, "floor");
    expectSamePMF(res.miss, directFloor);
    expect(res.miss.mean()).not.toBeCloseTo(res.crit.mean() / 2, 2); // never the crit payload
  });

  it("labels the miss branch missDamage, and leaves hit/crit weights untouched", () => {
    const plain = d20.plus(9).ac(16).onHit(2, d6, 5);
    const half = plain.halfOnMiss();
    expect(plain.resolve().weights).toEqual(half.resolve().weights);
    expect(half.resolve().pmf.filterOutcome("missDamage").mass()).toBeCloseTo(0.3, 10);
    expect(half.resolve().pmf.filterOutcome("missNone").mass()).toBe(0);
  });

  it("halfOnMiss() and onMiss() refuse to combine, in either order, throwing a plain Error", () => {
    try {
      void d20.plus(5).ac(15).onHit(2, d6, 5).halfOnMiss().onMiss(3);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).constructor).toBe(Error);
    }
    try {
      void d20.plus(5).ac(15).onHit(2, d6, 5).onMiss(3).halfOnMiss();
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).constructor).toBe(Error);
    }
  });
});

describe("AttackBuilder.toExpression refuses what the grammar cannot express", () => {
  it("throws for a plusSeparateDamage channel or halfOnMiss instead of dropping it", () => {
    const plain = d20.plus(9).ac(16).onHit(roll(2, d6).plus(5));
    expect(plain.toExpression()).toBe("(d20 + 9 AC 16) * (2d6 + 5) crit (4d6 + 5)");
    expect(() => plain.plusSeparateDamage(roll(2, d6)).toExpression()).toThrow(/plusSeparateDamage/);
    expect(() => plain.halfOnMiss().toExpression()).toThrow(/halfOnMiss/);
  });
});

describe("AttackBuilder.withCheck (R30, S1 step 4c)", () => {
  it("re-deriving advantage equals building the same attack with withAdvantage() before .ac(), bin for bin", () => {
    const viaWithCheck = d20
      .plus(5)
      .ac(15)
      .onHit(1, d8, 3)
      .withCheck((c) => ({ ...c, rollType: "advantage" }));
    const direct = d20.withAdvantage().plus(5).ac(15).onHit(1, d8, 3);

    expectSamePMF(viaWithCheck.resolve().hit, direct.resolve().hit);
    expectSamePMF(viaWithCheck.resolve().crit, direct.resolve().crit);
    expect(viaWithCheck.resolve().weights).toEqual(direct.resolve().weights);
  });

  it("critOnHit delegates to the alwaysCrits() path, and round-trips back to the original", () => {
    const attack = d20.plus(9).ac(16).onHit(2, d6, 5);
    const viaCritOnHit = attack.withCheck((c) => ({ ...c, critOnHit: true }));
    const viaAlwaysCrits = d20.plus(9).ac(16).alwaysCrits().onHit(2, d6, 5);
    expect(viaCritOnHit.resolve().weights).toEqual(viaAlwaysCrits.resolve().weights);

    const roundTrip = viaCritOnHit.withCheck((c) => ({ ...c, critOnHit: false }));
    expect(roundTrip.resolve().weights).toEqual(attack.resolve().weights);
  });

  it("throws when the check has no AC to rebind (an always-hit source)", () => {
    const alwaysHit = d6.alwaysHits().onHit(1, d4);
    expect(() => alwaysHit.withCheck((c) => ({ ...c, rollType: "advantage" }))).toThrow(/AC/);
  });
});

describe("ACBuilder.threeDiceAdvantage / combine (R30, S6 step 1)", () => {
  it("is numerically unchanged from the legacy withElvenAccuracy() path, bin for bin", () => {
    // The S6 card specifies d20+5 vs AC 12; AC 15 stays too, for the crit-band coverage.
    for (const ac of [12, 15]) {
      const legacy = d20.withElvenAccuracy().plus(5).ac(ac).onHit(1, d8, 3);
      const viaThreeDice = d20
        .plus(5)
        .ac(ac)
        .threeDiceAdvantage()
        .onHit(1, d8, 3)
        .withCheck((c) => ({ ...c, rollType: "advantage" }));
      expect(viaThreeDice.resolve().weights).toEqual(legacy.resolve().weights);
      expectSamePMF(viaThreeDice.resolve().hit, legacy.resolve().hit);
      expectSamePMF(viaThreeDice.resolve().crit, legacy.resolve().crit);
    }
  });

  it("ACBuilder.copy(ac) rebinds the AC; copy() with no argument reuses the current one", () => {
    const base = d20.plus(9).ac(16).threeDiceAdvantage();
    const rebound = base.copy(20);
    expect(rebound.attackConfig.ac).toBe(20);
    expect(rebound.attackConfig.advantageDice).toBe(3);
    const same = base.copy();
    expect(same.attackConfig.ac).toBe(16);
  });

  it("O30, payload level: a granted advantage rolls 3 dice when advantageDice is 3, 2 otherwise", () => {
    const grantedThree = d20
      .plus(5)
      .ac(12)
      .threeDiceAdvantage()
      .onHit(1)
      .withCheck((c) => ({ ...c, rollType: "advantage" }));
    const grantedTwo = d20
      .plus(5)
      .ac(12)
      .onHit(1)
      .withCheck((c) => ({ ...c, rollType: "advantage" }));
    const landThree = grantedThree.resolve().weights;
    const landTwo = grantedTwo.resolve().weights;
    expect(landThree.hit + landThree.crit).toBeCloseTo(0.973, 6);
    expect(landTwo.hit + landTwo.crit).toBeCloseTo(0.91, 6);
  });

  it("combine(): the full R30 cancellation table across rollType × advantageDice × grant flags", () => {
    const none = { advantage: false, disadvantage: false };
    const adv = { advantage: true, disadvantage: false };
    const dis = { advantage: false, disadvantage: true };
    const both = { advantage: true, disadvantage: true };

    for (const advantageDice of [2, 3] as const) {
      expect(combine("flat", advantageDice, none)).toEqual({ rollType: "flat", dice: 1 });
      expect(combine("flat", advantageDice, adv)).toEqual({ rollType: "advantage", dice: advantageDice });
      expect(combine("flat", advantageDice, dis)).toEqual({ rollType: "disadvantage", dice: 2 });
      expect(combine("flat", advantageDice, both)).toEqual({ rollType: "flat", dice: 1 });

      expect(combine("advantage", advantageDice, none)).toEqual({
        rollType: "advantage",
        dice: advantageDice,
      });
      expect(combine("advantage", advantageDice, adv)).toEqual({
        rollType: "advantage",
        dice: advantageDice,
      });
      expect(combine("advantage", advantageDice, dis)).toEqual({ rollType: "flat", dice: 1 });
      expect(combine("advantage", advantageDice, both)).toEqual({ rollType: "flat", dice: 1 });

      expect(combine("disadvantage", advantageDice, none)).toEqual({
        rollType: "disadvantage",
        dice: 2,
      });
      expect(combine("disadvantage", advantageDice, adv)).toEqual({ rollType: "flat", dice: 1 });
      expect(combine("disadvantage", advantageDice, dis)).toEqual({
        rollType: "disadvantage",
        dice: 2,
      });
      expect(combine("disadvantage", advantageDice, both)).toEqual({ rollType: "flat", dice: 1 });
    }
  });
});

describe("AttackBuilder resolve() cache key correctness", () => {
  it("does not collide two attacks differing only by a plusSeparateDamage channel", () => {
    const base = d20.plus(9).ac(16).onHit(roll(2, d6).plus(5));
    const withExtra = base.plusSeparateDamage(roll(2, d6));
    expect(base.toPMF().mean()).toBeCloseTo(8.75, 10);
    expect(withExtra.toPMF().mean()).toBeCloseTo(14, 10);
    // Repeat to exercise the cached path.
    expect(base.toPMF().mean()).toBeCloseTo(8.75, 10);
    expect(withExtra.toPMF().mean()).toBeCloseTo(14, 10);
  });

  it("does not collide two attacks differing only by halfOnMiss", () => {
    const plain = d20.plus(9).ac(16).onHit(roll(2, d6).plus(5));
    const withHalf = plain.halfOnMiss();
    expect(plain.toPMF().mean()).toBeCloseTo(8.75, 10);
    expect(withHalf.toPMF().mean()).toBeCloseTo(10.475, 10);
  });
});
