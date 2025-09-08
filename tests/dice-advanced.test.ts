import { beforeEach, describe, expect, it } from "vitest";
import { Dice } from "../src/dice";

describe("Dice Advanced Methods", () => {
  let d6: Dice;

  beforeEach(() => (d6 = new Dice(6)));

  describe("Face Access Methods", () => {
    describe("getFaceEntries", () => {
      it("should return face entries as [number, number] tuples", () => {
        const entries = d6.getFaceEntries();
        expect(entries).toHaveLength(6);
        expect(entries).toEqual([
          [1, 1],
          [2, 1],
          [3, 1],
          [4, 1],
          [5, 1],
          [6, 1],
        ]);
      });

      it("should return empty array for empty dice", () => {
        const emptyDice = new Dice();
        expect(emptyDice.getFaceEntries()).toEqual([]);
      });

      it("should handle custom face distributions", () => {
        const customDice = new Dice();
        customDice.setFace(10, 3);
        customDice.setFace(20, 2);

        const entries = customDice.getFaceEntries();
        expect(entries.sort()).toEqual(
          [
            [10, 3],
            [20, 2],
          ].sort()
        );
      });
    });

    describe("getFaceMap", () => {
      it("should return a copy of the face distribution", () => {
        const faceMap = d6.getFaceMap();

        expect(faceMap).toEqual({
          1: 1,
          2: 1,
          3: 1,
          4: 1,
          5: 1,
          6: 1,
        });
      });

      it("should return a copy, not the original", () => {
        const faceMap1 = d6.getFaceMap();
        const faceMap2 = d6.getFaceMap();

        expect(faceMap1).not.toBe(faceMap2);
        expect(faceMap1).toEqual(faceMap2);

        // Modifying returned map should not affect dice
        faceMap1[10] = 5;
        expect(d6.get(10)).toBe(0);
      });

      it("should return empty object for empty dice", () => {
        const emptyDice = new Dice();
        expect(emptyDice.getFaceMap()).toEqual({});
      });
    });

    describe("get", () => {
      it("should return face count for existing faces", () => {
        expect(d6.get(1)).toBe(1);
        expect(d6.get(6)).toBe(1);
      });

      it("should return 0 for non-existent faces", () => {
        expect(d6.get(0)).toBe(0);
        expect(d6.get(7)).toBe(0);
        expect(d6.get(100)).toBe(0);
      });

      it("should handle fractional face values", () => {
        d6.setFace(1, 0.5);
        expect(d6.get(1)).toBe(0.5);
      });

      it("should handle negative face values", () => {
        d6.setFace(-5, 2);
        expect(d6.get(-5)).toBe(2);
      });
    });

    describe("keys", () => {
      it("should return all face values as numbers", () => {
        const keys = d6.keys();
        expect(keys).toEqual([1, 2, 3, 4, 5, 6]);
      });

      it("should return empty array for empty dice", () => {
        const emptyDice = new Dice();
        expect(emptyDice.keys()).toEqual([]);
      });

      it("should handle non-sequential face values", () => {
        const customDice = new Dice();
        customDice.setFace(10, 1);
        customDice.setFace(1, 1);
        customDice.setFace(100, 1);

        const keys = customDice.keys();
        expect(keys).toHaveLength(3);
        expect(keys).toContain(1);
        expect(keys).toContain(10);
        expect(keys).toContain(100);
      });

      it("should return array of numbers, not strings", () => {
        const keys = d6.keys();
        for (const key of keys) {
          expect(typeof key).toBe("number");
        }
      });
    });

    describe("values", () => {
      it("should return all face counts", () => {
        const values = d6.values();
        expect(values).toEqual([1, 1, 1, 1, 1, 1]);
      });

      it("should return empty array for empty dice", () => {
        const emptyDice = new Dice();
        expect(emptyDice.values()).toEqual([]);
      });

      it("should handle different face counts", () => {
        const customDice = new Dice();
        customDice.setFace(1, 3);
        customDice.setFace(2, 2);
        customDice.setFace(3, 1);

        const values = customDice.values();
        expect(values).toEqual([3, 2, 1]);
      });
    });

    describe("total", () => {
      it("should return sum of all face counts", () => {
        expect(d6.total()).toBe(6); // 1+1+1+1+1+1
      });

      it("should return 0 for empty dice", () => {
        const emptyDice = new Dice();
        expect(emptyDice.total()).toBe(0);
      });

      it("should handle fractional counts", () => {
        const customDice = new Dice();
        customDice.setFace(1, 0.5);
        customDice.setFace(2, 0.3);
        customDice.setFace(3, 0.2);

        expect(customDice.total()).toBeCloseTo(1.0, 10);
      });

      it("should handle negative counts", () => {
        const customDice = new Dice();
        customDice.setFace(1, 2);
        customDice.setFace(2, -1);

        expect(customDice.total()).toBe(1);
      });
    });
  });

  describe("Face Modification Methods", () => {
    describe("setFace", () => {
      it("should set face count correctly", () => {
        d6.setFace(7, 3);
        expect(d6.get(7)).toBe(3);
      });

      it("should overwrite existing face counts", () => {
        expect(d6.get(1)).toBe(1);
        d6.setFace(1, 5);
        expect(d6.get(1)).toBe(5);
      });

      it("should handle zero counts", () => {
        d6.setFace(1, 0);
        expect(d6.get(1)).toBe(0);
      });

      it("should handle negative counts", () => {
        d6.setFace(1, -2);
        expect(d6.get(1)).toBe(-2);
      });

      it("should handle fractional counts", () => {
        d6.setFace(1, 0.75);
        expect(d6.get(1)).toBe(0.75);
      });
    });

    describe("increment", () => {
      it("should add to existing face count", () => {
        expect(d6.get(1)).toBe(1);
        d6.increment(1, 2);
        expect(d6.get(1)).toBe(3);
      });

      it("should create new face if it doesn't exist", () => {
        expect(d6.get(10)).toBe(0);
        d6.increment(10, 5);
        expect(d6.get(10)).toBe(5);
      });

      it("should handle negative increments", () => {
        d6.increment(1, -0.5);
        expect(d6.get(1)).toBe(0.5);
      });

      it("should handle zero increments", () => {
        const originalCount = d6.get(1);
        d6.increment(1, 0);
        expect(d6.get(1)).toBe(originalCount);
      });

      it("should handle fractional increments", () => {
        d6.increment(1, 0.25);
        expect(d6.get(1)).toBe(1.25);
      });
    });

    describe("maxFace and minFace", () => {
      it("should return correct max face", () => {
        expect(d6.maxFace()).toBe(6);
      });

      it("should return correct min face", () => {
        expect(d6.minFace()).toBe(1);
      });

      it("should throw for empty dice", () => {
        const emptyDice = new Dice();
        expect(() => emptyDice.maxFace()).toThrow("No numeric faces found");
        expect(() => emptyDice.minFace()).toThrow("No numeric faces found");
      });

      it("should handle negative face values", () => {
        const customDice = new Dice();
        customDice.setFace(-10, 1);
        customDice.setFace(5, 1);
        customDice.setFace(20, 1);

        expect(customDice.minFace()).toBe(-10);
        expect(customDice.maxFace()).toBe(20);
      });

      it("should handle single face", () => {
        const singleDice = new Dice();
        singleDice.setFace(42, 1);

        expect(singleDice.minFace()).toBe(42);
        expect(singleDice.maxFace()).toBe(42);
      });
    });
  });

  describe("Dice.scalar", () => {
    it("should create dice with single face value", () => {
      const scalar = Dice.scalar(10);

      expect(scalar.keys()).toEqual([10]);
      expect(scalar.get(10)).toBe(1);
      expect(scalar.total()).toBe(1);
    });

    it("should handle zero value", () => {
      const scalar = Dice.scalar(0);

      expect(scalar.keys()).toEqual([0]);
      expect(scalar.get(0)).toBe(1);
    });

    it("should handle negative values", () => {
      const scalar = Dice.scalar(-5);

      expect(scalar.keys()).toEqual([-5]);
      expect(scalar.get(-5)).toBe(1);
    });

    it("should handle fractional values", () => {
      const scalar = Dice.scalar(3.14);

      expect(scalar.keys()).toEqual([3.14]);
      expect(scalar.get(3.14)).toBe(1);
    });
  });

  describe("normalize", () => {
    it("should scale all face counts by scalar", () => {
      const normalized = d6.normalize(2);

      expect(normalized.get(1)).toBe(2);
      expect(normalized.get(6)).toBe(2);
      expect(normalized.total()).toBe(12);
    });

    it("should return new dice object", () => {
      const normalized = d6.normalize(2);

      expect(normalized).not.toBe(d6);
      expect(d6.get(1)).toBe(1); // Original unchanged
    });

    it("should handle fractional scalars", () => {
      const normalized = d6.normalize(0.5);

      expect(normalized.get(1)).toBe(0.5);
      expect(normalized.total()).toBe(3);
    });

    it("should handle zero scalar", () => {
      const normalized = d6.normalize(0);

      expect(normalized.total()).toBe(0);
      for (const face of normalized.keys()) {
        expect(normalized.get(face)).toBe(0);
      }
    });

    it("should handle negative scalars", () => {
      const normalized = d6.normalize(-1);

      expect(normalized.get(1)).toBe(-1);
      expect(normalized.total()).toBe(-6);
    });

    it("should preserve private data", () => {
      d6.privateData = { test: "value" };
      const normalized = d6.normalize(2);

      expect(normalized.privateData).toEqual({ test: "value" });
      expect(normalized.privateData).not.toBe(d6.privateData);
    });

    it("should preserve outcome data", () => {
      d6.setOutcomeDistribution("crit", { 6: 1.0 });
      const normalized = d6.normalize(2);

      expect(normalized.getOutcomeDistribution("crit")).toEqual({ 6: 1.0 });
    });
  });

  describe("Advanced Operations", () => {
    describe("conditionalApply", () => {
      it("should apply operation only when first value is non-zero", () => {
        const other = Dice.scalar(5);
        const result = d6.conditionalApply(other);

        // All faces 1-6 are non-zero, so should get 1 * 5 = 5
        for (let face = 1; face <= 6; face++) {
          expect(result.get(5)).toBeGreaterThan(0); // Should have face 5
        }
      });

      it("should return 0 when first value is zero", () => {
        const zeroDice = Dice.scalar(0);
        const other = Dice.scalar(10);
        const result = zeroDice.conditionalApply(other);

        expect(result.get(0)).toBe(1);
        expect(result.get(10)).toBe(0);
      });

      it("should work with scalar values", () => {
        const result = d6.conditionalApply(3);

        // All faces 1-6 are non-zero, so should get 1 * 3 = 3
        expect(result.get(3)).toBeGreaterThan(0);
      });
    });

    describe("addNonZero", () => {
      it("should add only to non-zero values", () => {
        const mixedDice = new Dice();
        mixedDice.setFace(0, 1);
        mixedDice.setFace(3, 1);

        const result = mixedDice.addNonZero(2);

        expect(result.get(0)).toBeGreaterThan(0); // 0 stays 0
        expect(result.get(5)).toBeGreaterThan(0); // 3 + 2 = 5
      });

      it("should preserve zero values unchanged", () => {
        const zeroDice = Dice.scalar(0);
        const result = zeroDice.addNonZero(10);

        expect(result.get(0)).toBe(1);
        expect(result.get(10)).toBe(0);
      });
    });

    describe("eq", () => {
      it("should return 1 for equal values, 0 for unequal", () => {
        const result = d6.eq(3);

        // Should have face 1 (when die shows 3, equals 3) and face 0 (when die shows other values)
        expect(result.get(1)).toBeGreaterThan(0); // Equal case
        expect(result.get(0)).toBeGreaterThan(0); // Unequal case
      });

      it("should work with dice-to-dice comparison", () => {
        const other = new Dice(6);
        const result = d6.eq(other);

        // Should have both 0 and 1 faces
        expect(result.get(0)).toBeGreaterThan(0); // Unequal cases
        expect(result.get(1)).toBeGreaterThan(0); // Equal cases
      });
    });

    describe("ge", () => {
      it("should return 1 when first value is less than second, 0 otherwise", () => {
        const result = d6.ge(4);

        // ge returns 1 when a >= b is false, i.e., when a < b
        expect(result.get(1)).toBeGreaterThan(0); // Cases where die < 4
        expect(result.get(0)).toBeGreaterThan(0); // Cases where die >= 4
      });
    });

    describe("divide operations", () => {
      describe("divide", () => {
        it("should perform regular division", () => {
          const result = d6.divide(2);

          expect(result.get(0.5)).toBeGreaterThan(0); // 1/2
          expect(result.get(3)).toBeGreaterThan(0); // 6/2
        });

        it("should handle division by zero", () => {
          const result = d6.divide(0);

          // Should produce Infinity values
          for (const face of result.keys()) {
            expect(Math.abs(face)).toBeGreaterThan(1000); // Very large or infinite
          }
        });
      });

      describe("divideRoundUp", () => {
        it("should round division results up", () => {
          const result = d6.divide(4);
          const roundedUp = d6.divideRoundUp(4);

          expect(roundedUp.get(1)).toBeGreaterThan(0); // ceil(1/4) = 1, ceil(2/4) = 1, etc.
          expect(roundedUp.get(2)).toBeGreaterThan(0); // ceil(5/4) = 2, ceil(6/4) = 2
        });
      });

      describe("divideRoundDown", () => {
        it("should round division results down", () => {
          const result = d6.divideRoundDown(4);

          expect(result.get(0)).toBeGreaterThan(0); // floor(1/4) = 0, floor(2/4) = 0, floor(3/4) = 0
          expect(result.get(1)).toBeGreaterThan(0); // floor(4/4) = 1, floor(5/4) = 1, floor(6/4) = 1
        });
      });
    });

    describe("and", () => {
      it("should return 1 when both values are truthy, 0 otherwise", () => {
        const other = new Dice();
        other.setFace(0, 1); // Falsy
        other.setFace(3, 1); // Truthy

        const result = d6.and(other);

        expect(result.get(0)).toBeGreaterThan(0); // Cases where one is falsy
        expect(result.get(1)).toBeGreaterThan(0); // Cases where both are truthy
      });
    });

    describe("advantage", () => {
      it("should return max of die with itself", () => {
        const result = d6.advantage();

        // Advantage should favor higher values
        expect(result.get(6)).toBeGreaterThan(result.get(1)); // 6 more likely than 1
        expect(result.minFace()).toBe(1);
        expect(result.maxFace()).toBe(6);
      });

      it("should be equivalent to max(self)", () => {
        const advantage = d6.advantage();
        const maxSelf = d6.max(d6);

        // Should have same distribution
        for (let face = 1; face <= 6; face++) {
          expect(advantage.get(face)).toBeCloseTo(maxSelf.get(face), 10);
        }
      });
    });
  });

  describe("Dice Manipulation", () => {
    describe("deleteFace", () => {
      it("should remove specified face", () => {
        const result = d6.deleteFace(3);

        expect(result.keys()).toEqual([1, 2, 4, 5, 6]);
        expect(result.get(3)).toBe(0);
        expect(result.total()).toBe(5);
      });

      it("should preserve other faces", () => {
        const result = d6.deleteFace(3);

        expect(result.get(1)).toBe(1);
        expect(result.get(6)).toBe(1);
      });

      it("should handle non-existent face", () => {
        const result = d6.deleteFace(10);

        expect(result.keys()).toEqual([1, 2, 3, 4, 5, 6]);
        expect(result.total()).toBe(6);
      });

      it("should preserve private and outcome data", () => {
        d6.privateData = { test: "value" };
        d6.setOutcomeDistribution("crit", { 6: 1.0 });

        const result = d6.deleteFace(3);

        expect(result.privateData).toEqual({ test: "value" });
        expect(result.getOutcomeDistribution("crit")).toEqual({ 6: 1.0 });
      });
    });

    describe("reroll", () => {
      it("should handle dice reroll values", () => {
        const rerollDice = Dice.scalar(1);
        const result = d6.reroll(rerollDice);
        expect(result).toBeInstanceOf(Dice);
      });
    });

    describe("combine", () => {
      it("should mix two dice distributions", () => {
        const other = new Dice(4); // d4
        const result = d6.combine(other);

        // Should have faces from both dice
        expect(result.keys()).toEqual(
          expect.arrayContaining([1, 2, 3, 4, 5, 6])
        );
        expect(result.total()).toBe(10); // 6 + 4
      });

      it("should handle scalar combination", () => {
        const result = d6.combine(10);

        expect(result.keys()).toEqual(
          expect.arrayContaining([1, 2, 3, 4, 5, 6, 10])
        );
        expect(result.total()).toBe(7); // 6 + 1
      });

      it("should handle overlapping faces correctly", () => {
        const other = new Dice();
        other.setFace(1, 2); // Same face as in dice
        other.setFace(7, 1); // New face

        const result = d6.combine(other);

        expect(result.get(1)).toBe(3); // 1 + 2
        expect(result.get(7)).toBe(1);
      });
    });

    describe("combineInPlace", () => {
      it("should modify the dice in place", () => {
        const other = new Dice(4);
        const originalTotal = d6.total();

        d6.combineInPlace(other);

        expect(d6.total()).toBe(originalTotal + 4);
        expect(d6.keys()).toEqual(expect.arrayContaining([1, 2, 3, 4, 5, 6]));
      });

      it("should handle overlapping faces", () => {
        const other = new Dice();
        other.setFace(1, 3);

        const originalCount = d6.get(1);
        d6.combineInPlace(other);

        expect(d6.get(1)).toBe(originalCount + 3);
      });
    });
  });

  describe("Statistical Methods", () => {
    describe("percent", () => {
      it("should return probability distribution", () => {
        const percentDist = d6.percent();

        // Each face should have 1/6 probability
        for (let face = 1; face <= 6; face++) {
          expect(percentDist[face]).toBeCloseTo(1 / 6, 10);
        }
      });

      it("should sum to 1", () => {
        const percentDist = d6.percent();
        const total = Object.values(percentDist).reduce((sum, p) => sum + p, 0);

        expect(total).toBeCloseTo(1, 10);
      });

      it("should handle empty dice", () => {
        const emptyDice = new Dice();
        const percentDist = emptyDice.percent();

        expect(percentDist).toEqual({});
      });

      it("should handle weighted dice", () => {
        const weightedDice = new Dice();
        weightedDice.setFace(1, 1);
        weightedDice.setFace(6, 3);

        const percentDist = weightedDice.percent();

        expect(percentDist[1]).toBeCloseTo(0.25, 10); // 1/4
        expect(percentDist[6]).toBeCloseTo(0.75, 10); // 3/4
      });
    });

    describe("average", () => {
      it("should calculate expected value correctly", () => {
        const avg = d6.average();

        // d6 expected value: (1+2+3+4+5+6)/6 = 3.5
        expect(avg).toBeCloseTo(3.5, 10);
      });

      it("should return 0 for empty dice", () => {
        const emptyDice = new Dice();
        expect(emptyDice.average()).toBe(0);
      });

      it("should handle weighted distributions", () => {
        const weightedDice = new Dice();
        weightedDice.setFace(2, 1);
        weightedDice.setFace(4, 3);

        const avg = weightedDice.average();

        // Expected: (2*1 + 4*3) / (1+3) = 14/4 = 3.5
        expect(avg).toBeCloseTo(3.5, 10);
      });

      it("should handle negative values", () => {
        const negativeDice = new Dice();
        negativeDice.setFace(-2, 1);
        negativeDice.setFace(4, 1);

        const avg = negativeDice.average();

        // Expected: (-2*1 + 4*1) / (1+1) = 2/2 = 1
        expect(avg).toBe(1);
      });
    });
  });

  describe("Edge Cases and Error Handling", () => {
    it("should handle very large face values", () => {
      const largeDice = new Dice();
      largeDice.setFace(Number.MAX_SAFE_INTEGER, 1);

      expect(largeDice.maxFace()).toBe(Number.MAX_SAFE_INTEGER);
      expect(largeDice.get(Number.MAX_SAFE_INTEGER)).toBe(1);
    });

    it("should handle very small probability values", () => {
      const smallProbDice = new Dice();
      smallProbDice.setFace(1, Number.MIN_VALUE);

      expect(smallProbDice.get(1)).toBe(Number.MIN_VALUE);
      expect(smallProbDice.total()).toBe(Number.MIN_VALUE);
    });

    it("should maintain precision with fractional operations", () => {
      const fracDice = new Dice();
      fracDice.setFace(1, 0.1);
      fracDice.setFace(2, 0.2);
      fracDice.setFace(3, 0.7);

      expect(fracDice.total()).toBeCloseTo(1.0, 10);
      expect(fracDice.average()).toBeCloseTo(2.6, 10); // 0.1*1 + 0.2*2 + 0.7*3
    });

    it("should handle zero-count faces gracefully", () => {
      d6.setFace(1, 0);

      expect(d6.get(1)).toBe(0);
      expect(d6.keys()).toContain(1); // Still in keys even with 0 count
    });

    it("should preserve immutability in operations", () => {
      const original = d6.getFaceMap();

      d6.add(5);
      d6.multiply(2);
      d6.normalize(0.5);

      expect(d6.getFaceMap()).toEqual(original); // Operations return new dice
    });
  });
});
