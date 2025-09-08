import { describe, expect, it } from "vitest";
import { DiceQuery, parse, PMF } from "../src/index";
import { TEST_EPS } from "../src/types";

function pmfFrom(map: Record<number, number>, label?: string): PMF {
  const m = new Map<number, { p: number; count: Record<string, number> }>();
  let Z = 0;
  for (const [k, v] of Object.entries(map)) Z += v;
  for (const [k, v] of Object.entries(map)) {
    const p = v / Z;
    const count: Record<string, number> = {};
    if (label) count[label] = p;
    m.set(Number(k), { p, count });
  }
  return new PMF(m, 1e-15, true);
}

describe("DiceQuery", () => {
  it("mean/variance/cdf/percentiles on simple case", () => {
    const A = pmfFrom({ 1: 1, 2: 1, 3: 1 });
    const q = new DiceQuery([A]);
    expect(q.mean()).toBeCloseTo(2, 12);
    expect(q.variance()).toBeCloseTo(
      ((1 - 2) ** 2 + (2 - 2) ** 2 + (3 - 2) ** 2) / 3,
      12
    );
    expect(q.cdf(2)).toBeCloseTo(2 / 3, 12);
    const ps = q.percentiles([0.5]);
    expect(ps[0]).toBeGreaterThanOrEqual(1);
    expect(ps[0]).toBeLessThanOrEqual(3);
  });

  it("probAtLeastOne for crit equals complement of product of non-crit", () => {
    const A = pmfFrom({ 1: 1, 2: 1 }, "crit"); // single with p_crit = 1
    const B = pmfFrom({ 3: 3, 4: 1 }); // unlabeled
    const C = pmfFrom({ 5: 1, 6: 1 }, "crit"); // p_crit = 1
    const q = new DiceQuery([A, B, C]);
    const expected = 1 - (1 - 1) * (1 - 0) * (1 - 1);
    expect(q.probAtLeastOne("crit")).toBeCloseTo(expected, 12);
  });

  it("toChartSeries sums to 1", () => {
    const A = pmfFrom({ 0: 1, 2: 3 });
    const q = new DiceQuery([A]);
    const total = q.toChartSeries().reduce((s, p) => s + p.y, 0);
    expect(total).toBeCloseTo(1, 12);
  });

  it("toLabeledTable and toStackedChartData shape", () => {
    const A = pmfFrom({ 1: 1, 2: 1 }, "crit");
    const q = new DiceQuery([A]);
    const table = q.toLabeledTable(["crit"]);
    expect(table[0]).toHaveProperty("damage");
    expect(table[0]).toHaveProperty("total");
    expect(table[0]).toHaveProperty("crit");
    const stacked = q.toStackedChartData(["crit"]);
    expect(stacked.labels.length).toBeGreaterThan(0);
    expect(stacked.datasets.length).toBe(1);
  });

  describe("Expression Testing", () => {
    describe("Multiple Attack Statistics", () => {
      it("should calculate correct statistics for two identical attacks", () => {
        // Parse the basic attack expression
        const expression = "(d20 + 10 AC 15) * (2d6 + 4) crit (4d6 + 4)";
        const dice = parse(expression);

        // Get single attack query
        const singleQuery = new DiceQuery([dice]);
        const singleMean = singleQuery.mean();
        const singleHitChance =
          1 - singleQuery.probAtLeastOne(["missDamage", "missNone"]);
        const singleCritChance = singleQuery.probAtLeastOne("crit");

        // Calculate multiple attack stats for 2 attacks
        const multipleQuery = new DiceQuery([dice, dice]);

        // Verify the math is correct
        // P(at least one hit) = 1 - P(no hits) = 1 - (0.2)² = 1 - 0.04 = 0.96
        const multipleHitChance = multipleQuery.probAtLeastOne(["hit", "crit"]);
        expect(multipleHitChance).toBeCloseTo(0.96, 4);

        // P(at least one crit) = 1 - P(no crits) = 1 - (0.95)² = 1 - 0.9025 = 0.0975
        const multipleCritChance = multipleQuery.probAtLeastOne("crit");
        expect(multipleCritChance).toBeCloseTo(0.0975, 4);

        // Total expected damage = 2 * single attack damage
        expect(multipleQuery.mean()).toBeCloseTo(2 * singleMean, 4);
      });

      it("should calculate correct statistics for three attacks with advantage", () => {
        // Parse the basic attack expression
        const expression = "(d20 + 10 AC 15) * (2d6 + 4) crit (4d6 + 4)";
        const advantageExpression = expression.replace("d20", "d20 > d20");
        const dice = parse(advantageExpression);

        // Get single attack stats with advantage
        const singleQuery = new DiceQuery([dice]);
        const singleMean = singleQuery.mean();

        // Calculate multiple attack stats for 3 attacks
        const multipleQuery = new DiceQuery([dice, dice, dice]);

        // Verify the math is correct
        // P(at least one hit) = 1 - P(no hits) = 1 - (0.04)³ = 1 - 0.000064 = 0.999936
        const multipleHitChance = multipleQuery.probAtLeastOne(["hit", "crit"]);
        expect(multipleHitChance).toBeCloseTo(0.999936, 6); // Using correct mathematical value

        // P(at least one crit) = 1 - P(no crits) = 1 - (0.9025)³ = 1 - 0.7351 = 0.2649
        const multipleCritChance = multipleQuery.probAtLeastOne("crit");
        expect(multipleCritChance).toBeCloseTo(0.2649, 4);

        // Total expected damage = 3 * single attack damage
        expect(multipleQuery.mean()).toBeCloseTo(3 * singleMean, 4);
      });

      it("should handle edge cases correctly", () => {
        // Parse the basic attack expression
        const expression = "(d20 + 10 AC 15) * (2d6 + 4) crit (4d6 + 4)";
        const dice = parse(expression);

        const singleQuery = new DiceQuery([dice]);

        // Test 0 attacks (empty query)
        const zeroAttacks = new DiceQuery([]);
        expect(zeroAttacks.mean()).toBe(0);
        expect(zeroAttacks.probAtLeastOne("crit")).toBe(0);
        expect(zeroAttacks.probAtLeastOne(["hit", "crit"])).toBe(0);

        // Test 1 attack (should return same as single attack)
        const oneAttack = new DiceQuery([dice]);
        expect(oneAttack.mean()).toBe(singleQuery.mean());
        expect(oneAttack.probAtLeastOne("crit")).toBeCloseTo(
          singleQuery.probAtLeastOne("crit"),
          6
        );
        expect(oneAttack.probAtLeastOne(["hit", "crit"])).toBeCloseTo(
          singleQuery.probAtLeastOne(["hit", "crit"]),
          6
        );
      });

      it("should calculate correct statistics for non-identical attacks", () => {
        // Parse two different attack expressions
        const expression1 = "(d20 + 10 AC 15) * (2d6 + 4) crit (4d6 + 4)";
        const expression2 = "(d20 + 10 AC 15) * (1d8 + 5) crit (2d8 + 5)";

        const dice1 = parse(expression1);
        const dice2 = parse(expression2);

        // Get stats for both attacks
        const query1 = new DiceQuery([dice1]);
        const query2 = new DiceQuery([dice2]);

        // Calculate multiple attack stats for 2 different attacks
        const multipleQuery = new DiceQuery([dice1, dice2]);

        // Verify the math is correct for non-identical attacks
        // Both attacks have 80% hit chance (need 5+ on d20)
        // P(at least one hit) = 1 - P(both miss) = 1 - (0.2 × 0.2) = 1 - 0.04 = 0.96
        const multipleHitChance = multipleQuery.probAtLeastOne(["hit", "crit"]);
        expect(multipleHitChance).toBeCloseTo(0.96, 4);

        // Both attacks have 5% crit chance
        // P(at least one crit) = 1 - P(no crits) = 1 - (0.95 × 0.95) = 1 - 0.9025 = 0.0975
        const multipleCritChance = multipleQuery.probAtLeastOne("crit");
        expect(multipleCritChance).toBeCloseTo(0.0975, 4);

        // Expected total damage = sum of individual attack damages
        expect(multipleQuery.mean()).toBeCloseTo(
          query1.mean() + query2.mean(),
          4
        );
      });

      it("should handle the user's specific non-identical attack example", () => {
        // User's specific example:
        // Attack 1: (d20 + 10 AC 15) * (2d6 + 4) crit (4d6 + 4)
        // Attack 2: (d20 + 10 AC 15) * (1d8+5) crit (2d8+5)

        const attack1Expression = "(d20 + 10 AC 15) * (2d6 + 4) crit (4d6 + 4)";
        const attack2Expression = "(d20 + 10 AC 15) * (1d8+5) crit (2d8+5)";

        const dice1 = parse(attack1Expression);
        const dice2 = parse(attack2Expression);

        const query1 = new DiceQuery([dice1]);
        const query2 = new DiceQuery([dice2]);

        // Use the combined query for non-identical attacks
        const result = new DiceQuery([dice1, dice2]);

        // Verify the math is working correctly
        const resultHitChance = result.probAtLeastOne(["hit", "crit"]);
        expect(resultHitChance).toBeGreaterThan(0.9); // Should be high since both have good hit chances

        const resultCritChance = result.probAtLeastOne("crit");
        expect(resultCritChance).toBeCloseTo(0.0975, 4); // 1 - (0.95 × 0.95)

        expect(result.mean()).toBeCloseTo(query1.mean() + query2.mean(), 2);
      });

      it("should calculate correct statistics for three attacks with mixed crit thresholds", () => {
        // Test scenario: 3 attacks with different crit thresholds
        // Attack 1: crits on 20 (5% chance)
        // Attack 2: crits on 19-20 (10% chance)
        // Attack 3: crits on 18-20 (15% chance)

        const attack1Expression = "(d20 + 10 AC 15) * (2d6 + 4) crit (4d6 + 4)";
        const attack2Expression =
          "(d20 + 10 AC 15) * (2d6 + 4) xcrit2 (4d6 + 4)";
        const attack3Expression =
          "(d20 + 10 AC 15) * (2d6 + 4) xcrit3 (4d6 + 4)";

        const dice1 = parse(attack1Expression);
        const dice2 = parse(attack2Expression);
        const dice3 = parse(attack3Expression);

        // Get individual attack stats with their respective crit thresholds
        const query1 = new DiceQuery([dice1]);
        const query2 = new DiceQuery([dice2]);
        const query3 = new DiceQuery([dice3]);

        // Verify individual crit chances are correct
        expect(query1.probAtLeastOne("crit")).toBeCloseTo(0.05, 4); // 5% (1/20)
        expect(query2.probAtLeastOne("crit")).toBeCloseTo(0.1, 4); // 10% (2/20)
        expect(query3.probAtLeastOne("crit")).toBeCloseTo(0.15, 4); // 15% (3/20)

        // Calculate multiple attack stats for 3 attacks with different crit thresholds
        const multipleQuery = new DiceQuery([dice1, dice2, dice3]);

        // Verify the math for "at least one crit" is correct
        // P(at least one crit) = 1 - P(no crits) = 1 - (0.95 × 0.90 × 0.85)
        // = 1 - (0.95 × 0.90 × 0.85) = 1 - 0.72675 = 0.27325
        const expectedCritChance = 1 - 0.95 * 0.9 * 0.85;
        const actualCritChance = multipleQuery.probAtLeastOne("crit");
        expect(actualCritChance).toBeCloseTo(expectedCritChance, 4);

        // Verify hit chance calculation
        // All attacks have 80% hit chance (need 5+ on d20)
        // P(at least one hit) = 1 - P(all miss) = 1 - (0.2)³ = 1 - 0.008 = 0.992
        const actualHitChance = multipleQuery.probAtLeastOne(["hit", "crit"]);
        expect(actualHitChance).toBeCloseTo(0.992, 4);

        // Verify total expected damage
        const expectedTotalDamage =
          query1.mean() + query2.mean() + query3.mean();
        expect(multipleQuery.mean()).toBeCloseTo(expectedTotalDamage, 4);
      });

      it("should calculate correct statistics for mixed crit thresholds with advantage/disadvantage", () => {
        // Test scenario: 3 attacks with different crit thresholds and advantage types
        // Attack 1: crits on 20 (5% chance) with normal roll
        // Attack 2: crits on 19-20 (10% chance) with advantage
        // Attack 3: crits on 18-20 (15% chance) with disadvantage

        const attack1Expression = "(d20 + 10 AC 15) * (2d6 + 4) crit (4d6 + 4)";
        const attack2Expression =
          "(d20 > d20 + 10 AC 15) * (2d6 + 4) xcrit2 (4d6 + 4)";
        const attack3Expression =
          "(d20 < d20 + 10 AC 15) * (2d6 + 4) xcrit3 (4d6 + 4)";

        const dice1 = parse(attack1Expression);
        const dice2 = parse(attack2Expression);
        const dice3 = parse(attack3Expression);

        // Get individual attack stats with their respective crit thresholds and advantage types
        const query1 = new DiceQuery([dice1]);
        const query2 = new DiceQuery([dice2]);
        const query3 = new DiceQuery([dice3]);

        // Verify individual crit chances are correct
        expect(query1.probAtLeastOne("crit")).toBeCloseTo(0.05, 4); // 5% (1/20)
        expect(query2.probAtLeastOne("crit")).toBeCloseTo(0.19, 4); // 19% for advantage on 19-20: 1 - (0.9)²
        expect(query3.probAtLeastOne("crit")).toBeCloseTo(0.0225, 4); // 2.25% for disadvantage on 18-20: (0.15)²

        // Calculate multiple attack stats for 3 attacks with different crit thresholds and advantage types
        const multipleQuery = new DiceQuery([dice1, dice2, dice3]);

        // Verify the math for "at least one crit" is correct
        // P(at least one crit) = 1 - P(no crits) = 1 - (0.95 × 0.81 × 0.9775)
        // = 1 - (0.95 × 0.81 × 0.9775) = 1 - 0.7506 = 0.2494
        const expectedCritChance = 1 - 0.95 * 0.81 * 0.9775;
        const actualCritChance = multipleQuery.probAtLeastOne("crit");
        expect(actualCritChance).toBeCloseTo(expectedCritChance, 4);

        // Verify hit chance calculation
        // Attack 1: 80% hit chance (normal)
        // Attack 2: 96% hit chance (advantage: 1 - (0.2)²)
        // Attack 3: 64% hit chance (disadvantage: (0.8)²)
        // P(at least one hit) = 1 - P(all miss) = 1 - (0.2 × 0.04 × 0.36) = 1 - 0.00288 = 0.99712
        const actualHitChance = multipleQuery.probAtLeastOne(["hit", "crit"]);
        expect(actualHitChance).toBeCloseTo(0.997, 3);

        // Verify total expected damage
        const expectedTotalDamage =
          query1.mean() + query2.mean() + query3.mean();
        expect(multipleQuery.mean()).toBeCloseTo(expectedTotalDamage, 4);
      });

      it("should calculate correct statistics for four attacks (debug crit chance)", () => {
        // Parse the basic attack expression
        const expression = "(d20 + 10 AC 15) * (2d6 + 4) crit (4d6 + 4)";
        const dice = parse(expression);

        // Calculate multiple attack stats for 4 attacks
        const multipleQuery = new DiceQuery([dice, dice, dice, dice]);

        // Verify the math is correct
        // For 4 attacks with 5% crit chance each:
        // P(at least one crit) = 1 - P(no crits) = 1 - (0.95)⁴ = 1 - 0.8145 = 0.1855
        const actualCritChance = multipleQuery.probAtLeastOne("crit");
        expect(actualCritChance).toBeCloseTo(0.1855, 4);

        // Test with advantage
        const advantageExpression = expression.replace("d20", "d20 > d20");
        const advantageDice = parse(advantageExpression);
        const multipleAdvQuery = new DiceQuery([
          advantageDice,
          advantageDice,
          advantageDice,
          advantageDice,
        ]);

        // For 4 attacks with 9.75% crit chance each:
        // P(at least one crit) = 1 - P(no crits) = 1 - (0.9025)⁴ = 1 - 0.6634 = 0.3366
        const actualAdvCritChance = multipleAdvQuery.probAtLeastOne("crit");
        expect(actualAdvCritChance).toBeCloseTo(0.3366, 4);

        // Test with disadvantage
        const disadvantageExpression = expression.replace("d20", "d20 < d20");
        const disadvantageDice = parse(disadvantageExpression);
        const multipleDisQuery = new DiceQuery([
          disadvantageDice,
          disadvantageDice,
          disadvantageDice,
          disadvantageDice,
        ]);

        // For 4 attacks with 0.25% crit chance each:
        // P(at least one crit) = 1 - P(no crits) = 1 - (0.9975)⁴ = 1 - 0.99004 = 0.00996
        const actualDisCritChance = multipleDisQuery.probAtLeastOne("crit");
        expect(actualDisCritChance).toBeCloseTo(0.00996, 4);
      });

      it("should show exact values for user's 4-attack scenario", () => {
        // User's exact scenario:
        // (d20 + 10 AC 15) * (2d6 + 4) crit (4d6 + 4) - repeated 3 times
        // (d20 + 10 AC 15) * (1d8 + 7) crit (2d8 + 7) - 1 time

        const attack1Expression = "(d20 + 10 AC 15) * (2d6 + 4) crit (4d6 + 4)";
        const attack2Expression = "(d20 + 10 AC 15) * (1d8 + 7) crit (2d8 + 7)";

        const dice1 = parse(attack1Expression);
        const dice2 = parse(attack2Expression);

        // 3 attacks of type 1 + 1 attack of type 2
        const fourAttacksNormal = new DiceQuery([dice1, dice1, dice1, dice2]);

        // Test with advantage
        const attack1AdvExpression = attack1Expression.replace(
          "d20",
          "d20 > d20"
        );
        const attack2AdvExpression = attack2Expression.replace(
          "d20",
          "d20 > d20"
        );
        const dice1Adv = parse(attack1AdvExpression);
        const dice2Adv = parse(attack2AdvExpression);
        const fourAttacksAdv = new DiceQuery([
          dice1Adv,
          dice1Adv,
          dice1Adv,
          dice2Adv,
        ]);

        // Test with disadvantage
        const attack1DisExpression = attack1Expression.replace(
          "d20",
          "d20 < d20"
        );
        const attack2DisExpression = attack2Expression.replace(
          "d20",
          "d20 < d20"
        );
        const dice1Dis = parse(attack1DisExpression);
        const dice2Dis = parse(attack2DisExpression);
        const fourAttacksDis = new DiceQuery([
          dice1Dis,
          dice1Dis,
          dice1Dis,
          dice2Dis,
        ]);

        // Verify the expected values
        expect(fourAttacksNormal.probAtLeastOne("crit")).toBeCloseTo(0.1855, 3); // ~18.55%
        expect(fourAttacksAdv.probAtLeastOne("crit")).toBeCloseTo(0.3366, 3); // ~33.66%
        expect(fourAttacksDis.probAtLeastOne("crit")).toBeCloseTo(0.00996, 4); // ~0.996%
      });
    });

    describe("Edge Cases and Error Handling", () => {
      it("should handle null/undefined input gracefully", () => {
        // Test empty query (equivalent to null/undefined in old system)
        const emptyQuery = new DiceQuery([]);
        expect(emptyQuery.mean()).toBe(0);
        expect(emptyQuery.probAtLeastOne("crit")).toBe(0);
        expect(emptyQuery.probAtLeastOne(["hit", "crit"])).toBe(0);
      });

      it("should handle empty dice gracefully", () => {
        const emptyDice = parse("0");
        const query = new DiceQuery([emptyDice]);

        expect(query.mean()).toBe(0);
        expect(query.probAtLeastOne(["hit", "crit"])).toBe(0);
        expect(query.probAtLeastOne("crit")).toBe(0);
      });

      it("should handle expressions without AC (always hit)", () => {
        const alwaysHitDice = parse("(2d6 + 4)");
        const query = new DiceQuery([alwaysHitDice]);

        expect(query.probAtLeastOne(["hit", "crit"])).toBeCloseTo(1, 6); // Always hit
        expect(query.mean()).toBeGreaterThan(0);
      });
    });

    describe("Statistical Accuracy", () => {
      it("should handle different AC values correctly", () => {
        const acValues = [10, 15, 20, 25];

        acValues.forEach((ac) => {
          const expression = `(d20 + 10 AC ${ac}) * (2d6 + 4) crit (4d6 + 4)`;
          const dice = parse(expression);
          const query = new DiceQuery([dice]);

          // Test that hit chance is reasonable for this AC value
          const hitChance = query.probAtLeastOne(["hit", "crit"]);
          expect(hitChance).toBeGreaterThan(0);
          expect(hitChance).toBeLessThanOrEqual(1);

          // Test that average damage is reasonable
          expect(query.mean()).toBeGreaterThan(0);
        });
      });
    });

    describe("Specific Stats Validation", () => {
      it("should return correct stats for (d20 + 10 AC 15) * (2d6 + 4) crit (4d6 + 4)", () => {
        const expression = "(d20 + 10 AC 15) * (2d6 + 4) crit (4d6 + 4)";
        const dice = parse(expression);
        const query = new DiceQuery([dice]);

        // Verify the exact stats that should be displayed
        const hitStats = query.damageStatsFrom("hit");
        expect(hitStats.min).toBe(6);
        expect(hitStats.max).toBe(16);
        expect(hitStats.avg).toBeCloseTo(11, 0); // Average hit damage should be 11

        const critStats = query.damageStatsFrom("crit");
        expect(critStats.min).toBe(8);
        expect(critStats.max).toBe(28);
        expect(critStats.avg).toBeCloseTo(18, 0); // Average crit damage should be 18

        // Verify overall stats
        expect(query.mean()).toBeCloseTo(9.15, 2); // Overall average DPR
        expect(query.probAtLeastOne(["hit", "crit"])).toBeCloseTo(0.8, 2); // 80% hit chance
        expect(query.probAtLeastOne("crit")).toBeCloseTo(0.05, 6); // 5% crit chance
      });

      it("should display correct UI stats for the specific expression", () => {
        const expression = "(d20 + 10 AC 15) * (2d6 + 4) crit (4d6 + 4)";
        const dice = parse(expression);
        const query = new DiceQuery([dice]);

        // These are the exact values that should be displayed in the UI
        // Based on the user's report of what production shows vs localhost

        // Hit Damage section
        const hitStats = query.damageStatsFrom("hit");
        expect(hitStats.min).toBe(6); // MIN
        expect(hitStats.avg).toBeCloseTo(11, 0); // AVG (should be 11, not 11.44)
        expect(hitStats.max).toBe(16); // MAX

        // Crit Damage section
        const critStats = query.damageStatsFrom("crit");
        expect(critStats.min).toBe(8); // MIN
        expect(critStats.avg).toBeCloseTo(18, 0); // AVG (should be 18, not 28)
        expect(critStats.max).toBe(28); // MAX

        // Verify these match the production values the user reported
        // Production shows: Hit Damage (6, 11, 16) and Crit Damage (8, 18, 28)
        // Localhost was showing: Hit Damage (6, 11.44, 28) and Crit Damage (28, 28, 28)
      });
    });
  });
});

