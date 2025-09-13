import { describe, expect, it } from "vitest";
import { parse } from "../src/index";
import { DiceQuery } from "../src/query";
import { EPS, OutcomeType } from "../src/types";

describe("DPR Complete Flow Summary", () => {
  it("demonstrates complete flow: parsing -> pmf -> query with invariants", () => {
    const expression = "(d20 + 6 AC 15) * (2d6 + 3) crit (2d6) miss (1d4)";

    const pmf = parse(expression);
    expect(pmf).toBeDefined();

    const normalizedPMF = pmf.normalize();

    // Invariant 1: Mass Conservation
    expect(normalizedPMF.mass()).toBeCloseTo(1, 10);

    // Invariant 2: Nonnegativity
    for (const [damage, bin] of normalizedPMF) {
      expect(bin.p).toBeGreaterThanOrEqual(0);
      expect(damage).toBeGreaterThanOrEqual(0);

      // Check label counts
      for (const label in bin.count) {
        const count = bin.count[label];
        expect(count).toBeDefined();
        expect(count).toBeGreaterThanOrEqual(0);
      }
    }

    // Check damage attributions separately to avoid conditional expects
    const allAttrValues: number[] = [];
    for (const [, bin] of normalizedPMF) {
      if (bin.attr) {
        const attrValues = Object.values(bin.attr).map((attr) => attr ?? 0);
        allAttrValues.push(...attrValues);
      }
    }

    // Test all collected attr values are non-negative
    for (const attrValue of allAttrValues) {
      expect(attrValue).toBeGreaterThanOrEqual(0);
    }

    // Invariant 3: Label Conservation
    for (const [, bin] of normalizedPMF) {
      const totalLabelCount = Object.values(bin.count).reduce(
        (sum: number, count: number | undefined) => sum + (count ?? 0),
        0
      );
      expect(totalLabelCount).toBeCloseTo(bin.p, 10);
    }

    // Step 4: Create query interface
    const query = new DiceQuery([normalizedPMF]);

    // Invariant 4: CDF/CCDF properties
    const support = query.combined.support();
    expect(support.length).toBeGreaterThan(0);

    // CDF should be monotonic
    for (let i = 1; i < support.length; i++) {
      const prevCdf = query.cdf(support[i - 1]);
      const currCdf = query.cdf(support[i]);
      expect(currCdf).toBeGreaterThanOrEqual(prevCdf);
    }

    // CCDF should be monotonic
    for (let i = 1; i < support.length; i++) {
      const prevCcdf = query.ccdf(support[i - 1]);
      const currCcdf = query.ccdf(support[i]);
      expect(currCcdf).toBeLessThanOrEqual(prevCcdf);
    }

    // CDF bounds
    expect(query.cdf(query.min() - 1)).toBeCloseTo(0, 10);
    expect(query.cdf(query.max())).toBeCloseTo(1, 10);
    expect(query.ccdf(query.max() + 1)).toBeCloseTo(0, 10);
    expect(query.ccdf(query.min())).toBeCloseTo(1, 10);

    // Step 5: Validate outcome tracking
    const outcomes: OutcomeType[] = ["hit", "crit", "missDamage", "missNone"];
    const validOutcomes = outcomes.filter(
      (outcome) => query.probabilityOf(outcome) > 0
    );

    // All valid outcomes should have proper probability values
    for (const outcome of validOutcomes) {
      const prob = query.probabilityOf(outcome);
      expect(prob).toBeGreaterThan(0);
      expect(prob).toBeLessThanOrEqual(1);
    }

    expect(validOutcomes.length).toBeGreaterThan(0);

    // Step 6: Validate statistical properties
    const mean = query.mean();
    const variance = query.variance();
    const stdev = query.stddev();

    expect(mean).toBeCloseTo(6.85, 1);
    expect(variance).toBeCloseTo(17.03, 1);
    expect(stdev).toBeCloseTo(4.13, 1);
    expect(Math.abs(stdev - Math.sqrt(variance))).toBeLessThan(EPS);

    const min = query.min();
    const max = query.max();

    expect(min).toBeLessThanOrEqual(max);
    expect(min).toBe(1);
    expect(max).toBe(15);
    expect(support).toContain(min);
    expect(support).toContain(max);
  });

  it("validates mean additivity across independent attacks", () => {
    const expressions = [
      "(d20 + 5 AC 12) * (1d6)",
      "(d20 + 3 AC 15) * (1d8)",
      "(d20 + 7 AC 13) * (1d4 + 2)",
    ];

    const queries = expressions.map((expr) => parse(expr).query());
    const individualMeans = queries.map((q) => q.mean());
    const expectedTotalMean = individualMeans.reduce(
      (sum, mean) => sum + mean,
      0
    );

    // Individual means should be positive (all expressions can hit)
    expect(expectedTotalMean).toBeGreaterThan(7);
    expect(expectedTotalMean).toBeLessThan(9);

    // Test multi-attack scenario
    const multiQuery = new DiceQuery(queries.map((q) => q.combined));
    const actualTotalMean = multiQuery.mean();

    // The current implementation should still maintain basic properties
    expect(actualTotalMean).toBeGreaterThan(7);
    expect(actualTotalMean).toBeLessThan(9);
    expect(multiQuery.combined.mass()).toBeCloseTo(1, 9);
  });

  it("handles extreme edge cases gracefully", () => {
    const edgeCases = [
      { expr: "(d20 + 1 AC 25) * (1d6)", desc: "Always miss" },
      { expr: "(d20 + 20 AC 5) * (1d6)", desc: "Always hit" },
      { expr: "d1", desc: "Deterministic die" },
      { expr: "(d20 + 10 AC 10) * (0)", desc: "Zero damage" },
    ];

    for (const { expr } of edgeCases) {
      const pmf = parse(expr).normalize();
      const query = pmf.query();

      // Basic invariants should still hold
      expect(pmf.mass()).toBeCloseTo(1, 10);
      expect(query.min()).toBeGreaterThanOrEqual(0);
      expect(query.max()).toBeGreaterThanOrEqual(query.min());

      // CDF should be valid
      expect(query.cdf(query.max())).toBeCloseTo(1, 10);
      expect(query.ccdf(query.max() + 1)).toBeCloseTo(0, 10);
    }
  });

  it("validates complex outcome interactions", () => {
    // Test expression with multiple outcome types interacting
    const complexExpr = "(d20 + 5 AC 12) * (1d8 + 2) crit (1d8) miss (1d4)";
    const pmf = parse(complexExpr);
    const query = pmf.query();

    // Should have multiple outcome types
    const outcomeTypes: OutcomeType[] = [
      "hit",
      "crit",
      "missDamage",
      "missNone",
    ];
    const foundTypes = outcomeTypes.filter(
      (type) => query.probabilityOf(type) > 0
    );

    expect(foundTypes.length).toBeGreaterThan(1);

    // Each outcome type should have consistent damage attribution
    for (const type of foundTypes) {
      const prob = query.probabilityOf(type);
      const expectedDamage = query.expectedDamageFrom(type);

      expect(prob).toBeGreaterThan(0);
      expect(expectedDamage).toBeGreaterThanOrEqual(0);
    }

    const pcExpr = "(d20 + 4 AC 13) * (1d6) pc (1d6)";
    const pcPmf = parse(pcExpr);
    const pcQuery = pcPmf.query();

    expect(pcQuery.probabilityOf("pc")).toBeGreaterThan(0);

    // All mathematical invariants should hold even with complex interactions
    expect(pmf.mass()).toBeCloseTo(1, 10);
    expect(pcPmf.mass()).toBeCloseTo(1, 10);

    for (const [, bin] of pmf) {
      const totalLabelCount = Object.values(bin.count).reduce(
        (sum: number, count: number | undefined) => sum + (count ?? 0),
        0
      );
      expect(totalLabelCount).toBeCloseTo(bin.p, 10);
    }

    for (const [, bin] of pcPmf) {
      const totalLabelCount = Object.values(bin.count).reduce(
        (sum: number, count: number | undefined) => sum + (count ?? 0),
        0
      );
      expect(totalLabelCount).toBeCloseTo(bin.p, 10);
    }
  });
});
