import { describe, expect, it } from "vitest";
import { EPS, Mixture, PMF } from "../src/index";

// Helper to create a PMF for a fair die.
const d = (sides: number): PMF => {
  const outcomes = new Map<number, number>();
  for (let i = 1; i <= sides; i++) {
    outcomes.set(i, 1);
  }
  return PMF.fromMap(outcomes);
};

const d4 = d(4);
const d6 = d(6);

describe("Mixture", () => {
  it("should initialize empty", () => {
    const mix = new Mixture();
    expect(mix.size()).toBe(0);
    expect(() => mix.buildPMF()).toThrow("Mixture: zero total mass");
  });

  it("should add a single labeled PMF", () => {
    const mix = new Mixture<"a">().add("a", d4, 1);
    expect(mix.size()).toBe(4);
    expect(mix.hasLabel("a")).toBe(true);

    const pmf = mix.buildPMF();
    expect(pmf.mass()).toBeCloseTo(1, 12);
    for (let i = 1; i <= 4; i++) {
      expect(pmf.pAt(i)).toBeCloseTo(0.25, 12);
      const bin = pmf.map.get(i)!;
      expect(bin.count.a).toBeCloseTo(0.25, 12); // raw mass = 1 * 0.25
    }
  });

  it("should add multiple PMFs with different labels and weights", () => {
    const mix = new Mixture<"hit" | "crit">()
      .add("hit", d4, 0.7)
      .add("crit", d6, 0.3);

    const pmf = mix.buildPMF();
    const totalMass = 0.7 * 1 + 0.3 * 1; // 1.0

    // d4 outcomes (1-4) should have mass from "hit"
    for (let i = 1; i <= 4; i++) {
      const p = pmf.pAt(i);
      const bin = pmf.map.get(i)!;
      const expectedHitMass = 0.7 * (1 / 4);
      const expectedCritMass = i <= 6 ? 0.3 * (1 / 6) : 0;
      expect(p).toBeCloseTo(
        (expectedHitMass + expectedCritMass) / totalMass,
        12
      );
      expect(bin.count.hit).toBeCloseTo(expectedHitMass, 12);
      if (expectedCritMass > 0) {
        expect(bin.count.crit).toBeCloseTo(expectedCritMass, 12);
      }
    }

    // d6 outcomes (5-6) should only have mass from "crit"
    for (let i = 5; i <= 6; i++) {
      const p = pmf.pAt(i);
      const bin = pmf.map.get(i)!;
      const expectedCritMass = 0.3 * (1 / 6);
      expect(p).toBeCloseTo(expectedCritMass / totalMass, 12);
      expect(bin.count.crit).toBeCloseTo(expectedCritMass, 12);
      expect(bin.count.hit).toBeUndefined();
    }
  });

  it("should handle overlapping outcomes by summing mass", () => {
    const mix = new Mixture<"a" | "b">().add("a", d4, 1).add("b", d4, 2);

    const pmf = mix.buildPMF();
    const totalMass = 1 * 1 + 2 * 1; // 3.0

    for (let i = 1; i <= 4; i++) {
      const p = pmf.pAt(i);
      const bin = pmf.map.get(i)!;
      const massA = 1 * (1 / 4);
      const massB = 2 * (1 / 4);
      expect(p).toBeCloseTo((massA + massB) / totalMass, 12);
      expect(bin.count.a).toBeCloseTo(massA, 12);
      expect(bin.count.b).toBeCloseTo(massB, 12);
    }
  });

  it("should ignore additions with zero or negative weight", () => {
    const mix = new Mixture().add("a", d4, 1);
    const jsonBefore = mix.toJSON();
    mix.add("b", d6, 0);
    mix.add("c", d6, -10);
    expect(mix.toJSON()).toEqual(jsonBefore);
    expect(mix.hasLabel("b")).toBe(false);
  });

  it("clear() should reset the state", () => {
    const mix = new Mixture().add("a", d4, 1);
    mix.clear();
    expect(mix.size()).toBe(0);
    expect(mix.hasLabel("a")).toBe(false);
    expect(() => mix.buildPMF()).toThrow();
  });

  it("byOutcome() should produce correct per-label PMFs", () => {
    const mix = new Mixture<"hit" | "miss">()
      .add("hit", d4, 1)
      .add("miss", PMF.delta(0), 1);

    const byLabel = mix.byOutcome();

    expect(Object.keys(byLabel)).toEqual(["hit", "miss"]);

    const hitPmf = byLabel.hit;
    expect(hitPmf.mass()).toBeCloseTo(1, 12);
    expect(hitPmf.support()).toEqual([1, 2, 3, 4]);
    expect(hitPmf.pAt(1)).toBeCloseTo(0.25, 12);

    const missPmf = byLabel.miss;
    expect(missPmf.mass()).toBeCloseTo(1, 12);
    expect(missPmf.support()).toEqual([0]);
    expect(missPmf.pAt(0)).toBeCloseTo(1, 12);
  });

  it("weights() should return normalized label weights", () => {
    const mix = new Mixture<"a" | "b" | "c">()
      .add("a", d4, 1.5)
      .add("b", d6, 3.5)
      .add("c", d4, 0); // should be ignored

    const weights = mix.weights();
    const totalWeight = 1.5 + 3.5;
    expect(weights.a).toBeCloseTo(1.5 / totalWeight, 12);
    expect(weights.b).toBeCloseTo(3.5 / totalWeight, 12);
    expect(weights.c).toBeUndefined();
  });
});

