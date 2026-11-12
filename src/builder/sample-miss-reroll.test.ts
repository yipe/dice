import { describe, expect, it } from "vitest";
import { d20, d4, d8 } from "./";
import type { AttackSample } from "./attack";
import type { Rng } from "../common/rng";
import { lcgRng } from "../../tests/helpers/lcg";

/** An rng that shows the given faces in order. */
const scripted = (faces: number[]): Rng => ({
  die: () => {
    const face = faces.shift();
    if (face === undefined) throw new Error("scripted rng ran out");
    return face;
  },
  chance: () => false,
});

describe("sampleMissReroll reads the check's dice by their own roll", () => {
  it("a subtracted d20 is a bonus die, not a natural face", () => {
    // Brute force /tmp/wirex/cr-sample/bf.py: hit share with the reroll, 77/200 = 0.385 (crit 0.084375).
    const attack = d20.plus(5).minus(d20).ac(10).rerollMisses().onHit(1, d8);
    const rng = lcgRng(7);
    const draws = 20_000;
    let hits = 0;
    for (let i = 0; i < draws; i++) if (attack.sample(rng).outcome === "hit") hits++;
    expect(Math.abs(hits / draws - 0.385)).toBeLessThan(0.01);
  });

  it("a bonus die with advantage counts its kept face", () => {
    const attack = d20.plus(d4.withAdvantage()).ac(15).rerollMisses().onHit(1, d8);
    // Natural 5; bonus d4 faces 1 and 4, the 4 kept: a miss at 9. Rerolled natural 11 + 4 = 15 hits (11 + 1 would miss).
    const first: AttackSample = {
      outcome: "miss",
      check: [
        { sides: 20, face: 5, kept: true },
        { sides: 4, face: 1, kept: false },
        { sides: 4, face: 4, kept: true },
      ],
      damage: [],
      total: 0,
    };
    const again = attack.sampleMissReroll(first, "add-d20", scripted([11, 6]));
    expect(again.outcome).toBe("hit");
  });
});

describe("stacked miss rerolls read the full natural-die block", () => {
  const attack = d20.plus(d4).ac(15).onHit(1, d8);
  const first = (): AttackSample => ({
    outcome: "miss",
    check: [
      { sides: 20, face: 5, kept: true },
      { sides: 4, face: 4, kept: true },
    ],
    damage: [],
    total: 0,
  });
  const keptD20s = (sample: AttackSample): number[] =>
    sample.check.filter((die) => die.sides === 20 && die.kept).map((die) => die.face);

  it("two add-d20 rerolls keep the bonus d4 as 4 and one kept d20", () => {
    const one = attack.sampleMissReroll(first(), "add-d20", scripted([6]));
    expect(one.outcome).toBe("miss");
    expect(keptD20s(one)).toEqual([6]);
    // 10 + 4 = 14 < 15: a miss (reading the 6 as a bonus would give 16, a hit).
    const two = attack.sampleMissReroll(one, "add-d20", scripted([10]));
    expect(two.outcome).toBe("miss");
    expect(keptD20s(two)).toEqual([10]);
    expect(two.check.map((die) => die.face)).toEqual([5, 6, 10, 4]);
  });

  it("a reroll then an add-d20 keeps only the d20 in play", () => {
    const one = attack.sampleMissReroll(first(), "reroll", scripted([3]));
    expect(keptD20s(one)).toEqual([3]);
    const two = attack.sampleMissReroll(one, "add-d20", scripted([2]));
    expect(two.outcome).toBe("miss");
    // The 5 the reroll dropped is not in play: the natural is max(3, 2).
    expect(keptD20s(two)).toEqual([3]);
    const three = attack.sampleMissReroll(two, "add-d20", scripted([11, 1]));
    expect(three.outcome).toBe("hit");
    expect(keptD20s(three)).toEqual([11]);
  });

  it("a miss rerolled twice lands the hit share of the exact value", () => {
    // Brute force /tmp/wirex/cr-sample2/bf.py: hit 0.7090625 after two add-d20 rerolls.
    const rng = lcgRng(11);
    const draws = 20_000;
    let hits = 0;
    for (let i = 0; i < draws; i++) {
      let sample = attack.sample(rng);
      for (let again = 0; again < 2 && sample.outcome === "miss"; again++) {
        sample = attack.sampleMissReroll(sample, "add-d20", rng);
      }
      if (sample.outcome === "hit") hits++;
    }
    expect(Math.abs(hits / draws - 0.7090625)).toBeLessThan(0.01);
  });
});

