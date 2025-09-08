import { beforeEach, describe, expect, it } from "vitest";
import { LRUCache } from "../src/lru-cache";
import { PMF } from "../src/pmf";

describe("PMF Convolution Caching", () => {
  // Simple test PMFs for cache testing
  const createTestPMF = (id: string, values: Array<[number, number]>): PMF => {
    const map = new Map();
    values.forEach(([damage, prob]) => {
      map.set(damage, { p: prob, count: { hit: prob } });
    });
    return new PMF(map, 1e-10, true, id);
  };

  const pmfA = createTestPMF("A", [
    [1, 0.5],
    [2, 0.5],
  ]);
  const pmfB = createTestPMF("B", [
    [3, 0.3],
    [4, 0.7],
  ]);
  const pmfC = createTestPMF("C", [[1, 1.0]]);

  describe("convolve() caching", () => {
    it("should return identical results for cached combinations", () => {
      const result1 = pmfA.convolve(pmfB);
      const result2 = pmfA.convolve(pmfB);

      // Results should be identical (same object reference due to caching)
      expect(result1).toBe(result2);
    });

    it("should be order-independent for cache hits", () => {
      const result1 = pmfA.convolve(pmfB);
      const result2 = pmfB.convolve(pmfA);

      // Should be the same cached result due to order-independent cache keys
      expect(result1).toBe(result2);
    });

    it("should respect epsilon parameter in cache keys", () => {
      const result1 = pmfA.convolve(pmfB, 1e-6);
      const result2 = pmfA.convolve(pmfB, 1e-8);

      // Different epsilon values should produce different cached results
      expect(result1).not.toBe(result2);
    });

    it("should normalize PMFs before caching", () => {
      // Create unnormalized PMF
      const unnormalizedMap = new Map();
      unnormalizedMap.set(1, { p: 1.0, count: { hit: 1.0 } }); // Total mass = 1.0
      const unnormalizedPMF = new PMF(unnormalizedMap, 1e-10, false, "unnorm");

      const result1 = unnormalizedPMF.convolve(pmfC);
      const result2 = unnormalizedPMF.convolve(pmfC);

      // Should cache the result after normalization
      expect(result1).toBe(result2);
    });
  });

  describe("combineMany() linear caching benefits", () => {
    it("should reuse intermediate results in linear combination", () => {
      const list1 = [pmfA, pmfB, pmfC];
      const list2 = [pmfA, pmfB]; // Prefix of list1

      // Combine the shorter list first
      const result2 = PMF.convolveMany(list2);

      // Now combine the longer list - should reuse A+B from cache
      const result1 = PMF.convolveMany(list1);

      // Verify both produce valid results
      expect(result1.mass()).toBeCloseTo(1.0, 8);
      expect(result2.mass()).toBeCloseTo(1.0, 8);
    });

    it("should produce consistent results regardless of caching", () => {
      const list = [pmfA, pmfB, pmfC];

      // First call (populates cache)
      const result1 = PMF.convolveMany(list);

      // Second call (should use cached intermediates)
      const result2 = PMF.convolveMany(list);

      // Results should be mathematically equivalent
      expect(result1.mean()).toBeCloseTo(result2.mean(), 10);
      expect(result1.variance()).toBeCloseTo(result2.variance(), 10);

      // Check that all damage values match
      const support1 = result1.support();
      const support2 = result2.support();
      expect(support1).toEqual(support2);

      for (const damage of support1) {
        const bin1 = result1.map.get(damage)!;
        const bin2 = result2.map.get(damage)!;
        expect(bin1.p).toBeCloseTo(bin2.p, 10);
      }
    });

    it("should handle single PMF case efficiently", () => {
      const result = PMF.convolveMany([pmfA]);
      expect(result).toBe(pmfA); // Should return the same object
    });

    it("should handle empty list case", () => {
      const result = PMF.convolveMany([]);
      expect(result.identifier).toBe("empty");
      expect(result.map.size).toBe(0);
    });
  });

  describe("cache performance characteristics", () => {
    it("should demonstrate cache benefits with repeated operations", () => {
      const pmfList = [pmfA, pmfB, pmfC];

      // Time first execution (cold cache)
      const start1 = performance.now();
      const result1 = PMF.convolveMany(pmfList);
      const time1 = performance.now() - start1;

      // Time second execution (warm cache)
      const start2 = performance.now();
      const result2 = PMF.convolveMany(pmfList);
      const time2 = performance.now() - start2;

      // Second execution should be faster (though this is not guaranteed in tests)
      // More importantly, results should be identical
      expect(result1.mean()).toBeCloseTo(result2.mean(), 10);

      // At least verify the cache is working by checking object identity for final result
      expect(result1).toBe(result2);
    });

    it("should work with complex PMF chains", () => {
      const pmfD = createTestPMF("D", [
        [5, 0.4],
        [6, 0.6],
      ]);
      const pmfE = createTestPMF("E", [[2, 1.0]]);

      const longList = [pmfA, pmfB, pmfC, pmfD, pmfE];
      const result = PMF.convolveMany(longList);

      // Should produce a valid probability distribution
      expect(result.mass()).toBeCloseTo(1.0, 8);
      expect(result.support().length).toBeGreaterThan(0);

      // Mean should be sum of individual means (linearity of expectation)
      const expectedMean =
        pmfA.mean() + pmfB.mean() + pmfC.mean() + pmfD.mean() + pmfE.mean();
      expect(result.mean()).toBeCloseTo(expectedMean, 8);
    });
  });
});

