import { describe, expect, it } from "vitest";
import { d10, d12, d20, d4, d6, d8, roll, RollBuilder, RerollUpToRollBuilder } from "../src/builder";
import type { Rng } from "../src/common/rng";
import { PMF } from "../src/pmf/pmf";
import { expectDist, type Dist } from "./enumerate-dice";
import { bruteForcePartialRerollUpTo, ruleDie, type OracleDie } from "./enumerate-reroll";

/**
 * `rerollUpTo(k, { rolls, rolledOnce })`: the roll's own dice are rolled `rolls` times and the
 * `rolledOnce` dice once (Savage Attacker rolls only the weapon's dice twice); the roller keeps
 * one roll of the weapon dice, then rerolls up to k dice among it and the once-rolled dice and
 * keeps the new rolls (Piercer). Every distribution is checked against
 * `bruteForcePartialRerollUpTo`, which lists every roll of every die and tries every roll choice
 * with every subset of dice to reroll.
 */

const dice = (sides: number, count = 1): OracleDie[] => Array.from({ length: count }, () => ruleDie(sides));

function distOf(pmf: PMF): Dist {
  return new Map(pmf.support().map((value) => [value, pmf.pAt(value)]));
}

function shifted(dist: Dist, by: number): Dist {
  return new Map([...dist].map(([value, p]) => [value + by, p]));
}

describe("rerollUpTo with rolledOnce: oracle", () => {
  it("1d8+3 rapier rolled twice, 1d10 fire once, one Piercer reroll: mean exactly 3 + 8170/640", () => {
    // 8 x 8 x 10 = 640 equally likely (first d8, second d8, d10) rolls. For each, the d8 kept is
    // the one worth more after the reroll: score(w) = w + r + max(0, 4.5 - w, 5.5 - r). Then the
    // die with the larger positive gain (4.5 - w or 5.5 - r; the d10 on a tie) is rerolled to its
    // mean. Summing those expected totals over the 640 rolls gives 8170, so the mean is
    // 3 + 8170/640 = 15.765625, above the 15.5625 of the best whole-pool play.
    const pool = roll(1, d8).plus(3).rerollUpTo(1, { rolls: 2, rolledOnce: roll(1, d10) });
    const pmf = pool.toPMF();
    expect(pmf.mean()).toBeCloseTo(3 + 8170 / 640, 12);
    expectDist(pmf, shifted(bruteForcePartialRerollUpTo(dice(8), dice(10), 1, 2), 3));
    // The hand sum, enumerated: the same 8170.
    let sum = 0;
    for (let a = 1; a <= 8; a++) {
      for (let b = 1; b <= 8; b++) {
        for (let r = 1; r <= 10; r++) {
          const score = (w: number) => w + r + Math.max(0, 4.5 - w, 5.5 - r);
          const w = score(a) >= score(b) ? a : b;
          sum += score(w);
        }
      }
    }
    expect(sum).toBe(8170);
  });

  const cases: [string, OracleDie[], OracleDie[], RollBuilder, RollBuilder, number, number][] = [
    ["2d6 twice, 1d6 once (one kind across both), budget 1", dice(6, 2), dice(6), roll(2, d6), roll(1, d6), 1, 2],
    ["1d12 twice, 2d4 + 1d6 once, budget 2", dice(12), [...dice(4, 2), ...dice(6)], roll(1, d12), roll(2, d4).plus(d6), 2, 2],
    ["1d8 three times, 1d10 once, budget 1", dice(8), dice(10), roll(1, d8), roll(1, d10), 1, 3],
    ["2d8 twice, 2d10 once (a crit's dice), budget 1", dice(8, 2), dice(10, 2), roll(2, d8), roll(2, d10), 1, 2],
    ["1d8 twice, 1d10 once, no budget: the better d8 plus the d10", dice(8), dice(10), roll(1, d8), roll(1, d10), 0, 2],
    ["1d6 twice, 1d4 subtracted once, budget 1", dice(6), [ruleDie(4, { negate: true })], roll(1, d6), roll(0).minus(d4), 1, 2],
  ];
  for (const [name, repeated, once, repeatedRoll, onceRoll, budget, rolls] of cases) {
    it(name, () => {
      expectDist(
        repeatedRoll.rerollUpTo(budget, { rolls, rolledOnce: onceRoll }).toPMF(),
        bruteForcePartialRerollUpTo(repeated, once, budget, rolls)
      );
    });
  }

  it("with one roll it is the plain pool of both", () => {
    expectDist(
      roll(1, d8).rerollUpTo(1, { rolledOnce: roll(1, d10) }).toPMF(),
      distOf(roll(1, d8).plus(d10).rerollUpTo(1).toPMF())
    );
  });

  it("with no reroll budget it is the best of the rolled-twice dice plus the rest", () => {
    expectDist(
      roll(2, d6).rerollUpTo(0, { rolls: 2, rolledOnce: roll(1, d10) }).toPMF(),
      distOf(roll(2, d6).maxOf(2).toPMF().convolve(roll(1, d10).toPMF()))
    );
  });

  it("lies between rolling the whole pool twice and the weapon's best of two with no reroll", () => {
    const partial = roll(1, d8).rerollUpTo(1, { rolls: 2, rolledOnce: roll(1, d10) }).toPMF().mean();
    // Rolling the d10 twice too would be worth more; rolling only the d8 twice, with no reroll, less.
    expect(roll(1, d8).plus(d10).rerollUpTo(1, { rolls: 2 }).toPMF().mean()).toBeGreaterThan(partial);
    expect(roll(1, d8).maxOf(2).plus(d10).toPMF().mean()).toBeLessThan(partial);
  });
});

