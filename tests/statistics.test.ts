import { describe, expect, it } from "vitest";
import { DiceQuery, parse } from "../src/index";

/**
 * Direct mathematical verification of statistics calculation functions.
 * Tests the core math without any React rendering overhead.
 */
describe("Statistics Calculation - Mathematical Verification", () => {
  const testExpression = "(d20 + 10 AC 15) * (2d6 + 4) crit (4d6 + 4)";

  describe("Core Statistics for Default Expression", () => {
    it("should calculate exact statistics for disadvantage, normal, and advantage", () => {
      // Create expressions directly
      const disadvantageExpr =
        "(d20 < d20 + 10 AC 15) * (2d6 + 4) crit (4d6 + 4)";
      const normalExpr = "(d20 + 10 AC 15) * (2d6 + 4) crit (4d6 + 4)";
      const advantageExpr = "(d20 > d20 + 10 AC 15) * (2d6 + 4) crit (4d6 + 4)";

      // Calculate PMFs directly
      const disPMF = parse(disadvantageExpr);
      const normalPMF = parse(normalExpr);
      const advPMF = parse(advantageExpr);

      // Create DiceQuery objects directly
      const disQuery = new DiceQuery([disPMF]);
      const normalQuery = new DiceQuery([normalPMF]);
      const advQuery = new DiceQuery([advPMF]);

      // Test disadvantage values
      expect(disQuery.mean()).toBeCloseTo(7.06, 2);
      expect(disQuery.probAtLeastOne(["hit", "crit"])).toBeCloseTo(0.64, 2);
      expect(disQuery.probAtLeastOne("crit")).toBeCloseTo(0.0025, 4);

      // Test normal values
      expect(normalQuery.mean()).toBeCloseTo(9.15, 2);
      expect(normalQuery.probAtLeastOne(["hit", "crit"])).toBeCloseTo(0.8, 2);
      expect(normalQuery.probAtLeastOne("crit")).toBeCloseTo(0.05, 3);

      // Test advantage values
      expect(advQuery.mean()).toBeCloseTo(11.24, 2);
      expect(advQuery.probAtLeastOne(["hit", "crit"])).toBeCloseTo(0.96, 2);
      expect(advQuery.probAtLeastOne("crit")).toBeCloseTo(0.0975, 4);

      // Test damage ranges (should be consistent across roll types)
      const normalHitStats = normalQuery.damageStatsFrom("hit");
      expect(normalHitStats.min).toBe(6);
      expect(normalHitStats.avg).toBeCloseTo(11, 0);
      expect(normalHitStats.max).toBe(16);

      const normalCritStats = normalQuery.damageStatsFrom("crit");
      expect(normalCritStats.min).toBe(8);
      expect(normalCritStats.avg).toBeCloseTo(18, 0);
      expect(normalCritStats.max).toBe(28);

      // Test standard deviation
      expect(normalQuery.stddev()).toBeCloseTo(5.31, 1);
    });
  });

  describe("Mathematical Relationships", () => {
    it("should have advantage > normal > disadvantage for damage and hit chance", () => {
      const disadvantageExpr =
        "(d20 < d20 + 10 AC 15) * (2d6 + 4) crit (4d6 + 4)";
      const normalExpr = "(d20 + 10 AC 15) * (2d6 + 4) crit (4d6 + 4)";
      const advantageExpr = "(d20 > d20 + 10 AC 15) * (2d6 + 4) crit (4d6 + 4)";

      const disQuery = new DiceQuery([parse(disadvantageExpr)]);
      const normalQuery = new DiceQuery([parse(normalExpr)]);
      const advQuery = new DiceQuery([parse(advantageExpr)]);

      // Verify mathematical ordering
      expect(advQuery.mean()).toBeGreaterThan(normalQuery.mean());
      expect(normalQuery.mean()).toBeGreaterThan(disQuery.mean());

      expect(advQuery.probAtLeastOne(["hit", "crit"])).toBeGreaterThan(
        normalQuery.probAtLeastOne(["hit", "crit"])
      );
      expect(normalQuery.probAtLeastOne(["hit", "crit"])).toBeGreaterThan(
        disQuery.probAtLeastOne(["hit", "crit"])
      );

      expect(advQuery.probAtLeastOne("crit")).toBeGreaterThanOrEqual(
        normalQuery.probAtLeastOne("crit")
      );
      expect(normalQuery.probAtLeastOne("crit")).toBeGreaterThanOrEqual(
        disQuery.probAtLeastOne("crit")
      );
    });
  });

  describe("Performance Verification", () => {
    it("should calculate statistics very quickly", () => {
      const start = performance.now();

      // Calculate all three variants
      const disPMF = parse("(d20 < d20 + 10 AC 15) * (2d6 + 4) crit (4d6 + 4)");
      const normalPMF = parse("(d20 + 10 AC 15) * (2d6 + 4) crit (4d6 + 4)");
      const advPMF = parse("(d20 > d20 + 10 AC 15) * (2d6 + 4) crit (4d6 + 4)");

      const queries = {
        disadvantage: new DiceQuery([disPMF]),
        normal: new DiceQuery([normalPMF]),
        advantage: new DiceQuery([advPMF]),
      };

      // Extract all statistics
      const stats = {
        disadvantage: {
          averageDPR: queries.disadvantage.mean(),
          hitChance: queries.disadvantage.probAtLeastOne(["hit", "crit"]),
          critChance: queries.disadvantage.probAtLeastOne("crit"),
        },
        normal: {
          averageDPR: queries.normal.mean(),
          hitChance: queries.normal.probAtLeastOne(["hit", "crit"]),
          critChance: queries.normal.probAtLeastOne("crit"),
        },
        advantage: {
          averageDPR: queries.advantage.mean(),
          hitChance: queries.advantage.probAtLeastOne(["hit", "crit"]),
          critChance: queries.advantage.probAtLeastOne("crit"),
        },
        hitDamage: queries.normal.damageStatsFrom("hit"),
        critDamage: queries.normal.damageStatsFrom("crit"),
        standardDeviation: queries.normal.stddev(),
      };

      const duration = performance.now() - start;

      // Should complete in under 50ms
      expect(duration).toBeLessThan(50);

      // Verify we got the expected values
      expect(stats.normal.averageDPR).toBeCloseTo(9.15, 2);
      expect(stats.hitDamage.min).toBe(6);
      expect(stats.critDamage.max).toBe(28);
    });
  });

  describe("Edge Cases", () => {
    it("should handle pure dice expressions (no attack mechanics)", () => {
      const pureDice = parse("2d6 + 4");
      const query = new DiceQuery([pureDice]);

      expect(query.mean()).toBeCloseTo(11, 0); // 2d6+4 = 7+4 = 11
      expect(query.min()).toBe(6); // 2+4 = 6
      expect(query.max()).toBe(16); // 12+4 = 16
    });

    it("should handle always-miss expressions", () => {
      const alwaysMiss = parse("(d20 + 0 AC 25) * (1d6)");
      const query = new DiceQuery([alwaysMiss]);

      expect(query.mean()).toBe(0);
      expect(query.probAtLeastOne(["hit", "crit"])).toBe(0);
    });

    it("should handle save expressions", () => {
      const save = parse("(d20 + 5 DC 16) * (2d6) save half");
      const query = new DiceQuery([save]);

      expect(query.mean()).toBeGreaterThan(0);
      expect(query.probAtLeastOne(["saveFail", "saveHalf"])).toBeGreaterThan(0);
    });
  });
});