describe("mixLabeled", () => {
  it("should produce the same PMF as the builder", () => {
    const mix = new Mixture<"hit" | "crit">()
      .add("hit", d4, 0.7)
      .add("crit", d6, 0.3);
    const pmf1 = mix.buildPMF();

    const pmf2 = Mixture.mix([
      ["hit", d4, 0.7],
      ["crit", d6, 0.3],
    ]);

    // This is a weak check; could be stronger by comparing maps
    expect(pmf1.mean()).toBeCloseTo(pmf2.mean(), 12);
    expect(pmf1.variance()).toBeCloseTo(pmf2.variance(), 12);
    expect(pmf1.support()).toEqual(pmf2.support());
  });

  it("should handle an empty list of components", () => {
    expect(() => Mixture.mix([])).toThrow("Mixture: zero total mass");
  });
});

describe("Mixture Edge Cases", () => {
  it("should respect custom epsilon for pruning", () => {
    const eps = 0.1;
    const mix = new Mixture(eps);
    // This mass (0.25 * 0.3 = 0.075) is < eps, should be dropped
    mix.add("a", d4, 0.3);
    // This mass (0.25 * 0.5 = 0.125) is > eps, should be kept
    mix.add("b", d4, 0.5);

    expect(mix.hasLabel("a")).toBe(false);
    expect(mix.hasLabel("b")).toBe(true);
    expect(mix.size()).toBe(4); // only from 'b'

    const pmf = mix.buildPMF();
    expect(pmf.pAt(1)).toBeGreaterThan(0);
    const bin = pmf.map.get(1)!;
    expect(bin.count.a).toBeUndefined();
    expect(bin.count.b).toBeDefined();
  });

  it("should handle invalid constructor epsilon", () => {
    // Should default to EPS
    const m1 = new Mixture(Infinity);
    expect((m1 as any).eps).toBeCloseTo(EPS, 12);
    const m2 = new Mixture(-Infinity);
    expect((m2 as any).eps).toBeCloseTo(EPS, 12);
    const m3 = new Mixture(NaN);
    expect((m3 as any).eps).toBeCloseTo(EPS, 12);
  });

  it("should ignore additions with invalid weights", () => {
    const mix = new Mixture().add("a", d4);
    const before = mix.toJSON();
    mix.add("b", d6, NaN);
    mix.add("c", d6, Infinity);
    mix.add("d", d6, -Infinity);
    expect(mix.toJSON()).toEqual(before);
  });

  it("should handle adding an empty PMF", () => {
    const mix = new Mixture().add("a", d4);
    const before = mix.toJSON();
    mix.add("b", PMF.empty());
    expect(mix.toJSON()).toEqual(before);
  });

  it("should sum raw mass when adding same label multiple times", () => {
    const mix = new Mixture<"a">().add("a", d4, 1).add("a", d4, 2);
    const pmf = mix.buildPMF();

    // Total mass is from d4 (weight 1) + d4 (weight 2) = 3
    // For outcome 1 (p=0.25): raw mass = 1*0.25 + 2*0.25 = 0.75
    // Normalized p = (0.75) / 3 = 0.25
    expect(pmf.pAt(1)).toBeCloseTo(0.25, 12);
    const bin = pmf.map.get(1)!;
    expect(bin.count.a).toBeCloseTo(0.75, 12);
  });

  it("weights() should return an empty object for a zero-mass mixture", () => {
    const mix = new Mixture(0.1).add("a", d4, 0.01); // mass pruned
    expect(mix.weights()).toEqual({});
  });
});

