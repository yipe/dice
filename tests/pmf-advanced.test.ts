import { beforeEach, describe, expect, it } from "vitest";
import { Bin, EPS, PMF } from "../src/index";

// Helper function to create a uniform die PMF
function uniformDie(sides: number): PMF {
  const m = new Map<number, Bin>();
  for (let i = 1; i <= sides; i++) {
    m.set(i, { p: 1 / sides, count: {} });
  }
  return new PMF(m, EPS, true);
}

// Helper function to create PMF from simple distribution
function pmfFrom(map: Record<number, number>, label?: string): PMF {
  const m = new Map<number, Bin>();
  let Z = 0;
  for (const [, v] of Object.entries(map)) Z += v;
  for (const [k, v] of Object.entries(map)) {
    const p = v / Z;
    const count: Record<string, number> = {};
    if (label) count[label] = p;
    m.set(Number(k), { p, count });
  }
  return new PMF(m, EPS, true);
}

describe("PMF Advanced Operations", () => {
  let d6: PMF;
  let d4: PMF;

  beforeEach(() => {
    d6 = uniformDie(6);
    d4 = uniformDie(4);
  });

  describe("power", () => {
    it("should calculate power correctly for small exponents", () => {
      const squared = d6.power(2);

      expect(squared.min()).toBe(2); // 1+1
      expect(squared.max()).toBe(12); // 6+6
      expect(squared.mass()).toBeCloseTo(1, 12);
    });

    it("should return original PMF for power of 1", () => {
      const power1 = d6.power(1);

      expect(power1).toBe(d6); // Should be same object
    });

    it("should throw for non-positive integers", () => {
      expect(() => d6.power(0)).toThrow(
        "power(n): n must be a positive integer"
      );
      expect(() => d6.power(-1)).toThrow(
        "power(n): n must be a positive integer"
      );
      expect(() => d6.power(1.5)).toThrow(
        "power(n): n must be a positive integer"
      );
    });

    it("should handle large exponents efficiently", () => {
      const power8 = d6.power(8);

      expect(power8.min()).toBe(8); // 8 * 1
      expect(power8.max()).toBe(48); // 8 * 6
      expect(power8.mass()).toBeCloseTo(1, 10);
    });

    it("should preserve normalization", () => {
      const unnormalized = pmfFrom({ 1: 2, 2: 4 }); // Total mass = 6
      const power2 = unnormalized.power(2);

      expect(power2.mass()).toBeCloseTo(1, 12); // Should be normalized
    });

    it("should use caching for repeated calculations", () => {
      const power1 = d6.power(3);
      const power2 = d6.power(3);

      expect(power1).toBe(power2); // Should be cached
    });

    it("should respect epsilon parameter", () => {
      const power1 = d6.power(2, 1e-6);
      const power2 = d6.power(2, 1e-8);

      expect(power1).not.toBe(power2); // Different epsilon, different cache
    });

    it("should handle mathematical properties correctly", () => {
      // (d6^2)^2 should have similar distribution to d6^4
      const power2squared = d6.power(2).power(2);
      const power4 = d6.power(4);

      expect(power2squared.min()).toBe(power4.min());
      expect(power2squared.max()).toBe(power4.max());
      expect(power2squared.mass()).toBeCloseTo(power4.mass(), 10);
    });
  });

  describe("replicate", () => {
    it("should return array of identical PMFs", () => {
      const replicated = d6.replicate(3);

      expect(replicated).toHaveLength(3);
      expect(replicated[0]).toBe(d6);
      expect(replicated[1]).toBe(d6);
      expect(replicated[2]).toBe(d6);
    });

    it("should return single PMF array for n=1", () => {
      const replicated = d6.replicate(1);

      expect(replicated).toEqual([d6]);
    });

    it("should throw for non-positive integers", () => {
      expect(() => d6.replicate(0)).toThrow(
        "combineN(n): n must be a positive integer"
      );
      expect(() => d6.replicate(-1)).toThrow(
        "combineN(n): n must be a positive integer"
      );
      expect(() => d6.replicate(2.5)).toThrow(
        "combineN(n): n must be a positive integer"
      );
    });

    it("should handle large replication counts", () => {
      const replicated = d6.replicate(100);

      expect(replicated).toHaveLength(100);
      expect(replicated.every((pmf) => pmf === d6)).toBe(true);
    });
  });

  describe("Statistical Methods", () => {
    describe("mean", () => {
      it("should calculate mean correctly for uniform die", () => {
        expect(d6.mean()).toBeCloseTo(3.5, 12); // (1+2+3+4+5+6)/6
        expect(d4.mean()).toBeCloseTo(2.5, 12); // (1+2+3+4)/4
      });

      it("should handle weighted distributions", () => {
        const weighted = pmfFrom({ 1: 1, 6: 3 }); // 25% chance of 1, 75% chance of 6
        const expectedMean = 1 * 0.25 + 6 * 0.75; // 4.75

        expect(weighted.mean()).toBeCloseTo(expectedMean, 12);
      });

      it("should cache results", () => {
        const mean1 = d6.mean();
        const mean2 = d6.mean();

        expect(mean1).toBe(mean2);
      });

      it("should handle zero-probability outcomes", () => {
        const withZero = pmfFrom({ 0: 1, 5: 1 }); // 50% 0, 50% 5
        expect(withZero.mean()).toBeCloseTo(2.5, 12);
      });

      it("should handle negative values", () => {
        const withNegative = pmfFrom({ [-2]: 1, 4: 1 }); // 50% -2, 50% 4
        expect(withNegative.mean()).toBeCloseTo(1, 12);
      });
    });

    describe("variance", () => {
      it("should calculate variance correctly for uniform die", () => {
        // d6 variance: E[X²] - (E[X])² where E[X] = 3.5
        // E[X²] = (1² + 2² + 3² + 4² + 5² + 6²)/6 = 91/6
        // Variance = 91/6 - 3.5² = 91/6 - 12.25 = 2.916...
        expect(d6.variance()).toBeCloseTo(2.916666666666667, 10);
      });

      it("should be 0 for constant distribution", () => {
        const constant = pmfFrom({ 5: 1 });
        expect(constant.variance()).toBe(0);
      });

      it("should handle two-value distribution", () => {
        const binary = pmfFrom({ 0: 1, 10: 1 }); // Mean = 5
        // Variance = 0.5 * (0-5)² + 0.5 * (10-5)² = 0.5 * 25 + 0.5 * 25 = 25
        expect(binary.variance()).toBeCloseTo(25, 12);
      });

      it("should cache results", () => {
        const var1 = d6.variance();
        const var2 = d6.variance();

        expect(var1).toBe(var2);
      });

      it("should handle fractional probabilities", () => {
        const fractional = pmfFrom({ 1: 0.3, 2: 0.7 });
        const mean = 1 * 0.3 + 2 * 0.7; // 1.7
        const variance = 0.3 * (1 - 1.7) ** 2 + 0.7 * (2 - 1.7) ** 2;

        expect(fractional.variance()).toBeCloseTo(variance, 12);
      });
    });

    describe("stdev", () => {
      it("should be square root of variance", () => {
        const variance = d6.variance();
        const stdev = d6.stdev();

        expect(stdev).toBeCloseTo(Math.sqrt(variance), 12);
      });

      it("should be 0 for constant distribution", () => {
        const constant = pmfFrom({ 7: 1 });
        expect(constant.stdev()).toBe(0);
      });

      it("should cache results", () => {
        const stdev1 = d6.stdev();
        const stdev2 = d6.stdev();

        expect(stdev1).toBe(stdev2);
      });

      it("should handle typical dice correctly", () => {
        expect(d6.stdev()).toBeCloseTo(1.707825127659933, 10);
        expect(d4.stdev()).toBeCloseTo(1.118033988749895, 10);
      });
    });
  });

  describe("Transformation Methods", () => {
    describe("mapDamage", () => {
      it("should transform damage values correctly", () => {
        const doubled = d6.mapDamage((x) => x * 2);

        expect(doubled.min()).toBe(2);
        expect(doubled.max()).toBe(12);
        expect(doubled.mass()).toBeCloseTo(1, 12);
      });

      it("should preserve probabilities", () => {
        const shifted = d6.mapDamage((x) => x + 10);

        for (let i = 1; i <= 6; i++) {
          expect(shifted.pAt(i + 10)).toBeCloseTo(1 / 6, 12);
        }
      });

      it("should handle complex transformations", () => {
        const squared = d6.mapDamage((x) => x * x);

        expect(squared.support()).toEqual([1, 4, 9, 16, 25, 36]);
        expect(squared.pAt(1)).toBeCloseTo(1 / 6, 12);
        expect(squared.pAt(36)).toBeCloseTo(1 / 6, 12);
      });

      it("should merge identical transformed values", () => {
        const modulo = d6.mapDamage((x) => x % 3);

        // Values 1,4 -> 1; 2,5 -> 2; 3,6 -> 0
        expect(modulo.pAt(0)).toBeCloseTo(2 / 6, 12); // faces 3,6
        expect(modulo.pAt(1)).toBeCloseTo(2 / 6, 12); // faces 1,4
        expect(modulo.pAt(2)).toBeCloseTo(2 / 6, 12); // faces 2,5
      });

      it("should preserve count and attr data", () => {
        const labeled = pmfFrom({ 1: 1, 6: 1 }, "crit");
        const transformed = labeled.mapDamage((x) => x * 2);

        expect(transformed.outcomeAt(2, "crit")).toBeCloseTo(0.5, 12);
        expect(transformed.outcomeAt(12, "crit")).toBeCloseTo(0.5, 12);
      });

      it("should handle zero and negative transformations", () => {
        const zeroOut = d6.mapDamage((x) => (x > 3 ? 0 : x));

        expect(zeroOut.pAt(0)).toBeCloseTo(3 / 6, 12); // faces 4,5,6 -> 0
        expect(zeroOut.pAt(1)).toBeCloseTo(1 / 6, 12);
        expect(zeroOut.pAt(2)).toBeCloseTo(1 / 6, 12);
        expect(zeroOut.pAt(3)).toBeCloseTo(1 / 6, 12);
      });

      it("should update identifier", () => {
        const original = d6.identifier;
        const mapped = d6.mapDamage((x) => x + 1);

        expect(mapped.identifier).toContain("map");
        expect(mapped.identifier).toContain(original);
      });
    });

    describe("scaleDamage", () => {
      it("should scale and floor by default", () => {
        const halfDamage = d6.scaleDamage(0.5);

        // 1*0.5=0.5->0, 2*0.5=1->1, 3*0.5=1.5->1, 4*0.5=2->2, 5*0.5=2.5->2, 6*0.5=3->3
        expect(halfDamage.support()).toEqual([0, 1, 2, 3]);
        expect(halfDamage.pAt(0)).toBeCloseTo(1 / 6, 12); // face 1
        expect(halfDamage.pAt(1)).toBeCloseTo(2 / 6, 12); // faces 2,3
        expect(halfDamage.pAt(2)).toBeCloseTo(2 / 6, 12); // faces 4,5
        expect(halfDamage.pAt(3)).toBeCloseTo(1 / 6, 12); // face 6
      });

      it("should handle ceil rounding", () => {
        const halfDamageCeil = d6.scaleDamage(0.5, "ceil");

        // 1*0.5=0.5->1, 2*0.5=1->1, 3*0.5=1.5->2, 4*0.5=2->2, 5*0.5=2.5->3, 6*0.5=3->3
        expect(halfDamageCeil.support()).toEqual([1, 2, 3]);
        expect(halfDamageCeil.pAt(1)).toBeCloseTo(2 / 6, 12); // faces 1,2
        expect(halfDamageCeil.pAt(2)).toBeCloseTo(2 / 6, 12); // faces 3,4
        expect(halfDamageCeil.pAt(3)).toBeCloseTo(2 / 6, 12); // faces 5,6
      });

      it("should handle round rounding", () => {
        const halfDamageRound = d6.scaleDamage(0.5, "round");

        // 1*0.5=0.5->1, 2*0.5=1->1, 3*0.5=1.5->2, 4*0.5=2->2, 5*0.5=2.5->3, 6*0.5=3->3
        expect(halfDamageRound.support()).toEqual([1, 2, 3]);
        expect(halfDamageRound.pAt(1)).toBeCloseTo(2 / 6, 12);
        expect(halfDamageRound.pAt(2)).toBeCloseTo(2 / 6, 12);
        expect(halfDamageRound.pAt(3)).toBeCloseTo(2 / 6, 12);
      });

      it("should handle scaling up", () => {
        const doubled = d6.scaleDamage(2);

        expect(doubled.min()).toBe(2);
        expect(doubled.max()).toBe(12);
        expect(doubled.support()).toEqual([2, 4, 6, 8, 10, 12]);
      });

      it("should handle zero scaling", () => {
        const zeroed = d6.scaleDamage(0);

        expect(zeroed.support()).toEqual([0]);
        expect(zeroed.pAt(0)).toBeCloseTo(1, 12);
      });

      it("should handle negative scaling", () => {
        const negated = d6.scaleDamage(-1);

        expect(negated.support()).toEqual([-6, -5, -4, -3, -2, -1]);
        expect(negated.min()).toBe(-6);
        expect(negated.max()).toBe(-1);
      });
    });
  });

  describe("Combination Methods", () => {
    describe("add and addScaled", () => {
      it("addScaled mixes a branch instead of convolving", () => {
        const d4 = pmfFrom({ 1: 1, 2: 1, 3: 1, 4: 1 }); // each 0.25
        const d6 = pmfFrom({ 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1 }); // each ≈0.1666667

        const mixed = d4.addScaled(d6, 1); // p = 1.0

        // Mass grows by p
        expect(mixed.mass()).toBeCloseTo(2, 12);

        // Support is union, not sums
        expect(mixed.min()).toBe(1);
        expect(mixed.max()).toBe(6);

        // Example spot checks: p_result(x) = p_d4(x) + 1 * p_d6(x)
        expect(mixed.pAt(1)).toBeCloseTo(0.25 + 1 / 6, 12); // ≈ 0.4166667
        expect(mixed.pAt(4)).toBeCloseTo(0.25 + 1 / 6, 12); // both have 4
        expect(mixed.pAt(5)).toBeCloseTo(0 + 1 / 6, 12);

        // After normalization it becomes a proper PMF
        const norm = mixed.normalize();
        expect(norm.mass()).toBeCloseTo(1, 12);

        // Normalized probabilities divide by 2
        expect(norm.pAt(1)).toBeCloseTo((0.25 + 1 / 6) / 2, 12);
        expect(norm.pAt(5)).toBeCloseTo(1 / 6 / 2, 12);

        // Mean matches mixture formula
        const eD4 = 2.5;
        const eD6 = 3.5;
        expect(norm.mean()).toBeCloseTo((eD4 + 1 * eD6) / (1 + 1), 12); // (2.5+3.5)/2 = 3
      });

      it("should be equivalent to addScaled with factor 1", () => {
        const added = d4.add(d6);
        const scaled = d4.addScaled(d6, 1);

        expect(added.mass()).toBeCloseTo(scaled.mass(), 12);
        expect(added.mean()).toBeCloseTo(scaled.mean(), 12);
      });

      it("should return original PMF when scaling by 0", () => {
        const result = d6.addScaled(d4, 0);
        expect(result).toBe(d6);
      });

      it("should handle scaled addition correctly (mixture semantics)", () => {
        const base = pmfFrom({ 10: 1 }); // p(10) = 1
        const bonus = pmfFrom({ 1: 1, 6: 1 }); // p(1) = 0.5, p(6) = 0.5

        const result = base.addScaled(bonus, 0.3); // mass = 1 + 0.3 = 1.3

        // Unnormalized masses
        expect(result.mass()).toBeCloseTo(1.3, 12);
        expect(result.pAt(10)).toBeCloseTo(1.0, 12);
        expect(result.pAt(1)).toBeCloseTo(0.15, 12); // 0.3 * 0.5
        expect(result.pAt(6)).toBeCloseTo(0.15, 12);

        // If you want a proper PMF, normalize
        const norm = result.normalize();
        expect(norm.mass()).toBeCloseTo(1, 12);
        expect(norm.pAt(10)).toBeCloseTo(1.0 / 1.3, 12); // ≈ 0.76923077
        expect(norm.pAt(1)).toBeCloseTo(0.15 / 1.3, 12); // ≈ 0.11538462
        expect(norm.pAt(6)).toBeCloseTo(0.15 / 1.3, 12); // ≈ 0.11538462
      });
    });

    it("should model '10 baseline plus bonus 30% of rounds' via convolution branch", () => {
      const base = pmfFrom({ 10: 1 }); // delta at 10
      const bonus = pmfFrom({ 1: 1, 6: 1 }); // 50–50 at 1 and 6
      const basePlusBonus = base.convolve(bonus); // delta at 11 and 16, 0.5 each

      const result = base.addScaled(basePlusBonus, 0.3); // keep base mass 1.0, add 0.3 of convolved branch

      expect(result.mass()).toBeCloseTo(1.3, 12);
      expect(result.pAt(10)).toBeCloseTo(1.0, 12);
      expect(result.pAt(11)).toBeCloseTo(0.15, 12);
      expect(result.pAt(16)).toBeCloseTo(0.15, 12);

      const norm = result.normalize();
      expect(norm.mass()).toBeCloseTo(1, 12);
      expect(norm.pAt(10)).toBeCloseTo(1.0 / 1.3, 12); // ≈ 0.76923077
      expect(norm.pAt(11)).toBeCloseTo(0.15 / 1.3, 12); // ≈ 0.11538462
      expect(norm.pAt(16)).toBeCloseTo(0.15 / 1.3, 12); // ≈ 0.11538462
    });

    describe("scaleMass", () => {
      it("should scale all probabilities by factor", () => {
        const scaled = d6.scaleMass(0.5);

        expect(scaled.mass()).toBeCloseTo(0.5, 12);
        for (let i = 1; i <= 6; i++) {
          expect(scaled.pAt(i)).toBeCloseTo(0.5 / 6, 12);
        }
      });

      it("should return original PMF when factor is 1", () => {
        const scaled = d6.scaleMass(1);
        expect(scaled).toBe(d6);
      });

      it("should handle zero scaling", () => {
        const scaled = d6.scaleMass(0);

        expect(scaled.mass()).toBe(0);
        for (let i = 1; i <= 6; i++) {
          expect(scaled.pAt(i)).toBe(0);
        }
      });

      it("should preserve outcome labels proportionally", () => {
        const labeled = pmfFrom({ 1: 1, 6: 1 }, "crit");
        const scaled = labeled.scaleMass(0.25);

        expect(scaled.outcomeAt(1, "crit")).toBeCloseTo(0.125, 12); // 0.5 * 0.25
        expect(scaled.outcomeAt(6, "crit")).toBeCloseTo(0.125, 12);
      });

      it("should update identifier", () => {
        const scaled = d6.scaleMass(0.75);
        expect(scaled.identifier).toContain("scale");
      });
    });
  });

  describe("Probability Query Methods", () => {
    describe("pAt", () => {
      it("should return correct probabilities", () => {
        for (let i = 1; i <= 6; i++) {
          expect(d6.pAt(i)).toBeCloseTo(1 / 6, 12);
        }
      });

      it("should return 0 for non-existent values", () => {
        expect(d6.pAt(0)).toBe(0);
        expect(d6.pAt(7)).toBe(0);
        expect(d6.pAt(100)).toBe(0);
      });

      it("should handle fractional damage values", () => {
        const fractional = pmfFrom({ 1.5: 1, 2.5: 1 });
        expect(fractional.pAt(1.5)).toBeCloseTo(0.5, 12);
        expect(fractional.pAt(2.5)).toBeCloseTo(0.5, 12);
      });
    });

    describe("cdfAt", () => {
      it("should calculate cumulative distribution correctly", () => {
        expect(d6.cdfAt(0)).toBe(0);
        expect(d6.cdfAt(1)).toBeCloseTo(1 / 6, 12);
        expect(d6.cdfAt(3)).toBeCloseTo(3 / 6, 12);
        expect(d6.cdfAt(6)).toBeCloseTo(1, 12);
        expect(d6.cdfAt(10)).toBeCloseTo(1, 12);
      });

      it("should handle fractional thresholds", () => {
        expect(d6.cdfAt(3.5)).toBeCloseTo(3 / 6, 12); // Same as cdfAt(3)
        expect(d6.cdfAt(0.5)).toBe(0); // Below minimum
      });
    });

    describe("quantile", () => {
      it("should return correct quantiles", () => {
        expect(d6.quantile(0)).toBe(1); // Minimum value
        expect(d6.quantile(1 / 6)).toBe(1); // First face
        expect(d6.quantile(0.5)).toBeGreaterThanOrEqual(3); // Median
        expect(d6.quantile(0.5)).toBeLessThanOrEqual(4);
        expect(d6.quantile(1)).toBe(6); // Maximum value
      });

      it("should handle edge cases", () => {
        expect(d6.quantile(0.999)).toBe(6);
        expect(d6.quantile(0.001)).toBe(1);
      });

      it("should return 0 for empty PMF", () => {
        const empty = PMF.empty();
        expect(empty.quantile(0.5)).toBe(0);
      });
    });
  });

  describe("Outcome Analysis Methods", () => {
    describe("outcomeAt", () => {
      it("should return 0 for unlabeled outcomes", () => {
        expect(d6.outcomeAt(1, "crit")).toBe(0);
        expect(d6.outcomeAt(6, "hit")).toBe(0);
      });

      it("should return correct outcome counts", () => {
        const labeled = pmfFrom({ 1: 1, 6: 3 }, "crit");
        expect(labeled.outcomeAt(1, "crit")).toBeCloseTo(0.25, 12);
        expect(labeled.outcomeAt(6, "crit")).toBeCloseTo(0.75, 12);
      });

      it("should handle non-existent damage values", () => {
        const labeled = pmfFrom({ 6: 1 }, "crit");
        expect(labeled.outcomeAt(1, "crit")).toBe(0);
      });
    });

    describe("outcomes", () => {
      it("should return empty array for unlabeled PMF", () => {
        expect(d6.outcomes()).toEqual([]);
      });

      it("should return all outcome labels", () => {
        const multi = new Map<number, Bin>();
        multi.set(1, { p: 0.5, count: { hit: 0.3, crit: 0.2 } });
        multi.set(2, { p: 0.5, count: { miss: 0.5 } });
        const multiPMF = new PMF(multi, 1e-15, true);

        const outcomes = multiPMF.outcomes();
        expect(outcomes).toContain("hit");
        expect(outcomes).toContain("crit");
        expect(outcomes).toContain("miss");
      });

      it("should not return outcomes with zero probability", () => {
        const labeled = new Map<number, Bin>();
        labeled.set(1, { p: 1, count: { hit: 1, miss: 0 } });
        const labeledPMF = new PMF(labeled, 1e-15, true);

        const outcomes = labeledPMF.outcomes();
        expect(outcomes).toContain("hit");
        expect(outcomes).not.toContain("miss");
      });
    });

    describe("outcomeProbability", () => {
      it("should return 0 for non-existent outcomes", () => {
        expect(d6.outcomeProbability("crit")).toBe(0);
      });

      it("should calculate total outcome probability", () => {
        const labeled = pmfFrom({ 1: 1, 6: 3 }, "crit");
        expect(labeled.outcomeProbability("crit")).toBeCloseTo(1, 12);
      });

      it("should handle partial outcome coverage", () => {
        const partial = new Map<number, Bin>();
        partial.set(1, { p: 0.5, count: { crit: 0.2 } }); // Only 40% of this bin is crit
        partial.set(2, { p: 0.5, count: {} }); // No crit here
        const partialPMF = new PMF(partial, 1e-15, true);

        expect(partialPMF.outcomeProbability("crit")).toBeCloseTo(0.2, 12);
      });
    });

    describe("hasOutcome", () => {
      it("should return false for unlabeled PMF", () => {
        expect(d6.hasOutcome("crit")).toBe(false);
        expect(d6.hasOutcome("hit")).toBe(false);
      });

      it("should return true for existing outcomes", () => {
        const labeled = pmfFrom({ 6: 1 }, "crit");
        expect(labeled.hasOutcome("crit")).toBe(true);
        expect(labeled.hasOutcome("hit")).toBe(false);
      });

      it("should return false for zero-probability outcomes", () => {
        const zeroOutcome = new Map<number, Bin>();
        zeroOutcome.set(1, { p: 1, count: { hit: 1, crit: 0 } });
        const zeroOutcomePMF = new PMF(zeroOutcome, 1e-15, true);

        expect(zeroOutcomePMF.hasOutcome("hit")).toBe(true);
        expect(zeroOutcomePMF.hasOutcome("crit")).toBe(false);
      });
    });

    describe("filterOutcome", () => {
      it("should filter to only specified outcome", () => {
        const multi = new Map<number, Bin>();
        multi.set(1, { p: 0.4, count: { hit: 0.3, crit: 0.1 } });
        multi.set(6, { p: 0.6, count: { hit: 0.4, crit: 0.2 } });
        const multiPMF = new PMF(multi, EPS, true);

        const critOnly = multiPMF.filterOutcome("crit");

        expect(critOnly.mass()).toBeCloseTo(0.3, 12); // 0.1 + 0.2
        expect(critOnly.pAt(1)).toBeCloseTo(0.1, 12);
        expect(critOnly.pAt(6)).toBeCloseTo(0.2, 12);

        const norm = critOnly.normalize();
        expect(norm.mass()).toBeCloseTo(1, 12);
        expect(norm.pAt(1)).toBeCloseTo(0.1 / 0.3, 12);
        expect(norm.pAt(6)).toBeCloseTo(0.2 / 0.3, 12);
      });

      it("should return empty PMF for non-existent outcome", () => {
        const filtered = d6.filterOutcome("crit");
        expect(filtered.mass()).toBe(0);
      });

      it("should preserve damage values", () => {
        const labeled = pmfFrom({ 1: 1, 3: 2, 6: 1 }, "hit");
        const filtered = labeled.filterOutcome("hit");

        expect(filtered.support()).toEqual([1, 3, 6]);
      });
    });
  });

  describe("Utility Methods", () => {
    describe("denseSupport", () => {
      it("should return sorted support", () => {
        const sparse = pmfFrom({ 10: 1, 1: 1, 5: 1 });
        expect(sparse.denseSupport()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      });

      it("should return empty array for empty PMF", () => {
        const empty = PMF.empty();
        expect(empty.denseSupport()).toEqual([]);
      });

      it("should handle single value", () => {
        const single = pmfFrom({ 42: 1 });
        expect(single.denseSupport()).toEqual([42]);
      });
    });

    describe("binAt", () => {
      it("should return bin data for existing damage", () => {
        const labeled = pmfFrom({ 6: 1 }, "crit");
        const bin = labeled.binAt(6);

        expect(bin).not.toBeNull();
        expect(bin!.p).toBeCloseTo(1, 12);
        expect(bin!.count.crit).toBeCloseTo(1, 12);
      });

      it("should return null for non-existent damage", () => {
        expect(d6.binAt(10)).toBeNull();
      });

      it("should return copy of bin data", () => {
        const labeled = pmfFrom({ 6: 1 }, "crit");
        const bin1 = labeled.binAt(6);
        const bin2 = labeled.binAt(6);

        expect(bin1).not.toBe(bin2);
        expect(bin1).toEqual(bin2);
      });
    });

    describe("toQuery", () => {
      it("should convert PMF to DiceQuery", () => {
        const query = d6.query();

        expect(query.mean()).toBeCloseTo(d6.mean(), 12);
        expect(query.combined).toBe(d6);
      });

      it("should preserve all PMF properties", () => {
        const labeled = pmfFrom({ 1: 1, 6: 1 }, "crit");
        const query = labeled.query();

        expect(query.probAtLeastOne("crit")).toBeCloseTo(1, 12);
      });
    });
  });

  describe("Edge Cases and Error Handling", () => {
    it("should handle very small probabilities", () => {
      const tiny = pmfFrom({ 1: Number.MIN_VALUE });

      expect(tiny.mass()).toBe(1);
      expect(tiny.mean()).toBe(1);
    });

    it("should handle very large damage values", () => {
      const huge = pmfFrom({ [Number.MAX_SAFE_INTEGER]: 1 });

      expect(huge.max()).toBe(Number.MAX_SAFE_INTEGER);
      expect(huge.mean()).toBe(Number.MAX_SAFE_INTEGER);
    });

    it("should handle fractional damage values", () => {
      const fractional = pmfFrom({ 1.5: 1, 2.7: 1, 3.14159: 1 });

      expect(fractional.support()).toContain(1.5);
      expect(fractional.support()).toContain(2.7);
      expect(fractional.support()).toContain(3.14159);
    });

    it("should handle negative damage values", () => {
      const negative = pmfFrom({ [-10]: 1, 0: 1, 5: 1 });

      expect(negative.min()).toBe(-10);
      expect(negative.max()).toBe(5);
      expect(negative.mean()).toBeCloseTo(-5 / 3, 10);
    });

    it("should maintain precision with many operations", () => {
      let result = d6;
      for (let i = 0; i < 10; i++) {
        result = result.scaleMass(0.9).addScaled(d4, 0.1);
      }

      expect(result.mass()).toBeCloseTo(1, 8); // Should still be normalized
    });

    it("should handle empty PMF operations", () => {
      const empty = PMF.empty();

      expect(empty.mass()).toBe(0);
      expect(empty.mean()).toBe(0);
      expect(empty.variance()).toBe(0);
      expect(empty.stdev()).toBe(0);
      expect(empty.support()).toEqual([]);
    });
  });
});