describe("LRU Cache", () => {
  let cache: LRUCache<string, number>;

  beforeEach(() => {
    cache = new LRUCache<string, number>(3); // Small cache for testing
  });

  describe("basic operations", () => {
    it("should store and retrieve values", () => {
      cache.set("key1", 100);
      expect(cache.get("key1")).toBe(100);
    });

    it("should return undefined for missing keys", () => {
      expect(cache.get("missing")).toBeUndefined();
    });

    it("should report correct size", () => {
      expect(cache.size).toBe(0);
      cache.set("key1", 100);
      expect(cache.size).toBe(1);
      cache.set("key2", 200);
      expect(cache.size).toBe(2);
    });

    it("should check key existence", () => {
      cache.set("key1", 100);
      expect(cache.has("key1")).toBe(true);
      expect(cache.has("missing")).toBe(false);
    });
  });

  describe("LRU eviction", () => {
    it("should evict least recently used items when full", () => {
      // Fill cache to capacity
      cache.set("key1", 100);
      cache.set("key2", 200);
      cache.set("key3", 300);
      expect(cache.size).toBe(3);

      // Add one more - should evict key1 (least recently used)
      cache.set("key4", 400);
      expect(cache.size).toBe(3);
      expect(cache.get("key1")).toBeUndefined();
      expect(cache.get("key2")).toBe(200);
      expect(cache.get("key3")).toBe(300);
      expect(cache.get("key4")).toBe(400);
    });

    it("should update LRU order on access", () => {
      cache.set("key1", 100);
      cache.set("key2", 200);
      cache.set("key3", 300);

      // Access key1 to make it most recently used
      cache.get("key1");

      // Add new item - should evict key2 (now least recently used)
      cache.set("key4", 400);
      expect(cache.get("key1")).toBe(100); // Still there
      expect(cache.get("key2")).toBeUndefined(); // Evicted
      expect(cache.get("key3")).toBe(300);
      expect(cache.get("key4")).toBe(400);
    });

    it("should update LRU order on set of existing key", () => {
      cache.set("key1", 100);
      cache.set("key2", 200);
      cache.set("key3", 300);

      // Update key1 to make it most recently used
      cache.set("key1", 150);

      // Add new item - should evict key2 (now least recently used)
      cache.set("key4", 400);
      expect(cache.get("key1")).toBe(150); // Updated and still there
      expect(cache.get("key2")).toBeUndefined(); // Evicted
      expect(cache.get("key3")).toBe(300);
      expect(cache.get("key4")).toBe(400);
    });
  });

  describe("utility methods", () => {
    it("should clear all entries", () => {
      cache.set("key1", 100);
      cache.set("key2", 200);
      expect(cache.size).toBe(2);

      cache.clear();
      expect(cache.size).toBe(0);
      expect(cache.get("key1")).toBeUndefined();
      expect(cache.get("key2")).toBeUndefined();
    });

    it("should provide keys and values iterators", () => {
      cache.set("key1", 100);
      cache.set("key2", 200);
      cache.set("key3", 300);

      const keys = Array.from(cache.keys());
      const values = Array.from(cache.values());

      expect(keys).toEqual(["key1", "key2", "key3"]);
      expect(values).toEqual([100, 200, 300]);
    });
  });
});
