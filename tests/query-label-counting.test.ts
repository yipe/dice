import { describe, expect, it } from "vitest";
import type { Bin } from "../src/index";
import { DiceQuery, PMF } from "../src/index";

function pmfOf(bins: Array<[number, Bin]>): PMF {
  return new PMF(new Map(bins), 0);
}

/** One attack: P(hit) = 1/2 for 6 damage, otherwise a clean miss. */
const halfHit = () =>
  pmfOf([
    [0, { p: 1 / 2, count: { missNone: 1 / 2 } }],
    [6, { p: 1 / 2, count: { hit: 1 / 2 } }],
  ]);

/** d20+5 vs AC 15: miss 9/20, hit 10/20, crit 1/20. */
const swing = () =>
  pmfOf([
    [0, { p: 9 / 20, count: { missNone: 9 / 20 } }],
    [5, { p: 10 / 20, count: { hit: 10 / 20 } }],
    [10, { p: 1 / 20, count: { crit: 1 / 20 } }],
  ]);

describe("DiceQuery label counting", () => {
  it("a repeated label is one event, not two", () => {
    const q = new DiceQuery([halfHit(), halfHit()]);
    expect(q.probAtLeastOne(["hit", "hit"])).toBeCloseTo(3 / 4, 15);
    expect(q.probExactlyK(["hit", "hit"], 1)).toBeCloseTo(1 / 2, 15);
    expect(q.probAtMostK(["hit", "hit"], 0)).toBeCloseTo(1 / 4, 15);
    expect(q.probAtLeastK(["hit", "hit"], 1)).toBeCloseTo(3 / 4, 15);
  });

  it("a negative count has probability 0", () => {
    const q = new DiceQuery([halfHit(), halfHit()]);
    expect(q.probExactlyK("hit", -1)).toBe(0);
    expect(q.probExactlyK(["hit", "crit"], -1)).toBe(0);
    expect(q.probAtMostK("hit", -1)).toBe(0);
  });

  it("missChance is P(at least one attack misses); all-miss is probExactlyK over misses", () => {
    const q = new DiceQuery([swing(), swing()]);
    expect(q.missChance()).toBeCloseTo(279 / 400, 15);
    expect(q.probExactlyK(["missNone", "missDamage"], 2)).toBeCloseTo(81 / 400, 15);
    expect(q.probAtMostK(["hit", "crit"], 0)).toBeCloseTo(81 / 400, 15);
  });

  it("expectedDamageFrom normalizes a non-unit single the way mean() does", () => {
    const slice = pmfOf([
      [0, { p: 1 / 4, count: { missNone: 1 / 4 } }],
      [8, { p: 1 / 4, count: { hit: 1 / 4 } }],
    ]);
    const q = new DiceQuery([slice]);
    expect(q.mean()).toBeCloseTo(4, 15);
    expect(q.expectedDamageFrom("hit")).toBeCloseTo(4, 15);
    expect(q.expectedDamageFrom(["hit", "missNone"])).toBeCloseTo(q.mean(), 15);
  });
});