describe("E2E: real expressions (original)", () => {
  const cases = [
    "(d20 + 5 AC 12) * (1d12 + 3) crit (3d12 + 3) miss (3)",
    "(d20 + 10 AC 15) * (2d6 + 4) crit (4d6 + 4)",
    "(d20 + 8 AC 16) * (3d12 + 2d6 + 1d4 + 4) crit (6d12 + 4d6 + 2d4 + 4)",
    "(d20 + 11 ac 15) * (2(3>(d6 reroll 2)) + 2d6 + 4) crit (4(3>(d6 reroll 2)) + 4d6 + 4)",
    "(d20 > d20 + 10 AC 15) * (2d6 + 4) xcrit2 (4d6 + 4)",
    "(d20 < d20 + 10 AC 15) * (2d6 + 4) xcrit3 (4d6 + 4)",
    "(d20 + 6 DC 16) * (8d6) save half",
  ];

  it("each expression yields a normalized PMF and sane bounds", () => {
    for (const expr of cases) {
      const P = parse(expr);
      expect(Math.abs(P.mass() - 1)).toBeLessThan(TEST_EPS);
      expect(P.min()).toBeLessThanOrEqual(P.max());
      expect(P.mass()).toBeCloseTo(1, TEST_EPS);
    }
  });

  it("event queries use singles; sanity check at least-one-crit", () => {
    const a = parse("(d20 + 5 AC 12) * (1d12 + 3) crit (3d12 + 3) miss (3)");
    const b = parse("(d20 + 10 AC 15) * (2d6 + 4) crit (4d6 + 4)");
    const q = new DiceQuery([a, b]);
    const p = q.probAtLeastOne("crit");
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThanOrEqual(1);
  });

  it("xcrit2 / xcrit3 expressions compile and produce higher max than normal hit", () => {
    const x2 = parse("(d20 > d20 + 10 AC 15) * (2d6 + 4) xcrit2 (4d6 + 4)");
    const x3 = parse("(d20 < d20 + 10 AC 15) * (2d6 + 4) xcrit3 (4d6 + 4)");
    expect(x3.max()).toBeGreaterThanOrEqual(x2.max());
  });

  it("save half uses floor(total/2) exact transform", () => {
    const S = parse("(d20 + 6 DC 16) * (8d6) save half");
    let hasHalf = false,
      hasFail = false;
    for (const [, bin] of S) {
      if (bin.count["saveHalf"]) hasHalf = true;
      if (bin.count["saveFail"]) hasFail = true;
    }
    expect(hasHalf && hasFail).toBe(true);
  });

  describe("combines to pmfs and gets the right statistics", () => {
    it("should combine two basic attacks", () => {
      //   const P = parse('(d20 + 5 AC 12) * (1d12 + 3) crit (3d12 + 3) miss (3)')
      const attack = parse("(d20 + 10 AC 15) * (2d6 + 4) crit (4d6 + 4)");
      //   const R = parse('(d20 + 8 AC 16) * (3d12 + 2d6 + 1d4 + 4) crit (6d12 + 4d6 + 2d4 + 4)')
      const attackQuery = new DiceQuery([attack]);
      const attacksQuery = new DiceQuery([attack, attack]);
      expect(attacksQuery.mean()).toBeCloseTo(attackQuery.mean() * 2, 4);

      // Test that probAtLeastOne with multiple labels works correctly for "any attack roll success"
      expect(attacksQuery.probAtLeastOne(["hit", "crit"])).toBeCloseTo(0.96, 4);

      const critChance = attacksQuery.probAtLeastOne("crit");

      expect(critChance).toBeCloseTo(0.0975, 4);

      // Check damage statistics for ALL outcome scenarios (calculated from individual attacks)
      // This gives us the statistics for "all hits, no crits" and "all crits, no hits"
      const allHitStats = attacksQuery.combinedDamageStats("hit");
      expect(allHitStats.min).toBe(12); // Two attacks, both hit min (6+6)
      expect(allHitStats.avg).toBeCloseTo(22, 1); // Two attacks, both hit avg (11+11)
      expect(allHitStats.max).toBe(32); // Two attacks, both hit max (16+16)

      const allCritStats = attacksQuery.combinedDamageStats("crit");
      expect(allCritStats.min).toBe(16); // Two attacks, both crit min (8+8)
      expect(allCritStats.avg).toBeCloseTo(36, 1); // Two attacks, both crit avg (18+18)
      expect(allCritStats.max).toBe(56); // Two attacks, both crit max (28+28)
    });
  });
});
