import { describe, expect, it } from "vitest";
import { DiceQuery, PMF, parse } from "../src/index";
import { EPS } from "../src/types";

describe("DPR Flow Mathematical Invariants", () => {
  function toQuery(expr: string): DiceQuery {
    return parse(expr).query();
  }

  function toMultiQuery(exprs: string[]): DiceQuery {
    const pmfs = exprs.map((expr) => parse(expr));
    return new DiceQuery(pmfs);
  }

  describe("Mass Conservation", () => {
    it("should preserve unit mass after normalization for simple dice", () => {
      const expressions = ["d6", "2d6", "d20", "d4 + 3", "1d8 + 1d6"];

      for (const expr of expressions) {
        const pmf = parse(expr);
        const mass = pmf.mass();
        expect(mass).toBeCloseTo(1, EPS);
      }
    });

    it("should preserve unit mass for attack expressions with outcomes", () => {
      const expressions = [
        "(d20 + 5 AC 12) * (1d6)",
        "(d20 + 3 AC 15) * (2d6 + 3) crit (2d6)",
        "(d20 + 6 DC 16) * (8) save half",
        "(d20 + 5 AC 12) * (1d4) miss (3)",
        "(d20 + 4 AC 13) * (1d6) pc (1d6)",
      ];

      for (const expr of expressions) {
        const pmf = parse(expr);
        const totalMass = pmf.mass();
        expect(totalMass).toBeCloseTo(1, 10);
      }
    });

    it("should preserve unit mass through PMF operations", () => {
      const pmf1 = parse("d6");
      const pmf2 = parse("d8");

      // Combine should preserve mass
      const combined = pmf1.convolve(pmf2);
      expect(combined.mass()).toBe(1);

      // Scale and normalize should preserve mass
      const scaled = pmf1.scaleMass(0.7).addScaled(pmf2, 0.3).normalize();
      expect(scaled.mass()).toBe(1);

      // Map damage should preserve mass
      const mapped = pmf1.mapDamage((x) => x + 5);
      expect(mapped.mass()).toBe(pmf1.mass());
    });

    it("should preserve unit mass in combineMany operations", () => {
      const pmfs = [parse("d6"), parse("d8"), parse("d10"), parse("d4 + 2")];

      const combined = PMF.convolveMany(pmfs);
      expect(combined.mass()).toBeCloseTo(1, EPS);
    });
  });

  describe("Nonnegativity", () => {
    it("should have non-negative probabilities for all expressions", () => {
      const expressions = [
        "d6",
        "(d20 + 5 AC 12) * (1d6)",
        "(d20 + 3 AC 15) * (2d6 + 3) crit (2d6 + 3)",
        "(d20 + 6 DC 16) * (8) save half",
        "d20!",
      ];

      for (const expr of expressions) {
        const pmf = parse(expr).normalize();
        for (const [, bin] of pmf) {
          expect(bin.p).toBeGreaterThanOrEqual(0);
        }
      }
    });

    it("should have non-negative label counts and attributions", () => {
      const expressions = [
        "(d20 + 5 AC 12) * (1d6) crit (1d6)",
        "(d20 + 6 DC 16) * (8) save half",
        "(d20 + 5 AC 12) * (1d4) miss (3)",
      ];

      for (const expr of expressions) {
        const pmf = parse(expr).normalize();
        for (const [, bin] of pmf) {
          // Check count values
          for (const label in bin.count) {
            const count = bin.count[label];
            expect(count).toBeDefined();
            expect(count).toBeGreaterThanOrEqual(0);
          }
        }
      }
    });

    it("should have non-negative damage attributions", () => {
      const expressions = [
        "(d20 + 5 AC 12) * (1d6) crit (1d6)",
        "(d20 + 6 DC 16) * (8) save half",
        "(d20 + 5 AC 12) * (1d4) miss (3)",
      ];

      for (const expr of expressions) {
        const pmf = parse(expr).normalize();
        // Collect all attr values from bins that have them
        const allAttrValues: number[] = [];

        for (const [, bin] of pmf) {
          if (bin.attr) {
            const attrValues = Object.values(bin.attr).map((attr) => attr ?? 0);
            allAttrValues.push(...attrValues);
          }
        }

        // Test all collected attr values are non-negative
        for (const attrValue of allAttrValues) {
          expect(attrValue).toBeGreaterThanOrEqual(0);
        }
      }
    });

    it("should maintain nonnegativity through operations", () => {
      const pmf1 = parse("d6").normalize();
      const pmf2 = parse("d8").normalize();

      const operations = [
        pmf1.convolve(pmf2),
        pmf1.addScaled(pmf2, 0.5),
        pmf1.scaleMass(0.8),
        pmf1.mapDamage((x) => x * 2),
        pmf1.scaleDamage(0.5, "floor"),
      ];

      for (const result of operations) {
        for (const [, bin] of result) {
          expect(bin.p).toBeGreaterThanOrEqual(0);
        }
      }
    });

    it("should should chain nonnegativity through operations", () => {
      const pmf1 = parse("d6");
      const pmf2 = parse("d8");

      const pmf3 = pmf1
        .convolve(pmf2)
        .addScaled(pmf2, 0.5)
        .scaleMass(0.8)
        .mapDamage((x) => x * 2)
        .scaleDamage(0.5, "floor");

      expect(pmf3.mass()).toBeCloseTo(1, EPS);
      for (const [, bin] of pmf3) {
        expect(bin.p).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe("Monotone CDF/CCDF", () => {
    it("should have monotonically increasing CDF", () => {
      const expressions = [
        "d6",
        "2d6",
        "(d20 + 5 AC 12) * (1d6)",
        "(d20 > d20 + 6 DC 16) * (8d6) save half",
      ];

      for (const expr of expressions) {
        const query = toQuery(expr);
        const support = query.combined.support();

        if (support.length < 2) continue;

        for (let i = 1; i < support.length; i++) {
          const prevCdf = query.cdf(support[i - 1]);
          const currCdf = query.cdf(support[i]);
          expect(currCdf).toBeGreaterThanOrEqual(prevCdf);
        }
      }
    });

    it("should have monotonically decreasing CCDF", () => {
      const expressions = [
        "d6",
        "2d6",
        "(d20 + 5 AC 12) * (1d6)",
        "(d20 < d20 + 6 DC 16) * (8) save half",
      ];

      for (const expr of expressions) {
        const query = toQuery(expr);
        const support = query.combined.support();

        if (support.length < 2) continue;

        for (let i = 1; i < support.length; i++) {
          const prevCcdf = query.ccdf(support[i - 1]);
          const currCcdf = query.ccdf(support[i]);
          expect(currCcdf).toBeLessThanOrEqual(prevCcdf);
        }
      }
    });

    it("should satisfy CDF + CCDF = 1 relationship", () => {
      const expressions = ["d6", "(d20 + 5 AC 12) * (1d6)", "2d8 + 3"];

      for (const expr of expressions) {
        const query = toQuery(expr);
        const support = query.combined.support();

        for (const damage of support) {
          const cdf = query.cdf(damage);
          const ccdf = query.ccdf(damage + 1);
          expect(Math.abs(cdf + ccdf - 1)).toBeLessThan(EPS);
        }
      }
    });

    it("should have CDF bounds [0, 1]", () => {
      const expressions = [
        "d6",
        "(d20 + 5 AC 12) * (1d6)",
        "(d20 + 6 DC 16) * (8) save half",
      ];

      for (const expr of expressions) {
        const query = toQuery(expr);
        const min = query.min();
        const max = query.max();

        expect(query.cdf(min - 1)).toBeCloseTo(0, 10);
        expect(query.cdf(max)).toBeCloseTo(1, 10);
        expect(query.ccdf(max + 1)).toBeCloseTo(0, 10);
        expect(query.ccdf(min)).toBeCloseTo(1, 10);
      }
    });
  });

  describe("Mean Additivity for Independent Combines", () => {
    it("should satisfy E[X + Y] = E[X] + E[Y] for independent dice", () => {
      const testCases = [
        { expr1: "d6", expr2: "d8" },
        { expr1: "2d6", expr2: "d4 + 3" },
        { expr1: "(d20 + 5 AC 12) * (1d6)", expr2: "(d20 + 3 AC 15) * (1d8)" },
      ];

      for (const { expr1, expr2 } of testCases) {
        const query1 = toQuery(expr1);
        const query2 = toQuery(expr2);
        const combinedQuery = query1.convolve(query2);

        const mean1 = query1.mean();
        const mean2 = query2.mean();
        const combinedMean = combinedQuery.mean();

        expect(Math.abs(combinedMean - (mean1 + mean2))).toBeLessThan(EPS);
      }
    });

    it("should satisfy Var[X + Y] = Var[X] + Var[Y] for independent dice", () => {
      const testCases = [
        { expr1: "d6", expr2: "d8" },
        { expr1: "2d6", expr2: "d4 + 3" },
      ];

      for (const { expr1, expr2 } of testCases) {
        const query1 = toQuery(expr1);
        const query2 = toQuery(expr2);
        const combinedQuery = new DiceQuery([query1.combined, query2.combined]);

        const var1 = query1.variance();
        const var2 = query2.variance();
        const combinedVar = combinedQuery.variance();

        expect(Math.abs(combinedVar - (var1 + var2))).toBeLessThan(EPS);
      }
    });

    it("should preserve mean through combineMany", () => {
      const expressions = ["d6", "d8", "d10", "d4 + 2"];
      const queries = expressions.map((expr) => toQuery(expr));
      const expectedMean = queries.reduce((sum, q) => sum + q.mean(), 0);

      const combinedQuery = toMultiQuery(expressions);
      const actualMean = combinedQuery.mean();

      expect(Math.abs(actualMean - expectedMean)).toBeLessThan(EPS);
    });
  });

  describe("Label Count Sanity", () => {
    it("should have sum(labelCounts) == totalCount per bin for normalized PMFs", () => {
      const expressions = [
        "(d20 + 5 AC 12) * (1d6)",
        "(d20 + 3 AC 15) * (2d6 + 3) crit (2d6)",
        "(d20 + 6 DC 16) * (8) save half",
        "(d20 + 5 AC 12) * (1d4) miss (3)",
        "(d20 + 4 AC 13) * (1d6) pc (1d6)",
      ];

      for (const expr of expressions) {
        const pmf = parse(expr).normalize();
        for (const [, bin] of pmf) {
          const totalLabelCount = Object.values(bin.count).reduce(
            (sum: number, count: number | undefined) => sum + (count ?? 0),
            0
          );
          expect(Math.abs(totalLabelCount - bin.p)).toBeLessThan(EPS);
        }
      }
    });

    it("should maintain label consistency through combineMany", () => {
      const expressions = [
        "(d20 + 5 AC 12) * (1d6) crit (1d6)",
        "(d20 + 3 AC 15) * (1d8)",
        "(d20 + 6 DC 16) * (6) save half",
      ];

      const multiQuery = toMultiQuery(expressions);

      expect(Math.abs(multiQuery.combined.mass() - 1)).toBeLessThan(EPS);

      // Test that individual PMFs have proper label conservation before combining
      for (const expr of expressions) {
        const pmf = parse(expr).normalize();
        for (const [, bin] of pmf) {
          const totalLabelCount = Object.values(bin.count).reduce(
            (sum: number, count: number | undefined) => sum + (count ?? 0),
            0
          );
          expect(Math.abs(totalLabelCount - bin.p)).toBeLessThan(EPS);
        }
      }
    });

    it("should have consistent damage attribution in attr field", () => {
      const expressions = [
        "(d20 + 5 AC 12) * (1d6) crit (2d6)",
        "(d20 + 6 DC 16) * (8) save half",
      ];

      for (const expr of expressions) {
        const pmf = parse(expr).normalize();
        const attrTests: { totalAttr: number; expectedDamage: number }[] = [];

        for (const [damage, bin] of pmf) {
          if (bin.attr) {
            // Sum of attributed damage should match expected damage from this bin
            const totalAttr = Object.values(bin.attr).reduce(
              (sum: number, attr: number | undefined) => sum + (attr ?? 0),
              0
            );
            const expectedDamage = damage * bin.p;
            attrTests.push({ totalAttr, expectedDamage });
          }
        }

        for (const { totalAttr, expectedDamage } of attrTests) {
          const diff = Math.abs(totalAttr - expectedDamage);
          expect(diff).toBeLessThan(EPS);
        }
      }
    });

    it("should maintain label conservation through PMF operations", () => {
      const pmf1 = parse("(d20 + 5 AC 12) * (1d6)");
      const pmf2 = parse("(d20 + 3 AC 15) * (1d8)");

      for (const [, bin] of pmf1) {
        const totalLabelCount = Object.values(bin.count).reduce(
          (sum: number, count: number | undefined) => sum + (count ?? 0),
          0
        );
        expect(Math.abs(totalLabelCount - bin.p)).toBeLessThan(EPS);
      }

      for (const [, bin] of pmf2) {
        const totalLabelCount = Object.values(bin.count).reduce(
          (sum: number, count: number | undefined) => sum + (count ?? 0),
          0
        );
        expect(Math.abs(totalLabelCount - bin.p)).toBeLessThan(EPS);
      }

      // Test addScaled operation maintains mass conservation
      const mixed = pmf1.addScaled(pmf2, 0.5).normalize();
      expect(Math.abs(mixed.mass() - 1)).toBeLessThan(EPS);

      const simpleDice1 = parse("d6").normalize();
      const simpleDice2 = parse("d8").normalize();
      const convolvedDamage = simpleDice1.convolve(simpleDice2);
      expect(Math.abs(convolvedDamage.mass() - 1)).toBeLessThan(EPS);
    });
  });

  describe("Edge Cases", () => {
    it("should handle zero-damage faces correctly", () => {
      // Expression that can produce 0 damage (misses)
      const expr = "(d20 + 5 AC 15) * (1d6)";
      const pmf = parse(expr);

      // Should have some zero-damage outcomes
      const zeroBin = pmf.map.get(0);
      expect(zeroBin).toBeDefined();
      expect(zeroBin!.p).toBeGreaterThan(0);

      // CDF at 0 should equal probability of 0 damage
      const query = toQuery(expr);
      expect(query.cdf(0)).toBe(zeroBin!.p);
    });

    it("should handle only-miss expressions", () => {
      // Very high AC that will always miss
      const expr = "(d20 + 1 AC 25) * (1d6)";
      const pmf = parse(expr).normalize();
      const query = toQuery(expr);

      // All mass should be at damage 0
      expect(query.min()).toBe(0);
      expect(query.max()).toBe(0);
      expect(query.mean()).toBe(0);

      // Should still have proper mass conservation
      expect(pmf.mass()).toBe(1);
    });

    it("should handle large dice pools efficiently", () => {
      // Convolving this with itself 8 times takes over half a second
      const expressions = Array(8).fill("(d20 + 5 AC 12) * (20d6) crit (40d6)");
      const multiQuery = toMultiQuery(expressions);

      // Should maintain mathematical properties
      expect(Math.abs(multiQuery.combined.mass() - 1)).toBeLessThan(EPS);

      // Mean should be additive
      const singleMean = toQuery(expressions[0]).mean();
      expect(singleMean).toBe(multiQuery.singles[0].mean());

      const expectedMean = singleMean * expressions.length;
      expect(
        Math.abs(multiQuery.combined.compact().mean() - expectedMean)
      ).toBeLessThan(10e-5);

      // CDF should be monotonic
      const support = multiQuery.combined.support();
      for (let i = 1; i < support.length; i++) {
        const prevCdf = multiQuery.cdf(support[i - 1]);
        const currCdf = multiQuery.cdf(support[i]);
        expect(currCdf).toBeGreaterThanOrEqual(prevCdf);
      }
    });

    it("should handle expressions with all outcome types", () => {
      const expr = "(d20 + 5 AC 12) * (1d6) crit (1d6) miss (2)";
      const pmf = parse(expr);
      const query = toQuery(expr);

      // Should have multiple outcome labels
      let hasHit = pmf.hasOutcome("hit");
      let hasCrit = pmf.hasOutcome("crit");
      let hasMiss = pmf.hasOutcome("missDamage");

      expect(hasHit || hasCrit).toBe(true); // Should have some successful attacks
      expect(hasMiss).toBe(true); // Should have some misses with damage

      // All mathematical invariants should still hold
      expect(Math.abs(pmf.mass() - 1)).toBeLessThan(EPS);

      // Todo - we do this in a few spots in this file
      // Maybe find a cleaner way to do this without introspecting so much
      for (const [, bin] of pmf) {
        const totalLabelCount = Object.values(bin.count).reduce(
          (sum: number, count: number | undefined) => sum + (count ?? 0),
          0
        );
        expect(Math.abs(totalLabelCount - bin.p)).toBeLessThan(EPS);
      }
    });

    it("should handle save expressions with proper labels", () => {
      const expr = "(d20 + 6 DC 16) * (8) save half";
      const pmf = parse(expr);

      let hasSaveHalf = pmf.hasOutcome("saveHalf");
      let hasSaveFail = pmf.hasOutcome("saveFail");

      expect(hasSaveHalf).toBe(true);
      expect(hasSaveFail).toBe(true);

      expect(Math.abs(pmf.mass() - 1)).toBeLessThan(EPS);
    });

    it("should handle potent cantrip (pc) expressions", () => {
      const expr = "(d20 + 4 AC 13) * (1d6) pc (1d6)";
      const pmf = parse(expr);

      let hasPc = pmf.hasOutcome("pc");
      expect(hasPc).toBe(true);

      expect(Math.abs(pmf.mass() - 1)).toBeLessThan(EPS);

      for (const [, bin] of pmf) {
        const totalLabelCount = Object.values(bin.count).reduce(
          (sum: number, count: number | undefined) => sum + (count ?? 0),
          0
        );
        expect(Math.abs(totalLabelCount - bin.p)).toBeLessThan(EPS);
      }
    });
  });
});
