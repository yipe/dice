import { describe, expect, it } from "vitest";
import { d20, d8, type AttackBuilder } from "./";
import type { AttackSample } from "./attack";
import type { MissRerollMode } from "./types";
import { lcgRng } from "../../tests/helpers/lcg";

/** A flat d20 vs AC 15 that rolled a 8 and missed. */
const missedEight = (): AttackSample => ({
  outcome: "miss",
  check: [{ sides: 20, face: 8, kept: true }],
  damage: [],
  total: 0
});

const attackOf = (mode: MissRerollMode): AttackBuilder => d20.ac(15).rerollMisses(mode).onHit(1, d8);

/** The first seed whose replacement d20 shows `face`. */
const seedFor = (face: number, mode: MissRerollMode): number => {
  for (let seed = 1; seed < 10_000; seed++) {
    if (attackOf(mode).sampleMissReroll(missedEight(), mode, lcgRng(seed)).check[1].face === face) return seed;
  }
  throw new Error(`no seed rolls a ${face}`);
};

describe("sampleMissReroll natural and kept die", () => {
  it("flat reroll: a missed 8 that rerolls to 2 reports natural 2 with the replacement kept", () => {
    const sample = attackOf("reroll").sampleMissReroll(missedEight(), "reroll", lcgRng(seedFor(2, "reroll")));
    expect(sample.outcome).toBe("miss");
    expect(sample.check.map((die) => die.face)).toEqual([8, 2]);
    expect(sample.check.map((die) => die.kept)).toEqual([false, true]);
  });

  it("flat reroll: the reported natural is the replacement d20 for every seed", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const sample = attackOf("reroll").sampleMissReroll(missedEight(), "reroll", lcgRng(seed));
      const replacement = sample.check[1].face;
      expect(sample.check.map((die) => die.kept)).toEqual([false, true]);
      // 15 is the lowest face that hits AC 15 with no modifier; 1 always misses and 20 always crits.
      expect(sample.outcome).toBe(replacement === 20 ? "crit" : replacement >= 15 ? "hit" : "miss");
    }
  });

  it("add-d20: the best of both d20s is the natural, as before", () => {
    const sample = attackOf("add-d20").sampleMissReroll(missedEight(), "add-d20", lcgRng(seedFor(2, "add-d20")));
    expect(sample.check.map((die) => die.face)).toEqual([8, 2]);
    expect(sample.check.map((die) => die.kept)).toEqual([true, false]);
  });
});
