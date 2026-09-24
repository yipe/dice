import { describe, expect, it } from "vitest";
import { calculateBounceOdds } from "../src/index";

/**
 * Exact P(match) with an optional reroll, by enumerating every roll: a roll that
 * matched stands; otherwise the best subset of at most `reroll` dice is rolled
 * again, and matches when a fresh die collides with another fresh die or a kept
 * one. Elemental Adept (`min >= 2`) floors every roll, the fresh ones included.
 */
function bruteEmpowered(dice: number, faces: number, reroll: number, min = 0): number {
  const floor = (value: number): number => (min >= 2 && value < min ? min : value);
  const rolls = (count: number): number[][] => {
    let out: number[][] = [[]];
    for (let i = 0; i < count; i++) {
      out = out.flatMap((prefix) =>
        Array.from({ length: faces }, (_, face) => [...prefix, floor(face + 1)])
      );
    }
    return out;
  };
  const hasMatch = (values: readonly number[]): boolean => new Set(values).size < values.length;

  const fresh = new Map<string, number>();
  const pMatchWithKept = (kept: number[], count: number): number => {
    const key = `${[...kept].sort((a, b) => a - b).join(",")}|${count}`;
    const known = fresh.get(key);
    if (known !== undefined) return known;
    const outcomes = rolls(count);
    const p = outcomes.filter((values) => hasMatch([...kept, ...values])).length / outcomes.length;
    fresh.set(key, p);
    return p;
  };

  const first = rolls(dice);
  let total = 0;
  for (const values of first) {
    if (hasMatch(values)) {
      total += 1;
      continue;
    }
    let best = 0;
    for (let mask = 0; mask < 1 << dice; mask++) {
      const count = values.filter((_, i) => mask & (1 << i)).length;
      if (count > reroll) continue;
      const kept = values.filter((_, i) => !(mask & (1 << i)));
      best = Math.max(best, pMatchWithKept(kept, count));
    }
    total += best;
  }
  return total / first.length;
}

describe("calculateBounceOdds with rerolled dice (Empowered Spell)", () => {
  it("pins exact values: the fresh dice must avoid the kept faces and each other", () => {
    expect(calculateBounceOdds(3, 8, { rerollDamageDice: 2 })).toBeCloseTo(583 / 1024, 14);
    expect(calculateBounceOdds(3, 4, { rerollDamageDice: 2 })).toBeCloseTo(55 / 64, 14);
  });

  it("weights the collapsed Elemental Adept face by its real probability", () => {
    expect(calculateBounceOdds(2, 4, { rerollDamageDice: 1, minimumDieRoll: 2 })).toBeCloseTo(21 / 32, 14);
  });

  it("rerolls up to the limit, not always all of it, when fewer dice give better odds", () => {
    // Keeping the heavy collapsed face and rerolling one die (43/64) beats rerolling both (39/64).
    for (const rerollDamageDice of [2, 3, 5]) {
      expect(calculateBounceOdds(2, 4, { rerollDamageDice, minimumDieRoll: 2 })).toBeCloseTo(43 / 64, 14);
    }
  });

  it("agrees with full enumeration across pool sizes, dice, limits and minimums", () => {
    for (const faces of [4, 6, 8]) {
      for (const dice of [2, 3]) {
        for (const reroll of [1, 2, 3]) {
          for (const min of [0, 2, 3]) {
            expect(
              calculateBounceOdds(dice, faces, { rerollDamageDice: reroll, minimumDieRoll: min })
            ).toBeCloseTo(bruteEmpowered(dice, faces, reroll, min), 12);
          }
        }
      }
    }
    expect(calculateBounceOdds(4, 6, { rerollDamageDice: 2, minimumDieRoll: 2 })).toBeCloseTo(
      bruteEmpowered(4, 6, 2, 2),
      12
    );
    expect(calculateBounceOdds(4, 8, { rerollDamageDice: 3 })).toBeCloseTo(bruteEmpowered(4, 8, 3), 12);
  });
});
