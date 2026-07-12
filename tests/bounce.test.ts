import { describe, expect, it } from "vitest";
import { calculateBounceOdds } from "../src/index";

/**
 * Exact P(>=1 duplicate) by full enumeration over faces^dice outcomes, applying
 * the Elemental Adept collapse (rolls below `min` become `min`). This is the
 * ground truth the closed form must match.
 */
function bruteMatch(dice: number, faces: number, min = 0): number {
  let total = 0;
  let dupes = 0;
  const roll = new Array(dice).fill(1);
  const rec = (pos: number): void => {
    if (pos === dice) {
      total++;
      const vals = roll.map((v) => (min >= 2 && v < min ? min : v));
      if (new Set(vals).size < dice) dupes++;
      return;
    }
    for (let v = 1; v <= faces; v++) {
      roll[pos] = v;
      rec(pos + 1);
    }
  };
  rec(0);
  return dupes / total;
}

describe("calculateBounceOdds — base case (exact vs enumeration)", () => {
  const cases: Array<[number, number]> = [
    [2, 6],
    [3, 8],
    [4, 8],
    [3, 6],
    [4, 10],
    [5, 10],
    [2, 20],
    [6, 8],
  ];
  it.each(cases)("K=%i, d%i matches brute force", (dice, faces) => {
    expect(calculateBounceOdds(dice, faces)).toBeCloseTo(bruteMatch(dice, faces), 12);
  });
});

describe("calculateBounceOdds — Elemental Adept (exact vs enumeration)", () => {
  const cases: Array<[number, number, number]> = [
    [3, 8, 2],
    [3, 8, 3],
    [4, 8, 2],
    [2, 6, 2],
    [3, 6, 2],
    [4, 10, 3],
    [5, 10, 2],
    [3, 12, 4],
  ];
  it.each(cases)("K=%i, d%i, min=%i matches brute force", (dice, faces, min) => {
    expect(calculateBounceOdds(dice, faces, { minimumDieRoll: min })).toBeCloseTo(
      bruteMatch(dice, faces, min),
      12
    );
  });
});

describe("calculateBounceOdds — edges and monotonicity", () => {
  it("returns 0 for one die and 1 when dice exceed faces (pigeonhole)", () => {
    expect(calculateBounceOdds(1, 8)).toBe(0);
    expect(calculateBounceOdds(0, 8)).toBe(0);
    expect(calculateBounceOdds(9, 8)).toBe(1);
  });

  it("stays within [0, 1]", () => {
    for (const min of [0, 2, 3]) {
      for (const rr of [0, 1, 2]) {
        for (let k = 2; k <= 6; k++) {
          const p = calculateBounceOdds(k, 8, { minimumDieRoll: min, rerollDamageDice: rr });
          expect(p).toBeGreaterThanOrEqual(0);
          expect(p).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("Empowered Spell (reroll) never lowers the odds vs no reroll", () => {
    for (let k = 2; k <= 6; k++) {
      const base = calculateBounceOdds(k, 8);
      const withReroll = calculateBounceOdds(k, 8, { rerollDamageDice: 2 });
      expect(withReroll).toBeGreaterThanOrEqual(base - 1e-12);
    }
  });

  it("Elemental Adept raises match odds vs a plain die (fewer effective faces)", () => {
    for (let k = 2; k <= 4; k++) {
      const plain = calculateBounceOdds(k, 8);
      const adept = calculateBounceOdds(k, 8, { minimumDieRoll: 2 });
      expect(adept).toBeGreaterThan(plain);
    }
  });
});
