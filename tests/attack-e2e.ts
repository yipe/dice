import { describe, expect, it } from "vitest";
import { DiceQuery, parse, PMF } from "../src/index";

describe("Complex Attack End-to-End Test", () => {
  const complexExpression =
    "(d20 + 5 AC 10) * (10d8 + 8d6 + 4d4 + 10) crit (20d8 + 8d6 + 8d4 + 10)";

  describe("Single Attack Analysis", () => {
    it("should parse complex attack expression without errors", () => {
      expect(() => parse(complexExpression)).not.toThrow();
    });

    it("should create valid dice result with expected damage ranges", () => {
      const dice = parse(complexExpression);
      expect(dice).toBeDefined();
      expect(dice.mass()).toBeGreaterThan(0);
      expect(dice.min()).toBe(0);
      expect(dice.max()).toBe(250);
    });

    it("should create valid PMF from complex attack dice", () => {
      const pmf = parse(complexExpression);
      expect(pmf).toBeInstanceOf(PMF);
      let totalProbability = pmf.mass();
      expect(totalProbability).toBeCloseTo(1, 10);
    });

    it("should have reasonable single attack statistics", () => {
      const pmf = parse(complexExpression);
      const singleQuery = pmf.query();

      // Single attack should have much lower DPR than 4 attacks
      const singleDPR = singleQuery.mean();
      expect(singleDPR).toBeGreaterThan(60); // Reasonable minimum for high-level attack
      expect(singleDPR).toBeLessThan(100); // Should be less than expected 4-attack total

      const hitChance = singleQuery.probabilityOf(["hit", "crit"]);
      expect(hitChance).toBeCloseTo(0.8, 3);
      expect(hitChance).toBeLessThan(1.0);
    });
  });

  describe("Four PMFs combination - power() test", () => {
    it("should successfully combine 4 attack PMFs", () => {
      const pmf = parse(complexExpression);

      const fourPMFs = pmf.power(4);
      expect(fourPMFs).toBeInstanceOf(PMF);
      expect(fourPMFs.max()).toBe(1000);
    });
  });

  describe("Expected Values Verification", () => {
    it("should produce expected DPR of approximately 308.6 with chaining", () => {
      const actualDPR = parse(complexExpression).power(4).mean();
      expect(actualDPR).toBeCloseTo(308.6, 1);
    });

    it("should NOT produduce expected hit chance if we use power", () => {
      const pmf = parse(complexExpression);
      const query = new DiceQuery(pmf.power(4));

      // This is illegal because power() doesn't preserve provenance
      const actualHitChance = query.probAtLeastOne(["hit", "crit"]);
      expect(query.singles[0].preservedProvenance()).toBe(false);
      expect(actualHitChance).toBeGreaterThan(1);
    });

    it("should produce expected hit chance of approximately 99.84%", () => {
      const pmf = parse(complexExpression);
      const query = new DiceQuery([pmf, pmf, pmf, pmf]);
      const actualHitChance = query.probAtLeastOne(["hit", "crit"]);
      expect(query.singles[0].preservedProvenance()).toBe(true);
      expect(actualHitChance).toBeCloseTo(0.9984, 3);
    });

    it("should produce expected hit chance of approximately 99.84% with replicate()", () => {
      const pmf = parse(complexExpression);
      const query = new DiceQuery(pmf.replicate(4));
      const actualHitChance = query.probAtLeastOne(["hit", "crit"]);
      expect(actualHitChance).toBeCloseTo(0.9984, 3);
    });

    it("should produce expected crit chance of approximately 18.55%", () => {
      const pmfs = parse(complexExpression).replicate(4);
      const actualCritChance = new DiceQuery(pmfs).probAtLeastOne("crit");
      expect(actualCritChance).toBeCloseTo(0.1855, 3);
    });

    it("should produce expected standard deviation of approximately 82.4", () => {
      const pmf = parse(complexExpression);
      const actualStdDev = new DiceQuery(pmf.replicate(4)).stddev();
      expect(actualStdDev).toBeCloseTo(82.4, 1);
    });

    it("should have all statistics within reasonable ranges", () => {
      const pmf = parse(complexExpression);
      const query = new DiceQuery(pmf.replicate(4));

      const mean = query.mean();
      const stdev = query.stddev();
      const min = query.min();
      const max = query.max();
      const hitChance = query.probAtLeastOne(["hit", "crit"]);
      const critChance = query.probAtLeastOne("crit");

      // Basic sanity checks
      expect(mean).toBeGreaterThan(min);
      expect(mean).toBeLessThan(max);
      expect(mean).toBeCloseTo(308.6, 1);
      expect(stdev).toBeCloseTo(82.4, 1);
      expect(hitChance).toBeCloseTo(0.9984, 3);
      expect(critChance).toBeCloseTo(0.1855, 3);
      expect(critChance).toBeLessThan(hitChance);
    });
  });

  describe("Attack Component Analysis", () => {
    it("should properly track hit vs crit outcomes", () => {
      const pmf = parse(complexExpression);
      const query = new DiceQuery(pmf.replicate(4));

      const hitDamage = query.expectedDamageFrom("hit");
      const critDamage = query.expectedDamageFrom("crit");
      const totalDamage = query.mean();

      expect(hitDamage).toBeCloseTo(279, 1);
      expect(critDamage).toBeCloseTo(29.6, 1);

      // Combined should approximately equal total (accounting for misses)
      expect(hitDamage + critDamage).toBeCloseTo(totalDamage, 1);
    });

    it("should show expected probability distributions", () => {
      const pmf = parse(complexExpression);

      const fourPMFs = pmf.replicate(4);
      const query = new DiceQuery(fourPMFs);

      const prob0Hits = query.probExactlyK(["hit", "crit"], 0); // All miss
      const prob4Hits = query.probExactlyK(["hit", "crit"], 4); // All hit/crit

      expect(prob0Hits).toBeLessThan(0.01);
      expect(prob4Hits).toBeGreaterThan(0.3);

      let totalProb = 0;
      for (let k = 0; k <= 4; k++) {
        totalProb += query.probExactlyK(["hit", "crit"], k);
      }
      expect(totalProb).toBeCloseTo(1, 10);
    });
  });

  describe("Performance and Edge Cases", () => {
    it("should handle the complex calculation efficiently", () => {
      const startTime = performance.now();
      const pmf = parse(complexExpression);
      const fourPMFs = pmf.replicate(4);
      const query = new DiceQuery(fourPMFs);

      query.mean();
      query.stddev();
      query.probAtLeastOne(["hit", "crit"]);
      query.probAtLeastOne("crit");

      const endTime = performance.now();
      const duration = endTime - startTime;

      // Less than 10ms. Currently runs in 1ms on an M3 Macbook.
      expect(duration).toBeLessThan(10);
    });

    it("should produce stable results across multiple runs", () => {
      // Run the same calculation multiple times to ensure consistency
      const results: number[] = [];

      for (let i = 0; i < 3; i++) {
        const pmf = parse(complexExpression);
        const query = new DiceQuery(pmf.replicate(3));
        results.push(query.mean());
      }

      // All results should be identical (deterministic calculation)
      for (let i = 1; i < results.length; i++) {
        expect(results[i]).toEqual(results[0]);
      }
    });
  });
});
