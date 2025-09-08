import { describe, expect, it } from "vitest";
import { parse } from "../src/index";
import { TEST_EXPRESSIONS } from "./dice-perf-helper";

describe("DicePerfPMF - PMF Performance Test Logic", () => {
  describe("PMF Performance Test Simulation", () => {
    it("should simulate PMF benchmark logic", () => {
      const count = 2; // Reduced for test speed
      const results: any[] = [];

      for (const expr of TEST_EXPRESSIONS.slice(0, 3)) {
        // Test first 3 for speed
        let tsTime, pmfTime;
        let tsResult, pmfResult;

        // TS Dice (no caching)
        const t1 = performance.now();
        for (let i = 0; i < count; i++) {
          tsResult = parse(expr);
        }
        tsTime = performance.now() - t1;

        // PMF calculation (no caching)
        const t2 = performance.now();
        for (let i = 0; i < count; i++) {
          pmfResult = parse(expr);
        }
        pmfTime = performance.now() - t2;

        // PMF 2x combine operation (no caching)
        const t3 = performance.now();
        for (let i = 0; i < count; i++) {
          const pmf1 = parse(expr);
          const pmf2 = parse(expr);
          const combinedPMF = pmf1.convolve(pmf2);
        }
        const combine2xTime = performance.now() - t3;

        // PMF 4x combine operation (no caching)
        const t4 = performance.now();
        for (let i = 0; i < count; i++) {
          const pmf1 = parse(expr);
          const pmf2 = parse(expr);
          const pmf3 = parse(expr);
          const pmf4 = parse(expr);
          const _2x = pmf1.convolve(pmf2);
          const _4x = pmf1.convolve(pmf2).convolve(pmf3).convolve(pmf4);
        }
        const combine4xTime = performance.now() - t4;

        results.push({
          expr,
          tsTime: tsTime.toFixed(1),
          pmfTime: pmfTime.toFixed(1),
          combine2xTime: combine2xTime.toFixed(1),
          combine4xTime: combine4xTime.toFixed(1),
        });
      }

      // Verify we have results
      expect(results).toHaveLength(3);

      // Verify timing data exists
      for (const result of results) {
        expect(result.tsTime).toBeDefined();
        expect(result.pmfTime).toBeDefined();
        expect(result.combine2xTime).toBeDefined();
        expect(result.combine4xTime).toBeDefined();
      }
    });
  });

  describe("PMF Result Comparison", () => {
    it("should be able to compare TS dice vs TS toPMF()", () => {
      const expr = "d20";

      const pmfResult = parse(expr);

      // Both should return objects
      expect(pmfResult).toBeDefined();

      // PMF should return a PMF object
      expect(pmfResult).toHaveProperty("map");
    });

    it("should correctly count faces and bins", () => {
      const expr = "d20";

      const pmfResult = parse(expr);

      const diceFaceCount = pmfResult.support().length;
      const pmfBinCount = pmfResult.map.size;

      // d20 should have 20 faces
      expect(diceFaceCount).toBe(20);

      // PMF should have bins (may be fewer due to normalization/compaction)
      expect(pmfBinCount).toBeGreaterThan(0);
      expect(pmfBinCount).toBeLessThanOrEqual(20);
    });
  });

  describe("PMF support() Method", () => {
    it("should return sorted array of damage values for simple dice", () => {
      const expr = "d6";
      const pmf = parse(expr);
      const support = pmf.support();

      // d6 should have support [1, 2, 3, 4, 5, 6]
      expect(support).toEqual([1, 2, 3, 4, 5, 6]);
      expect(support).toHaveLength(6);
    });

    it("should return sorted array for complex expressions", () => {
      const expr = "2d4 + 1";
      const pmf = parse(expr);
      const support = pmf.support();

      // 2d4 + 1 should have support [3, 4, 5, 6, 7, 8, 9]
      // (2*1 + 1 = 3, 2*4 + 1 = 9)
      expect(support[0]).toBe(3); // minimum
      expect(support[support.length - 1]).toBe(9); // maximum
      expect(support).toHaveLength(7);
    });

    it("should cache support results for performance", () => {
      const expr = "d20";
      const pmf = parse(expr);

      // First call should compute and cache
      const support1 = pmf.support();
      expect(support1).toHaveLength(20);

      // Second call should use cached result
      const support2 = pmf.support();
      expect(support2).toBe(support1);
      expect(support2).toEqual(support1);
    });

    it("should maintain sorted order for various dice combinations", () => {
      const testCases = [
        { expr: "d10", expectedLength: 10, expectedMin: 1, expectedMax: 10 },
        { expr: "3d6", expectedLength: 16, expectedMin: 3, expectedMax: 18 },
        { expr: "d100", expectedLength: 100, expectedMin: 1, expectedMax: 100 },
      ];

      for (const testCase of testCases) {
        const pmf = parse(testCase.expr);
        const support = pmf.support();

        expect(support).toHaveLength(testCase.expectedLength);
        expect(support[0]).toBe(testCase.expectedMin);
        expect(support[support.length - 1]).toBe(testCase.expectedMax);

        // Verify sorted order
        for (let i = 1; i < support.length; i++) {
          expect(support[i]).toBeGreaterThan(support[i - 1]);
        }
      }
    });
  });

  describe("Complex Expression PMF Performance", () => {
    it("should handle complex expressions in PMF test", () => {
      const complexExpr = "(d20 + 6 AC 15) * (2d6 + 4) crit (4d6 + 4)";

      // Should not throw errors
      expect(() => {
        const pmfResult = parse(complexExpr);

        expect(pmfResult).toBeDefined();
      }).not.toThrow();
    });
  });
});