describe("rerollUpTo with rolledOnce: builder", () => {
  it("flats on either side never reroll", () => {
    expectDist(
      roll(1, d8).plus(3).rerollUpTo(1, { rolls: 2, rolledOnce: roll(1, d10).plus(2) }).toPMF(),
      shifted(bruteForcePartialRerollUpTo(dice(8), dice(10), 1, 2), 5)
    );
  });

  it("doubles both sides' dice on a crit and keeps the budget and rolls", () => {
    const doubled = roll(1, d8).rerollUpTo(1, { rolls: 2, rolledOnce: roll(1, d10) }).doubleDice();
    expect(doubled).toBeInstanceOf(RerollUpToRollBuilder);
    expectDist(doubled.toPMF(), bruteForcePartialRerollUpTo(dice(8, 2), dice(10, 2), 1, 2));
  });

  it("as an attack's payload, the crit doubles both sides", () => {
    const payload = roll(1, d8).plus(3).rerollUpTo(1, { rolls: 2, rolledOnce: roll(1, d10) });
    const resolved = d20.plus(5).ac(10).onHit(payload).resolve();
    expectDist(resolved.critBase, shifted(bruteForcePartialRerollUpTo(dice(8, 2), dice(10, 2), 1, 2), 3));
  });

  it("copy() keeps the rolled-once dice", () => {
    const pooled = roll(1, d8).rerollUpTo(1, { rolls: 2, rolledOnce: roll(1, d10) });
    expectDist(pooled.copy().toPMF(), distOf(pooled.toPMF()));
  });

  it("lists every die of both sides in its configs", () => {
    const pooled = roll(1, d8).rerollUpTo(1, { rolls: 2, rolledOnce: roll(1, d10) });
    expect(pooled.getSubRollConfigs().map((c) => c.sides)).toEqual([8, 10]);
  });

  it("refuses rolled-once dice that are not plain dice", () => {
    expect(() => roll(1, d8).rerollUpTo(1, { rolls: 2, rolledOnce: d20.withAdvantage() })).toThrow(/plain dice/);
    expect(() => roll(1, d8).rerollUpTo(1, { rolls: 2, rolledOnce: roll(1, d10).rerollUpTo(1) })).toThrow(/rolledOnce/);
  });

  it("toExpression() has no spelling", () => {
    expect(() => roll(1, d8).rerollUpTo(1, { rolls: 2, rolledOnce: roll(1, d10) }).toExpression()).toThrow(/rerollUpTo/);
  });

  it("a dice-match trigger refuses it rather than guessing", () => {
    const attack = d20.plus(5).ac(10).onHit(roll(2, d8).rerollUpTo(1, { rolls: 2, rolledOnce: roll(1, d8) }));
    expect(attack.diceMatchRefusals().hit).toMatch(/rolled once/);
  });
});

describe("rerollUpTo with rolledOnce: sample", () => {
  const scripted = (faces: number[]): Rng => ({
    die: () => {
      if (faces.length === 0) throw new Error("no faces left");
      return faces.shift()!;
    },
    chance: () => {
      throw new Error("no coins");
    },
  });

  it("keeps the better d8 roll, then rerolls the die worth the most", () => {
    const pool = roll(1, d8).rerollUpTo(1, { rolls: 2, rolledOnce: roll(1, d10) });
    // d8 rolls 2 and 6, d10 shows 1. Keep 6 (score 6 + 1 + 4.5 against 2 + 1 + 4.5), reroll the d10: 7.
    const sample = pool.sample(scripted([2, 6, 1, 7]));
    expect(sample.total).toBe(6 + 7);
    expect(sample.dice).toEqual([
      { sides: 8, face: 2, kept: false },
      { sides: 8, face: 6, kept: true },
      { sides: 10, face: 1, kept: false },
      { sides: 10, face: 7, kept: true, reroll: true },
    ]);
  });

  it("matches the PMF's mean", () => {
    let seed = 7;
    const rng: Rng = {
      die: (n) => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return Math.floor((seed / 2147483648) * n) + 1;
      },
      chance: () => false,
    };
    const pool = roll(1, d8).plus(3).rerollUpTo(1, { rolls: 2, rolledOnce: roll(1, d10) });
    let sum = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) sum += pool.sample(rng).total;
    expect(Math.abs(sum / n - (3 + 8170 / 640))).toBeLessThan(0.1);
  });
});