describe("Mixture Helpers", () => {
  // It's tricky to test pmfBuildFromMap directly since it's not exported.
  // We can test it indirectly via byOutcome, which uses it.
  it("pmfBuildFromMap (via byOutcome) correctly builds a PMF from a mass map", () => {
    const mix = new Mixture<"a">();
    // Manually construct the internal state that byOutcome would use.
    const labelMass = new Map<number, Record<string, number>>();
    labelMass.set(10, { a: 1 });
    labelMass.set(20, { a: 3 });
    // @ts-expect-error - testing internal behavior
    mix.labelMass = labelMass;

    const pmfs = mix.byOutcome();
    const pmf = pmfs.a;

    expect(pmf.mass()).toBeCloseTo(1.0, 12);
    expect(pmf.pAt(10)).toBeCloseTo(1 / 4, 12);
    expect(pmf.pAt(20)).toBeCloseTo(3 / 4, 12);
    expect(pmf.support()).toEqual([10, 20]);
  });

  it("pmfBuildFromMap (via byOutcome) handles empty and invalid maps", () => {
    const mix = new Mixture<"a" | "b">()
      .add("a", PMF.fromMap(new Map([[1, 1]])), 0) // Zero weight
      .add("b", PMF.fromMap(new Map([[2, 1]])), -10); // Negative weight

    const pmfs = mix.byOutcome();
    expect(pmfs).toEqual({});
  });

  it("getProb (via add) should correctly extract probability from Bin or number", () => {
    const mix = new Mixture();

    // Create a mock PMF-like object that iterates with Bin objects
    const pmfWithBins = {
      [Symbol.iterator]: function* () {
        yield [1, { p: 0.25, count: {} }];
        yield [2, { p: 0.75, count: {} }];
      },
    };

    // @ts-expect-error - using a mock PMF
    mix.add("a", pmfWithBins, 1);
    const pmf1 = mix.buildPMF();
    expect(pmf1.pAt(1)).toBeCloseTo(0.25, 12);
    expect(pmf1.pAt(2)).toBeCloseTo(0.75, 12);

    mix.clear();

    // Create a mock PMF-like object that iterates with raw numbers (less common)
    const pmfWithNumbers = {
      [Symbol.iterator]: function* () {
        yield [5, 0.4];
        yield [6, 0.6];
      },
    };
    // @ts-expect-error - using a mock PMF
    mix.add("b", pmfWithNumbers, 1);
    const pmf2 = mix.buildPMF();
    expect(pmf2.pAt(5)).toBeCloseTo(0.4, 12);
    expect(pmf2.pAt(6)).toBeCloseTo(0.6, 12);
  });
});
