import { describe, expect, it } from "vitest";
import { combine, d4, d6, flat, roll } from "../src/builder";

describe("resolve().crit is the crit payload even when no roll can crit", () => {
  it("convolves the doubled separate channels into an unreachable crit branch", () => {
    // A dieless check cannot crit, yet `crit` still describes the crit payload:
    // 4d6 + 5 base with the 2d6 channel doubled to 4d6, mean 14 + 5 + 14 = 33.
    const res = flat(15).ac(12).onHit(roll(2, d6).plus(5)).plusSeparateDamage(roll(2, d6)).resolve(0);
    expect(res.weights.crit).toBe(0);
    expect(res.critBase.mean()).toBeCloseTo(19, 12);
    expect(res.critSeparate.mean()).toBeCloseTo(14, 12);
    expect(res.crit.mean()).toBeCloseTo(33, 12);
    expect(res.pmf.mean()).toBeCloseTo(19, 12);
  });

  it("is the same when a die natural roll never reaches the crit range", () => {
    // A d4 natural roll never shows a 20.
    const res = d4.plus(20).ac(15).onHit(roll(2, d6).plus(5)).plusSeparateDamage(roll(2, d6)).resolve(0);
    expect(res.weights.crit).toBe(0);
    expect(res.crit.mean()).toBeCloseTo(33, 12);
  });
});

describe("combine(): an elven-accuracy roll type rolls three dice", () => {
  it("keeps three dice on its own or with a granted advantage", () => {
    for (const advantageDice of [2, 3] as const) {
      expect(combine("elven accuracy", advantageDice, { advantage: false, disadvantage: false })).toEqual({
        rollType: "advantage",
        dice: 3,
      });
      expect(combine("elven accuracy", advantageDice, { advantage: true, disadvantage: false })).toEqual({
        rollType: "advantage",
        dice: 3,
      });
      expect(combine("elven accuracy", advantageDice, { advantage: false, disadvantage: true })).toEqual({
        rollType: "flat",
        dice: 1,
      });
    }
  });
});
