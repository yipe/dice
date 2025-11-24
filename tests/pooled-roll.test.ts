import { describe, expect, it } from "vitest";
import { d20, d4, d6, d8, roll } from "../src/builder";
import { PooledRollBuilder } from "../src/builder/roll";

describe("PooledRollBuilder", () => {
  describe("keepHighestAll", () => {
    it("should create a PooledRollBuilder", () => {
      const pool = d6.plus(d8).keepHighestAll(4, 3);
      expect(pool).toBeInstanceOf(PooledRollBuilder);
    });

    it("should produce correct expression string and PMF", () => {
      const pool = d6.plus(d8).keepHighestAll(4, 3);
      expect(pool.toExpression()).toBe("4kh3(1d8 + 1d6)");

      const pmf = pool.toPMF();
      expect(pmf).toBeDefined();
      expect(pmf.mean()).toBeCloseTo(26.96, 2);
      expect(pmf.min()).toBe(6);
      expect(pmf.max()).toBe(42);
    });

    it("should not equal the same as individual keep highest rolls", () => {
      const pool = d6.plus(d8).keepHighestAll(4, 3);
      expect(pool.toExpression()).toBe("4kh3(1d8 + 1d6)");

      const d8Roll = d8.keepHighest(4, 3);
      const d6Roll = d6.keepHighest(4, 3);
      const combined = d8Roll.plus(d6Roll);

      const poolPmf = pool.toPMF();
      const combinedPmf = combined.toPMF();
      expect(combinedPmf).toBeDefined();
      expect(poolPmf).toBeDefined();

      expect(poolPmf.mean()).toBeCloseTo(26.96, 2);
      expect(combinedPmf.mean()).toBeCloseTo(28.103, 2);

      expect(combinedPmf.min()).toBe(poolPmf.min());
      expect(combinedPmf.max()).toBe(poolPmf.max());
    });

    it("should handle arithmetic modifiers on the pool", () => {
      const pool = d6.plus(d8).keepHighestAll(4, 3).plus(5);
      expect(pool.toExpression()).toBe("4kh3(1d8 + 1d6) + 5");
    });

    it("should handle arithmetic modifiers before and after", () => {
      const pool = d6.plus(2).keepHighestAll(3, 2).plus(5);
      expect(pool.toExpression()).toBe("3kh2(1d6 + 2) + 5");
    });

    it("should compute correct PMF statistics for simple case", () => {
      // 2kh1(d6) is equivalent to 2d6kh1 or max(d6, d6)
      const pool = d6.keepHighestAll(2, 1);
      const pmf = pool.toPMF();

      expect(pmf.min()).toBe(1);
      expect(pmf.max()).toBe(6);
      // Mean of max(d6, d6) is approx 4.47
      expect(pmf.mean()).toBeCloseTo(4.47, 2);
    });

    it("should compute correct PMF for pooled complex expression", () => {
      // 2kh1(d6+d8) -> max(d6+d8, d6+d8)
      const pool = d6.plus(d8).keepHighestAll(2, 1);
      const pmf = pool.toPMF();

      const singleTrial = d6.plus(d8).toPMF();
      const expectedMean = singleTrial.mean();

      // Expect mean to be higher than single trial
      expect(pmf.mean()).toBeGreaterThan(expectedMean);
      expect(pmf.min()).toBe(2);
      expect(pmf.max()).toBe(14);
    });

    it("should correctly handle keep count = total count (noop effectively)", () => {
      const pool = d6.keepHighestAll(3, 3);
      const expected = roll(3).d6().toPMF();

      expect(pool.toPMF().mean()).toBeCloseTo(expected.mean());
      expect(pool.toPMF().min()).toBe(expected.min());
      expect(pool.toPMF().max()).toBe(expected.max());
    });
  });

  describe("keepLowestAll", () => {
    it("should create a PooledRollBuilder with correct expression", () => {
      const pool = d6.plus(d8).keepLowestAll(4, 3);
      expect(pool.toExpression()).toBe("4kl3(1d8 + 1d6)");
    });

    it("should compute correct PMF statistics", () => {
      // 2kl1(d6) -> min(d6, d6)
      const pool = d6.keepLowestAll(2, 1);
      const pmf = pool.toPMF();

      expect(pmf.min()).toBe(1);
      expect(pmf.max()).toBe(6);
      // Mean of min(d6, d6) is approx 2.53 (7 - 4.47)
      expect(pmf.mean()).toBeCloseTo(2.53, 2);
    });
  });

  describe("times()", () => {
    it("should multiply the pool by an integer count", () => {
      const pool = d6.keepHighestAll(2, 1).times(3);
      expect(pool.toExpression()).toBe("3(2kh1(1d6))");
    });

    it("should affect the PMF correctly", () => {
      // 3 * 2kh1(d6) -> 3 trials of max(d6, d6)
      const pool = d6.keepHighestAll(2, 1).times(3);
      const single = d6.keepHighestAll(2, 1).toPMF();
      const pmf = pool.toPMF();

      expect(pmf.mean()).toBeCloseTo(single.mean() * 3);
      expect(pmf.min()).toBe(single.min() * 3);
      expect(pmf.max()).toBe(single.max() * 3);
    });

    it("should throw for non-integers or negative numbers", () => {
      const pool = d6.keepHighestAll(2, 1);
      expect(() => pool.times(1.5)).toThrow("times() requires an integer");
      expect(() => pool.times(-1)).toThrow(
        "times() requires a non-negative integer"
      );
    });
  });

  describe("Restricted Operations", () => {
    it("should throw when adding dice to a pool", () => {
      const pool = d6.keepHighestAll(2, 1);
      expect(() => pool.d(6)).toThrow("Cannot add dice to a pooled roll");
    });

    it("should throw when setting reroll on a pool", () => {
      const pool = d6.keepHighestAll(2, 1);
      expect(() => pool.reroll(1)).toThrow(
        "Cannot set reroll on a pooled roll"
      );
    });

    it("should throw when setting explode on a pool", () => {
      const pool = d6.keepHighestAll(2, 1);
      expect(() => pool.explode(1)).toThrow(
        "Cannot set explode on a pooled roll"
      );
    });

    it("should throw when setting minimum on a pool", () => {
      const pool = d6.keepHighestAll(2, 1);
      expect(() => pool.minimum(1)).toThrow(
        "Cannot set minimum on a pooled roll"
      );
    });

    it("should throw when setting bestOf on a pool", () => {
      const pool = d6.keepHighestAll(2, 1);
      expect(() => pool.bestOf(1)).toThrow(
        "Cannot set bestOf on a pooled roll"
      );
    });

    it("should throw when setting advantage/disadvantage on a pool", () => {
      const pool = d6.keepHighestAll(2, 1);
      expect(() => pool.withAdvantage()).toThrow(
        "Cannot set advantage on a pooled roll"
      );
      expect(() => pool.withDisadvantage()).toThrow(
        "Cannot set disadvantage on a pooled roll"
      );
      expect(() => pool.withElvenAccuracy()).toThrow(
        "Cannot set elven accuracy on a pooled roll"
      );
    });

    it("should throw when using regular keepHighest/Lowest on a pool", () => {
      const pool = d6.keepHighestAll(2, 1);
      expect(() => pool.keepHighest(2, 1)).toThrow(
        "Cannot use keepHighest on a pooled roll"
      );
      expect(() => pool.keepLowest(2, 1)).toThrow(
        "Cannot use keepLowest on a pooled roll"
      );
    });
  });

  describe("Nesting", () => {
    it("should allow nested pooling via keepHighestAll", () => {
      // 3kh2( 4kh3(d6) )
      const inner = d6.keepHighestAll(4, 3);
      const outer = inner.keepHighestAll(3, 2);

      expect(outer).toBeInstanceOf(PooledRollBuilder);
      expect(outer.toExpression()).toBe("3kh2(4kh3(1d6))");
    });
  });

  describe("Usage with Attack/Save", () => {
    it("should work in an attack roll", () => {
      const pool = d6.plus(d8).keepHighestAll(4, 3);
      const attack = d20.plus(5).ac(15).onHit(pool);

      // Note: AttackBuilder by default adds a crit expression that doubles the dice.
      // For PooledRollBuilder, doubling means 2(...) wrapper.
      const poolExpr = "4kh3(1d8 + 1d6)";
      expect(attack.toExpression()).toBe(
        `(d20 + 5 AC 15) * (${poolExpr}) crit (2(${poolExpr}))`
      );

      const pmf = attack.toPMF();
      expect(pmf).toBeDefined();
      expect(pmf.mean()).toBeGreaterThan(0);
    });
  });

  describe("Comparison", () => {
    it("compares 2kh1(d6+d8) vs 2kh1(d6) + 2kh1(d8)", () => {
      // Case 1: Pooled (keep sum)
      // Rolls (d6+d8) twice, keeps the single highest SUM
      const pooled = d6.plus(d8).keepHighestAll(2, 1);
      const pooledMean = pooled.toPMF().mean();

      // Case 2: Separate (keep individual dice)
      // Rolls d6 twice keep highest, PLUS d8 twice keep highest
      // This is logically equivalent to taking the best d6 and adding the best d8
      // Note: In our API, keepHighest applies to the last die/group.
      // So we construct explicitly:
      const separate = d6.keepHighest(2, 1).plus(d8.keepHighest(2, 1));
      const separateMean = separate.toPMF().mean();

      console.log(`2kh1(d6+d8) mean: ${pooledMean.toFixed(4)}`);
      console.log(`2kh1(d6) + 2kh1(d8) mean: ${separateMean.toFixed(4)}`);

      // Mathematical intuition:
      // max(A+B, C+D) is generally LESS than max(A,C) + max(B,D)
      // because in the separate case you can pick the best A/C independent of B/D.
      // In the pooled case, a high A might be dragged down by a low B.
      expect(pooledMean).toBeLessThan(separateMean);
    });
  });

  describe("Advanced Composition & Edge Cases", () => {
    it("should handle pool.plus(roll) correctly", () => {
      const pool = d6.plus(d8).keepHighestAll(4, 3);
      const combined = pool.plus(d6);

      expect(combined).toBeInstanceOf(PooledRollBuilder);
      expect(combined.toExpression()).toBe("4kh3(1d8 + 1d6) + 1d6");
    });

    // **Known limitation** test: d6.plus(pool) throws an error
    it("should throw an error for d6.plus(pool) limitation", () => {
      const pool = d6.keepHighestAll(4, 3);
      expect(() => d6.plus(pool)).toThrow(
        "Cannot add a roll with hidden state (like a pooled roll) to a standard roll"
      );
    });

    it("should throw when using roll(count, pool)", () => {
      const pool = d6.keepHighestAll(4, 3);

      // Limitation: d6.plus(pool) or roll(count, pool) would technically require
      // RollBuilder to support nested ASTs, which it doesn't yet.
      // An actual fix is possible but would make RollBuilder more complex,
      // for a use case that we don't yet need.

      expect(() => roll(2, pool)).toThrow(
        "Cannot use a roll with hidden state (like a pooled roll) as a die type."
      );
    });

    it("should handle doubleDice() on a pool", () => {
      // 4kh3(d6) -> double -> 2(4kh3(d6))
      const pool = d6.keepHighestAll(4, 3);
      const doubled = pool.doubleDice();

      expect(doubled).toBeInstanceOf(PooledRollBuilder);
      expect(doubled.toExpression()).toBe("2(4kh3(1d6))");

      // Verify stats - mean should be exactly double
      const baseMean = pool.toPMF().mean();
      expect(doubled.toPMF().mean()).toBeCloseTo(baseMean * 2);
    });

    it("should handle subtraction", () => {
      const pool = d6.keepHighestAll(4, 3);
      const minusStatic = pool.minus(2);
      expect(minusStatic.toExpression()).toBe("4kh3(1d6) - 2");

      const minusRoll = pool.minus(d4);
      expect(minusRoll.toExpression()).toBe("4kh3(1d6) - 1d4");
    });

    it("should handle keep count > total count", () => {
      // keep 5 of 3 trials -> keeps 3
      const pool = d6.keepHighestAll(3, 5);
      const expected = roll(3).d6().toPMF();

      expect(pool.toPMF().mean()).toBeCloseTo(expected.mean());
    });

    it("should handle keep count 0", () => {
      const pool = d6.keepHighestAll(3, 0);
      expect(pool.toPMF().mean()).toBe(0);
      expect(pool.toPMF().max()).toBe(0);
    });
  });
});
