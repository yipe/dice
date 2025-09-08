import { beforeEach, describe, expect, it } from "vitest";
import {
  clearParserCache,
  getCachingEnabled,
  parse,
  setCachingEnabled,
} from "../src/parser";

describe("Parser Cache Control", () => {
  beforeEach(() => {
    // Reset cache state before each test
    setCachingEnabled(true);
    clearParserCache();
  });

  describe("Cache Enable/Disable", () => {
    it("should start with caching enabled by default", () => {
      expect(getCachingEnabled()).toBe(true);
    });

    it("should disable caching when setCachingEnabled(false) is called", () => {
      setCachingEnabled(false);
      expect(getCachingEnabled()).toBe(false);
    });

    it("should enable caching when setCachingEnabled(true) is called", () => {
      setCachingEnabled(false);
      setCachingEnabled(true);
      expect(getCachingEnabled()).toBe(true);
    });

    it("should be idempotent - multiple calls to setCachingEnabled(true) should work", () => {
      setCachingEnabled(true);
      setCachingEnabled(true);
      setCachingEnabled(true);
      expect(getCachingEnabled()).toBe(true);
    });

    it("should be idempotent - multiple calls to setCachingEnabled(false) should work", () => {
      setCachingEnabled(false);
      setCachingEnabled(false);
      setCachingEnabled(false);
      expect(getCachingEnabled()).toBe(false);
    });
  });

  describe("Cache Behavior", () => {
    it("should return identical PMF objects when caching is enabled", () => {
      setCachingEnabled(true);
      const result1 = parse("d6+3");
      const result2 = parse("d6+3");

      // Should be the same object reference due to caching
      expect(result1).toBe(result2);
    });

    it("should return different PMF objects when caching is disabled", () => {
      setCachingEnabled(false);
      const result1 = parse("d6+3");
      const result2 = parse("d6+3");

      // Should be different object references
      expect(result1).not.toBe(result2);
      // But should have identical values
      expect(result1.min()).toBe(result2.min());
      expect(result1.max()).toBe(result2.max());
      expect(result1.mass()).toBeCloseTo(result2.mass(), 12);
    });

    it("should use different cache keys for different expressions", () => {
      setCachingEnabled(true);
      const result1 = parse("d6");
      const result2 = parse("d8");
      const result3 = parse("d6");

      expect(result1).not.toBe(result2);
      expect(result1).toBe(result3); // Same expression should be cached
    });

    it("should use different cache keys for different n parameters", () => {
      setCachingEnabled(true);
      const result1 = parse("d6", 0);
      const result2 = parse("d6", 1);
      const result3 = parse("d6", 0);

      expect(result1).not.toBe(result2);
      expect(result1).toBe(result3); // Same expression and n should be cached
    });

    it("should clear cache when setCachingEnabled(false) is called", () => {
      setCachingEnabled(true);
      const result1 = parse("d6+3");

      setCachingEnabled(false);
      setCachingEnabled(true);

      const result2 = parse("d6+3");

      // Cache should have been cleared, so different objects
      expect(result1).not.toBe(result2);
    });

    it("should clear cache when clearCache() is called explicitly", () => {
      setCachingEnabled(true);
      const result1 = parse("d6+3");

      clearParserCache();

      const result2 = parse("d6+3");

      // Cache should have been cleared, so different objects
      expect(result1).not.toBe(result2);
    });
  });

  describe("Cache Edge Cases", () => {
    it("should handle whitespace normalization in cache keys", () => {
      setCachingEnabled(true);
      const result1 = parse("d6 + 3");
      const result2 = parse("d6+3");
      const result3 = parse(" d6  +  3 ");

      // All should be cached as the same expression due to whitespace normalization
      expect(result1).toEqual(result2);
      expect(result2).toEqual(result3);
    });

    it("should handle case insensitivity in cache keys", () => {
      setCachingEnabled(true);
      const result1 = parse("d6");
      const result2 = parse("D6");
      const result3 = parse("d6");

      // All should be cached as the same expression due to case normalization
      expect(result1).toBe(result2);
      expect(result2).toBe(result3);
    });

    it("should work correctly when toggling cache state multiple times", () => {
      // Start with cache enabled
      setCachingEnabled(true);
      const result1 = parse("d20");
      const result2 = parse("d20");
      expect(result1).toBe(result2);

      // Disable cache
      setCachingEnabled(false);
      const result3 = parse("d20");
      const result4 = parse("d20");
      expect(result3).not.toBe(result4);

      // Re-enable cache
      setCachingEnabled(true);
      const result5 = parse("d20");
      const result6 = parse("d20");
      expect(result5).toBe(result6);

      // All cached results should be different from non-cached ones
      expect(result1).not.toBe(result3);
      expect(result1).not.toBe(result5);
      expect(result3).not.toBe(result5);
    });
  });

  describe("Cache Performance Invariants", () => {
    it("should maintain mathematical correctness regardless of cache state", () => {
      const expressions = ["d6", "2d8+3", "d20!", "d12 reroll 1"];

      for (const expr of expressions) {
        setCachingEnabled(true);
        const cachedResult = parse(expr);

        setCachingEnabled(false);
        const uncachedResult = parse(expr);

        // Results should be mathematically equivalent
        expect(cachedResult.min()).toBe(uncachedResult.min());
        expect(cachedResult.max()).toBe(uncachedResult.max());
        expect(cachedResult.mass()).toBeCloseTo(uncachedResult.mass(), 12);
        expect(cachedResult.mean()).toBeCloseTo(uncachedResult.mean(), 12);
        expect(cachedResult.support()).toEqual(uncachedResult.support());
      }
    });
  });
});
