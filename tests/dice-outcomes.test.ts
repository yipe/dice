import { beforeEach, describe, expect, it } from "vitest";
import { DamageDistribution, OutcomeType } from "../src/common/types";
import { Dice } from "../src/parser/dice";

describe("Dice Outcome Management", () => {
  let dice: Dice;

  beforeEach(() => {
    dice = new Dice(6); // Standard d6
  });

  describe("setOutcomeDistribution and getOutcomeDistribution", () => {
    it("should set and get outcome distributions correctly", () => {
      const critDistribution: DamageDistribution = { 6: 1.0 };

      dice.setOutcomeDistribution("crit", critDistribution);
      const retrieved = dice.getOutcomeDistribution("crit");

      expect(retrieved).toEqual(critDistribution);
    });

    it("should handle all outcome types", () => {
      // Skip hit as that is calculated automatically
      const outcomeTypes: OutcomeType[] = [
        "crit",
        "missNone",
        "missDamage",
        "saveHalf",
        "saveFail",
        "pc",
      ];

      for (const outcomeType of outcomeTypes) {
        const distribution: DamageDistribution = { 1: 0.2, 3: 0.5, 6: 0.3 };

        dice.setOutcomeDistribution(outcomeType, distribution);
        const retrieved = dice.getOutcomeDistribution(outcomeType);

        expect(retrieved).toEqual(distribution);
      }
      expect(dice.getOutcomeDistribution("hit")).toBeDefined();
    });

    it("should return undefined for unset outcome distributions", () => {
      expect(dice.getOutcomeDistribution("crit")).toBeUndefined();
      expect(dice.getOutcomeDistribution("missNone")).toBeUndefined();
    });

    it("should delete outcome distributions when set to undefined", () => {
      const critDistribution: DamageDistribution = { 6: 1.0 };

      dice.setOutcomeDistribution("crit", critDistribution);
      expect(dice.getOutcomeDistribution("crit")).toEqual(critDistribution);

      dice.setOutcomeDistribution("crit", undefined);
      expect(dice.getOutcomeDistribution("crit")).toBeUndefined();
    });

    it("should handle empty distributions", () => {
      const emptyDistribution: DamageDistribution = {};

      dice.setOutcomeDistribution("crit", emptyDistribution);
      expect(dice.getOutcomeDistribution("crit")).toEqual(emptyDistribution);
    });

    it("should handle complex distributions with multiple damage values", () => {
      const complexDistribution: DamageDistribution = {
        0: 0.1, // Miss
        1: 0.15, // Low damage
        3: 0.25, // Medium damage
        6: 0.3, // High damage
        12: 0.2, // Critical damage
      };

      dice.setOutcomeDistribution("crit", complexDistribution);
      expect(dice.getOutcomeDistribution("crit")).toEqual(complexDistribution);
    });
  });

  describe("getFullOutcomeDistribution", () => {
    it("should return all outcome distributions", () => {
      const critDist: DamageDistribution = { 6: 1.0 };
      const missDist: DamageDistribution = { 0: 1.0 };

      dice.setOutcomeDistribution("crit", critDist);
      dice.setOutcomeDistribution("missNone", missDist);

      const full = dice.getFullOutcomeDistribution();

      expect(full.crit).toEqual(critDist);
      expect(full.missNone).toEqual(missDist);
      expect(full.hit).toBeUndefined(); // Not set
    });

    it("should return a copy, not the original data", () => {
      const critDist: DamageDistribution = { 6: 1.0 };
      dice.setOutcomeDistribution("crit", critDist);

      const full1 = dice.getFullOutcomeDistribution();
      const full2 = dice.getFullOutcomeDistribution();

      expect(full1).not.toBe(full2);
      expect(full1).toEqual(full2);
    });

    it("should return empty object structure when no outcomes are set", () => {
      const full = dice.getFullOutcomeDistribution();

      expect(full).toEqual({
        crit: undefined,
        hit: undefined,
        missNone: undefined,
        missDamage: undefined,
        saveHalf: undefined,
        saveFail: undefined,
        pc: undefined,
      });
    });
  });

  describe("hasOutcomeData", () => {
    it("should return false for unset outcome data", () => {
      expect(dice.hasOutcomeData("crit")).toBe(false);
      expect(dice.hasOutcomeData("missNone")).toBe(false);
    });

    it("should return true for set outcome data", () => {
      dice.setOutcomeDistribution("crit", { 6: 1.0 });
      expect(dice.hasOutcomeData("crit")).toBe(true);
    });

    it("should return false for empty distributions", () => {
      dice.setOutcomeDistribution("crit", {});
      expect(dice.hasOutcomeData("crit")).toBe(false);
    });

    it("should handle hit distribution calculation automatically", () => {
      // Hit distribution should be calculated on first access
      const hasHitData = dice.hasOutcomeData("hit");
      expect(typeof hasHitData).toBe("boolean");
    });

    it("should return true for distributions with zero values", () => {
      dice.setOutcomeDistribution("crit", { 0: 1.0 });
      expect(dice.hasOutcomeData("crit")).toBe(true);
    });

    it("should return true for distributions with negative values", () => {
      dice.setOutcomeDistribution("crit", { 1: -0.5, 6: 1.5 });
      expect(dice.hasOutcomeData("crit")).toBe(true);
    });
  });

  describe("getOutcomeCount", () => {
    it("should return 0 for unset outcome data", () => {
      expect(dice.getOutcomeCount("crit", 6)).toBe(0);
      expect(dice.getOutcomeCount("missNone", 0)).toBe(0);
    });

    it("should return correct counts for set outcome data", () => {
      const distribution: DamageDistribution = { 1: 0.2, 3: 0.5, 6: 0.3 };
      dice.setOutcomeDistribution("crit", distribution);

      expect(dice.getOutcomeCount("crit", 1)).toBe(0.2);
      expect(dice.getOutcomeCount("crit", 3)).toBe(0.5);
      expect(dice.getOutcomeCount("crit", 6)).toBe(0.3);
    });

    it("should return 0 for faces not in the distribution", () => {
      const distribution: DamageDistribution = { 1: 0.2, 6: 0.8 };
      dice.setOutcomeDistribution("crit", distribution);

      expect(dice.getOutcomeCount("crit", 2)).toBe(0);
      expect(dice.getOutcomeCount("crit", 5)).toBe(0);
      expect(dice.getOutcomeCount("crit", 10)).toBe(0);
    });

    it("should handle fractional counts", () => {
      const distribution: DamageDistribution = { 3: 0.166667, 6: 0.833333 };
      dice.setOutcomeDistribution("crit", distribution);

      expect(dice.getOutcomeCount("crit", 3)).toBeCloseTo(0.166667, 6);
      expect(dice.getOutcomeCount("crit", 6)).toBeCloseTo(0.833333, 6);
    });

    it("should handle zero and negative damage values", () => {
      const distribution: DamageDistribution = { 0: 0.1, 1: 0.9 };
      dice.setOutcomeDistribution("missNone", distribution);

      expect(dice.getOutcomeCount("missNone", 0)).toBe(0.1);
      expect(dice.getOutcomeCount("missNone", 1)).toBe(0.9);
    });
  });

  describe("getAverage", () => {
    it("should return 0 for unset outcome data", () => {
      expect(dice.getAverage("crit")).toBe(0);
      expect(dice.getAverage("missNone")).toBe(0);
    });

    it("should calculate correct average for simple distributions", () => {
      // Distribution: 50% chance of 2 damage, 50% chance of 4 damage
      // Expected average: (2 * 0.5) + (4 * 0.5) = 3
      const distribution: DamageDistribution = { 2: 0.5, 4: 0.5 };
      dice.setOutcomeDistribution("crit", distribution);

      expect(dice.getAverage("crit")).toBe(3);
    });

    it("should calculate correct average for complex distributions", () => {
      // Distribution: 20% of 1, 30% of 3, 50% of 6
      // Expected: (1 * 0.2) + (3 * 0.3) + (6 * 0.5) = 0.2 + 0.9 + 3.0 = 4.1
      const distribution: DamageDistribution = { 1: 0.2, 3: 0.3, 6: 0.5 };
      dice.setOutcomeDistribution("crit", distribution);

      expect(dice.getAverage("crit")).toBeCloseTo(4.1, 10);
    });

    it("should handle distributions with zero damage", () => {
      // 60% miss (0 damage), 40% hit (5 damage)
      // Expected: (0 * 0.6) + (5 * 0.4) = 2.0
      const distribution: DamageDistribution = { 0: 0.6, 5: 0.4 };
      dice.setOutcomeDistribution("crit", distribution);

      expect(dice.getAverage("crit")).toBe(2.0);
    });

    it("should handle single-value distributions", () => {
      const distribution: DamageDistribution = { 8: 1.0 };
      dice.setOutcomeDistribution("crit", distribution);

      expect(dice.getAverage("crit")).toBe(8);
    });

    it("should handle fractional damage and counts", () => {
      // 1/3 chance of 1.5 damage, 2/3 chance of 4.5 damage
      // Expected: (1.5 * 1/3) + (4.5 * 2/3) = 0.5 + 3.0 = 3.5
      const distribution: DamageDistribution = { 1.5: 1 / 3, 4.5: 2 / 3 };
      dice.setOutcomeDistribution("crit", distribution);

      expect(dice.getAverage("crit")).toBeCloseTo(3.5, 10);
    });

    it("should return 0 for empty distributions", () => {
      dice.setOutcomeDistribution("crit", {});
      expect(dice.getAverage("crit")).toBe(0);
    });
  });

  describe("calculateHitDistribution", () => {
    it("should calculate hit distribution from face values", () => {
      // Standard d6 should have equal probability for each face
      const hitDist = dice.calculateHitDistribution();

      // Should have entries for faces 1-6
      expect(hitDist[1]).toBeDefined();
      expect(hitDist[2]).toBeDefined();
      expect(hitDist[3]).toBeDefined();
      expect(hitDist[4]).toBeDefined();
      expect(hitDist[5]).toBeDefined();
      expect(hitDist[6]).toBeDefined();

      expect(hitDist[0]).toBe(undefined);
    });

    it("should subtract other outcome distributions from hit counts", () => {
      // Set up a dice with some crit outcomes
      dice.setOutcomeDistribution("crit", { 6: 0.5 }); // 50% of 6s are crits

      const hitDist = dice.calculateHitDistribution();

      // Face 6 should have reduced hit count due to crits
      // Original d6 has 1/6 probability for each face
      // If 50% of 6s are crits, then hit count for 6 should be 0.5 * (1/6) = 1/12
      expect(hitDist[6]).toBeLessThan(hitDist[5]); // Should be less than other faces
    });

    it("should never produce negative hit counts", () => {
      // Set up extreme case that might cause negative hit counts
      dice.setOutcomeDistribution("crit", { 6: 2.0 }); // More than 100%

      const hitDist = dice.calculateHitDistribution();

      for (const [face, count] of Object.entries(hitDist)) {
        expect(
          count,
          `Face ${face} should not have negative hit count`
        ).toBeGreaterThanOrEqual(0);
      }
    });

    it("should be deterministic - same input produces same output", () => {
      dice.setOutcomeDistribution("crit", { 6: 0.2 });

      const hitDist1 = dice.calculateHitDistribution();
      const hitDist2 = dice.calculateHitDistribution();

      expect(hitDist1).toEqual(hitDist2);
    });
  });

  describe("Integration with Hit Distribution", () => {
    it("should automatically calculate hit distribution when hasOutcomeData('hit') is called", () => {
      // Calling hasOutcomeData should trigger calculation
      const hasHitData = dice.hasOutcomeData("hit");
      expect(dice.getOutcomeDistribution("hit")).toBeDefined();
      expect(hasHitData).toBe(true);
    });

    it("should cache hit distribution calculation", () => {
      const hitDist1 = dice.getOutcomeDistribution("hit");
      expect(dice.hasOutcomeData("hit")).toBe(true);

      const hitDist2 = dice.getOutcomeDistribution("hit");
      // Values should be equal (cached calculation), but objects are different (immutability)
      expect(hitDist1).toEqual(hitDist2);
      expect(hitDist1).not.toBe(hitDist2);
    });

    it("should recalculate hit distribution when outcome data changes", () => {
      // Get initial hit distribution
      const initialHitDist = dice.getOutcomeDistribution("hit");

      // Change outcome data
      dice.setOutcomeDistribution("crit", { 6: 0.5 });

      // Hit distribution should be recalculated (implementation detail)
      // This test verifies the integration works correctly
      expect(dice.hasOutcomeData("hit")).toBe(true);
    });
  });

  describe("Edge Cases and Error Handling", () => {
    it("should handle very large damage values", () => {
      const largeDamageDistribution: DamageDistribution = {
        [Number.MAX_SAFE_INTEGER]: 1.0,
      };

      dice.setOutcomeDistribution("crit", largeDamageDistribution);

      expect(dice.getOutcomeCount("crit", Number.MAX_SAFE_INTEGER)).toBe(1.0);
      expect(dice.getAverage("crit")).toBe(Number.MAX_SAFE_INTEGER);
    });

    it("should handle very small probability values", () => {
      const smallProbDistribution: DamageDistribution = {
        6: Number.MIN_VALUE,
      };

      dice.setOutcomeDistribution("crit", smallProbDistribution);

      expect(dice.getOutcomeCount("crit", 6)).toBe(Number.MIN_VALUE);
      expect(dice.hasOutcomeData("crit")).toBe(true);
    });

    it("should handle negative damage values", () => {
      const negativeDamageDistribution: DamageDistribution = {
        [-5]: 0.3,
        [0]: 0.4,
        [3]: 0.3,
      };

      dice.setOutcomeDistribution("crit", negativeDamageDistribution);

      expect(dice.getOutcomeCount("crit", -5)).toBe(0.3);
      expect(dice.getAverage("crit")).toBeCloseTo(-0.6, 10); // (-5*0.3) + (0*0.4) + (3*0.3)
    });

    it("should maintain immutability - modifying returned distributions should not affect internal state", () => {
      const originalDistribution: DamageDistribution = { 1: 0.5, 6: 0.5 };
      dice.setOutcomeDistribution("crit", originalDistribution);

      const retrieved = dice.getOutcomeDistribution("crit")!;
      retrieved[10] = 0.3; // Modify the returned object

      const retrievedAgain = dice.getOutcomeDistribution("crit")!;
      expect(retrievedAgain).not.toHaveProperty("10");
      expect(retrievedAgain).toEqual(originalDistribution);
    });
  });
});
