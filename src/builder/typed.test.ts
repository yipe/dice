import { describe, expect, it } from "vitest";
import type { RowContext } from "../turn/types";
import { d20, d4, d6, d8, roll } from "./index";

const plain: RowContext = {
  rollType: "flat",
  autoHit: false,
  critOnHit: false,
  autoFail: false,
  vulnerable: false,
  penaltyDice: [],
  joined: [],
};

/** P(sum of `count` d`sides` + `modifier` > 0), by enumerating every face. */
function bruteDealt(count: number, sides: number, modifier: number): number {
  let totals = [0];
  for (let die = 0; die < count; die++) {
    totals = totals.flatMap((total) => Array.from({ length: sides }, (_, face) => total + face + 1));
  }
  return totals.filter((total) => total + modifier > 0).length / totals.length;
}

describe("AttackBuilder.typed()", () => {
  // A crit doubles the dice, not the modifier.
  it.each([
    ["2d8, never 0", d20.plus(7).ac(16).onHit(roll(2, d8)), [2, 8, 0]],
    ["d4 - 1: a hit on a 1 deals 0", d20.plus(5).ac(15).onHit(d4.minus(1)), [1, 4, -1]],
    ["d6 - 3: half the hits deal nothing", d20.plus(5).ac(15).onHit(d6.minus(3)), [1, 6, -3]],
  ] as const)("%s: dealt odds are the brute force's, in every context", (_, attack, [count, sides, modifier]) => {
    const cold = attack.typed("cold");
    const expected = { hit: bruteDealt(count, sides, modifier), crit: bruteDealt(2 * count, sides, modifier) };
    for (const context of [plain, { ...plain, rollType: "advantage" as const }, { ...plain, vulnerable: true }]) {
      const odds = cold.dealt?.("cold", context);
      expect(odds?.hit).toBeCloseTo(expected.hit, 12);
      expect(odds?.crit).toBeCloseTo(expected.crit, 12);
    }
  });

  it("another type deals nothing", () => {
    expect(d20.plus(5).ac(15).onHit(d8).typed("cold").dealt?.("fire", plain)).toEqual({ hit: 0, crit: 0 });
  });

  it("an untyped attack has no dealt, and typed() leaves the receiver and every number alone", () => {
    const sword = d20.plus(5).ac(15).onHit(d8.plus(3));
    const cold = sword.typed("cold");
    expect("dealt" in sword).toBe(false);
    expect(sword.damageType).toBeUndefined();
    expect(cold.damageType).toBe("cold");
    expect(cold.toPMF().mean()).toBe(sword.toPMF().mean());
    expect(cold.toExpression()).toBe(sword.toExpression());
  });

  it("the type survives later builder verbs", () => {
    const cold = d20.plus(5).ac(15).onHit(d8).typed("cold").onCrit(roll(3, d8)).ranged();
    expect(cold.damageType).toBe("cold");
    expect(cold.dealt?.("cold", plain)).toEqual({ hit: 1, crit: 1 });
  });

  it("refuses an empty type", () => {
    expect(() => d20.plus(5).ac(15).onHit(d8).typed("")).toThrow(TypeError);
  });
});
