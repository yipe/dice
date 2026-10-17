import { describe, expect, it } from "vitest";
import { d, roll } from "../src/builder/factory";
import type { Rng } from "../src/common/rng";

/** rng whose die() answers come from a queue (in order), chance() never called. */
const dice = (faces: number[]): Rng => ({
  die: (sides) => {
    const f = faces.shift();
    if (f === undefined || f > sides) throw new Error(`bad script ${f} for d${sides}`);
    return f;
  },
  chance: () => {
    throw new Error("chance() not expected");
  },
});

describe("RollBuilder.sample", () => {
  it("sums dice and flats", () => {
    const s = roll(2, 6, 3).sample(dice([4, 5]));
    expect(s.total).toBe(12);
    expect(s.dice).toEqual([
      { sides: 6, face: 4, kept: true },
      { sides: 6, face: 5, kept: true },
    ]);
  });
  it("rerolls faces at or below the threshold once and keeps the new roll", () => {
    const s = d(6).reroll(2).sample(dice([1, 2])); // 1 -> reroll -> 2, kept
    expect(s.total).toBe(2);
    expect(s.dice).toEqual([
      { sides: 6, face: 1, kept: false },
      { sides: 6, face: 2, kept: true, reroll: true },
    ]);
  });
  it("applies minimum after the reroll", () => {
    expect(d(6).minimum(3).sample(dice([1])).total).toBe(3);
  });
  it("explodes on the max face up to the cap", () => {
    const s = d(6).explode(2).sample(dice([6, 6, 6])); // cap 2 extra dice: 6+6+6 then stop
    expect(s.total).toBe(18);
    expect(s.dice).toHaveLength(3);
  });
  it("keeps the highest of advantage d20s and marks the dropped one", () => {
    const s = roll(1, 20).withAdvantage().sample(dice([7, 15]));
    expect(s.total).toBe(15);
    expect(s.dice.map((x) => x.kept)).toEqual([false, true]);
  });
  it("keepHighest keeps k of n", () => {
    const s = roll(4, 6).keepHighest(4, 3).sample(dice([1, 6, 3, 5]));
    expect(s.total).toBe(14);
    expect(s.dice.find((x) => x.face === 1)?.kept).toBe(false);
  });
  it("rerollUpTo rerolls the dice with the largest positive expected gain", () => {
    // 2d6 budget 1: faces 1 and 4 -> gain(1)=2.5, gain(4)=-0.5 -> reroll the 1 only -> new 5
    const s = roll(2, 6).rerollUpTo(1).sample(dice([1, 4, 5]));
    expect(s.total).toBe(9);
    expect(s.dice.filter((x) => x.kept)).toHaveLength(2);
  });
  it("rerollUpTo with rolls keeps the roll worth more after its own rerolls", () => {
    // Savage Attacker + budget 1 on 2d6: roll A [1,4] score = 4 + 3.5 = 7.5; roll B [2,2] -> reroll one 2: 2 + 3.5 = 5.5 ; keep A, reroll the 1 -> 6
    const s = roll(2, 6).rerollUpTo(1, { rolls: 2 }).sample(dice([1, 4, 2, 2, 6]));
    expect(s.total).toBe(10);
  });
  it("explodePool spends one budget per max face shown, chaining new max faces", () => {
    // 3d6 budget 2: [6, 2, 6] -> two pending; extra 6 (pending stays 2, budget 1); extra 3 (budget 0)
    const s = roll(3, 6).explodePool(2).sample(dice([6, 2, 6, 6, 3]));
    expect(s.total).toBe(23);
    expect(s.dice.map((x) => x.face)).toEqual([6, 2, 6, 6, 3]);
  });
  it("explodePool chains: one max face, its extra shows max again, the next spends the last budget", () => {
    // 3d6 budget 2: [6, 2, 2] -> one pending; extra 6 (pending stays 1, budget 1); extra 4 (budget 0)
    const s = roll(3, 6).explodePool(2).sample(dice([6, 2, 2, 6, 4]));
    expect(s.total).toBe(20);
    expect(s.dice.map((x) => x.face)).toEqual([6, 2, 2, 6, 4]);
  });
  it("rerollUpTo draws and lists dice in source order, not mean order", () => {
    // 2d6 + d8, budget 1: d6 shows 1 (gain 2.5), d8 shows 2 (gain 2.5): tie goes to the higher-mean kind (d8)
    const s = roll(2, 6).plus(1, d(8)).rerollUpTo(1).sample(dice([1, 4, 2, 7]));
    expect(s.dice.map((x) => x.sides)).toEqual([6, 6, 8, 8]);
    expect(s.dice.map((x) => x.kept)).toEqual([true, true, false, true]);
    expect(s.total).toBe(12);
  });
  it("half floors the child's total and keeps its dice", () => {
    const s = roll(2, 8).half().sample(dice([3, 4]));
    expect(s.total).toBe(3);
    expect(s.dice).toHaveLength(2);
  });
  it("a parsed string draws from its PMF with no dice", () => {
    const rng: Rng = { die: () => { throw new Error("die() not expected"); }, chance: () => true };
    expect(d("2d6+1").sample(rng)).toEqual({ total: 3, dice: [] });
  });
  it("matches the PMF mean over many seeded draws", () => {
    let st = 7;
    const rng: Rng = {
      die: (n) => {
        st = (Math.imul(st, 1664525) + 1013904223) >>> 0;
        return (st % n) + 1;
      },
      chance: () => false,
    };
    const b = roll(3, 8).reroll(1).minimum(2).plus(2);
    let sum = 0;
    const N = 40000;
    for (let i = 0; i < N; i++) sum += b.sample(rng).total;
    expect(sum / N).toBeCloseTo(b.pmf.mean(), 0);
  });
});
