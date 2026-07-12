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

  it("stays finite and within [0, 1] across the full grid, incl. dice near/above the collapsed face count", () => {
    // min 3–4 collapse a d8 to 6/5 distinct values, so k up to 8 pushes past the
    // pigeonhole bound while Empowered Spell rerolls — the branch where keptDice
    // can exceed effectiveFaces. Guard against NaN / out-of-range there.
    for (const faces of [6, 8]) {
      for (const min of [0, 2, 3, 4]) {
        for (const rr of [0, 1, 2, 3]) {
          for (let k = 2; k <= faces; k++) {
            const p = calculateBounceOdds(k, faces, { minimumDieRoll: min, rerollDamageDice: rr });
            expect(Number.isFinite(p)).toBe(true);
            expect(p).toBeGreaterThanOrEqual(0);
            expect(p).toBeLessThanOrEqual(1);
          }
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

describe("calculateBounceOdds — Empowered Spell (reroll)", () => {
  it("rerolling ALL dice equals two independent identical rolls: 1 - (1 - pMatch)^2", () => {
    // keptDice === 0: the only way to match is among the rerolled dice, which is a
    // second independent roll of the same pool. (Regression guard: a former bug
    // returned certainty of a match here.)
    const cases: Array<[number, number, number]> = [
      [3, 8, 0],
      [4, 8, 0],
      [2, 6, 0],
      [4, 10, 0],
      [3, 8, 2],
      [3, 10, 3],
    ];
    for (const [k, faces, min] of cases) {
      const opts = min > 0 ? { minimumDieRoll: min } : {};
      const base = calculateBounceOdds(k, faces, opts);
      const rerollAll = calculateBounceOdds(k, faces, { ...opts, rerollDamageDice: k });
      expect(rerollAll).toBeCloseTo(1 - (1 - base) ** 2, 12);
    }
  });

  it("is monotonically non-decreasing in the number of rerolled dice", () => {
    for (const [k, faces] of [
      [3, 8],
      [4, 10],
      [2, 6],
      [4, 8],
    ] as Array<[number, number]>) {
      let prev = -1;
      for (let rr = 0; rr <= k + 2; rr++) {
        const p = calculateBounceOdds(k, faces, { rerollDamageDice: rr });
        expect(p).toBeGreaterThanOrEqual(prev - 1e-12);
        prev = p;
      }
    }
  });

  it("clamps rerolled dice to the pool size (reroll >= diceCount all agree)", () => {
    const rerollAll = calculateBounceOdds(3, 8, { rerollDamageDice: 3 });
    for (const rr of [4, 5, 9, 100]) {
      expect(calculateBounceOdds(3, 8, { rerollDamageDice: rr })).toBeCloseTo(rerollAll, 12);
    }
  });

  it("combines with Elemental Adept without dropping below EA-only odds", () => {
    for (const [k, faces, min] of [
      [3, 8, 2],
      [3, 8, 3],
      [4, 10, 2],
    ] as Array<[number, number, number]>) {
      const eaOnly = calculateBounceOdds(k, faces, { minimumDieRoll: min });
      const eaEmpowered = calculateBounceOdds(k, faces, { minimumDieRoll: min, rerollDamageDice: 2 });
      expect(eaEmpowered).toBeGreaterThanOrEqual(eaOnly - 1e-12);
      expect(eaEmpowered).toBeLessThanOrEqual(1);
    }
  });

  it("matches known values for the reroll model (regression guard)", () => {
    // The reroll model is an approximation with no closed-form oracle; pin
    // representative outputs so refactors don't silently shift it.
    expect(calculateBounceOdds(3, 8, { rerollDamageDice: 1 })).toBeCloseTo(0.507813, 6);
    expect(calculateBounceOdds(3, 8, { rerollDamageDice: 2 })).toBeCloseTo(0.560364, 6);
    expect(calculateBounceOdds(4, 10, { rerollDamageDice: 2 })).toBeCloseTo(0.709696, 6);
    expect(calculateBounceOdds(3, 8, { minimumDieRoll: 2, rerollDamageDice: 2 })).toBeCloseTo(0.636779, 6);
  });
});
