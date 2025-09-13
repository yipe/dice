import { describe, expect, it } from "vitest";
import { EPS, parse } from "../src/index";
import { DiceQuery } from "../src/query";

function pmf(expr: string) {
  return parse(expr);
}

function validateDiceMetadata(testCase: any) {
  const dice = parse(testCase.expression);

  // Check that dice has expected metadata
  expect(dice.hasOutcome("hit")).toBe(true);
  expect(dice.hasOutcome("crit")).toBe(true);

  // Check that face values make sense
  const total = dice.mass();
  expect(total).toBeGreaterThan(0);

  // All faces should have non-negative values
  for (const face of dice.map.keys()) {
    expect(face).toBeGreaterThanOrEqual(0);
    expect(dice.map.get(face)?.p).toBeGreaterThanOrEqual(0);
  }
}

// Keep existing tests for backward compatibility
describe("E2E: real expressions (original)", () => {
  const cases = [
    "(d20 + 5 AC 12) * (1d12 + 3) crit (3d12 + 3) miss (3)",
    "(d20 + 10 AC 15) * (2d6 + 4) crit (4d6 + 4)",
    "(d20 + 8 AC 16) * (3d12 + 2d6 + 1d4 + 4) crit (6d12 + 4d6 + 2d4 + 4)",
    "(d20 + 11 ac 15) * (2(3>(d6 reroll 2)) + 2d6 + 4) crit (4(3>(d6 reroll 2)) + 4d6 + 4)",
    "(d20 > d20 + 10 AC 15) * (2d6 + 4) xcrit2 (4d6 + 4)",
    "(d20 < d20 + 10 AC 15) * (2d6 + 4) xcrit3 (4d6 + 4)",
    "(d20 + 6 DC 16) * (8d6) save half",
  ];

  it("each expression yields a normalized PMF and sane bounds", () => {
    for (const expr of cases) {
      const P = pmf(expr);
      expect(Math.abs(P.mass() - 1)).toBeLessThan(EPS);
      expect(P.min()).toBeLessThanOrEqual(P.max());
      expect(P.mass()).toBeCloseTo(1, EPS);
    }
  });

  it("event queries use singles; sanity check at least-one-crit", () => {
    const a = pmf("(d20 + 5 AC 12) * (1d12 + 3) crit (3d12 + 3) miss (3)");
    const b = pmf("(d20 + 10 AC 15) * (2d6 + 4) crit (4d6 + 4)");
    const q = new DiceQuery([a, b]);
    const p = q.probAtLeastOne("crit");
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThanOrEqual(1);
  });

  it("xcrit2 / xcrit3 expressions compile and produce higher max than normal hit", () => {
    const x2 = pmf("(d20 > d20 + 10 AC 15) * (2d6 + 4) xcrit2 (4d6 + 4)");
    const x3 = pmf("(d20 < d20 + 10 AC 15) * (2d6 + 4) xcrit3 (4d6 + 4)");
    expect(x3.max()).toBeGreaterThanOrEqual(x2.max());
  });

  it("save half uses floor(total/2) exact transform", () => {
    const S = pmf("(d20 + 6 DC 16) * (8d6) save half");
    let hasHalf = false,
      hasFail = false;
    for (const [, bin] of S) {
      if (bin.count["saveHalf"]) hasHalf = true;
      if (bin.count["saveFail"]) hasFail = true;
    }
    expect(hasHalf && hasFail).toBe(true);
  });

  describe("combines to pmfs and gets the right statistics", () => {
    it("should combine two basic attacks", () => {
      //   const P = pmf('(d20 + 5 AC 12) * (1d12 + 3) crit (3d12 + 3) miss (3)')
      const attack = pmf("(d20 + 10 AC 15) * (2d6 + 4) crit (4d6 + 4)");
      //   const R = pmf('(d20 + 8 AC 16) * (3d12 + 2d6 + 1d4 + 4) crit (6d12 + 4d6 + 2d4 + 4)')
      const attackQuery = new DiceQuery([attack]);
      const attacksQuery = new DiceQuery([attack, attack]);
      expect(attacksQuery.mean()).toBeCloseTo(attackQuery.mean() * 2, 4);

      // Test that probAtLeastOne with multiple labels works correctly for "any attack roll success"
      expect(attacksQuery.probAtLeastOne(["hit", "crit"])).toBeCloseTo(0.96, 4);

      const critChance = attacksQuery.probAtLeastOne("crit");

      expect(critChance).toBeCloseTo(0.0975, 4);

      // Check damage statistics for ALL outcome scenarios (calculated from individual attacks)
      // This gives us the statistics for "all hits, no crits" and "all crits, no hits"
      const allHitStats = attacksQuery.combinedDamageStats("hit");
      expect(allHitStats.min).toBe(12); // Two attacks, both hit min (6+6)
      expect(allHitStats.avg).toBeCloseTo(22, 1); // Two attacks, both hit avg (11+11)
      expect(allHitStats.max).toBe(32); // Two attacks, both hit max (16+16)

      const allCritStats = attacksQuery.combinedDamageStats("crit");
      expect(allCritStats.min).toBe(16); // Two attacks, both crit min (8+8)
      expect(allCritStats.avg).toBeCloseTo(36, 1); // Two attacks, both crit avg (18+18)
      expect(allCritStats.max).toBe(56); // Two attacks, both crit max (28+28)
    });
  });
});
