import { describe, expect, it } from "vitest";
import { d20, roll } from "../src/builder";
import { parse } from "../src/parser/parser";
import type { DiceQuery } from "../src/pmf/query";

describe("DiceQuery.combinedWithAttribution()", () => {
  describe("Basic attribution invariants", () => {
    it("should populate attr field for all bins", () => {
      const attack = d20.plus(5).ac(15).onHit(roll(2, 6).plus(3));
      const pmf = attack.toQuery().combinedWithAttribution();

      for (const [damage, bin] of pmf.map) {
        if (damage > 0) {
          expect(bin.attr).toBeDefined();
          expect(bin.attr).not.toEqual({});
        }
      }
    });

    it("should satisfy constraint: sum(attr.values()) ≈ damage × probability", () => {
      const attack = d20.plus(5).ac(15).onHit(roll(2, 6).plus(3));
      const pmf = attack.toQuery().combinedWithAttribution();

      for (const [damage, bin] of pmf.map) {
        if (bin.attr) {
          const attrSum = Object.values(bin.attr).reduce(
            (sum, val) => sum + (val as number),
            0
          );
          const expected = damage * bin.p;
          expect(Math.abs(attrSum - expected)).toBeLessThan(1e-10);
        }
      }
    });

    it("should have non-negative attribution values", () => {
      const attack = d20.plus(5).ac(15).onHit(roll(2, 6).plus(3));
      const pmf = attack.toQuery().combinedWithAttribution();

      for (const [, bin] of pmf.map) {
        if (bin.attr) {
          for (const val of Object.values(bin.attr)) {
            expect(val as number).toBeGreaterThanOrEqual(0);
          }
        }
      }
    });

    it("should preserve p and count fields from combined", () => {
      const attack = d20.plus(5).ac(15).onHit(roll(2, 6).plus(3));
      const query = attack.toQuery();
      const withAttr = query.combinedWithAttribution();
      const regular = query.combined;

      expect(withAttr.support()).toEqual(regular.support());

      for (const damage of regular.support()) {
        const binAttr = withAttr.map.get(damage)!;
        const binRegular = regular.map.get(damage)!;

        expect(Math.abs(binAttr.p - binRegular.p)).toBeLessThan(1e-10);

        // Count should be approximately equal
        for (const outcome in binRegular.count) {
          const countAttr = binAttr.count[outcome] as number;
          const countRegular = binRegular.count[outcome] as number;
          expect(Math.abs(countAttr - countRegular)).toBeLessThan(1e-10);
        }
      }
    });
  });

  describe("Simple attack without crit", () => {
    it("should only have hit attribution for non-zero damage", () => {
      const attack = d20.plus(5).ac(15).onHit(roll(2, 6).plus(3)).noCrit();
      const pmf = attack.toQuery().combinedWithAttribution();

      for (const [damage, bin] of pmf.map) {
        if (damage > 0 && bin.attr) {
          expect(bin.attr.hit).toBeDefined();
          expect(bin.attr.hit).toBeGreaterThan(0);

          // Should not have crit attribution (noCrit explicitly disables it)
          expect(bin.attr.crit).toBeUndefined();
        }
      }
    });

    it("should match expectedDamageFrom('hit') when summed", () => {
      const attack = d20.plus(5).ac(15).onHit(roll(2, 6).plus(3)).noCrit();
      const query = attack.toQuery();
      const pmf = query.combinedWithAttribution();

      let totalHitDamage = 0;
      for (const [, bin] of pmf.map) {
        if (bin.attr?.hit) {
          totalHitDamage += bin.attr.hit as number;
        }
      }

      const expected = query.expectedDamageFrom("hit");
      expect(Math.abs(totalHitDamage - expected)).toBeLessThan(1e-9);
    });
  });

  describe("Attack with crit", () => {
    it("should have both hit and crit attribution", () => {
      const attack = d20
        .plus(5)
        .ac(15)
        .onHit(roll(2, 6).plus(3))
        .onCrit(roll(2, 6));
      const pmf = attack.toQuery().combinedWithAttribution();

      let foundHit = false;
      let foundCrit = false;
      let foundBoth = false;

      for (const [damage, bin] of pmf.map) {
        if (damage > 0 && bin.attr) {
          if (bin.attr.hit && (bin.attr.hit as number) > 0) foundHit = true;
          if (bin.attr.crit && (bin.attr.crit as number) > 0) foundCrit = true;
          if (
            bin.attr.hit &&
            bin.attr.crit &&
            (bin.attr.hit as number) > 0 &&
            (bin.attr.crit as number) > 0
          ) {
            foundBoth = true;
          }
        }
      }

      expect(foundHit).toBe(true);
      expect(foundCrit).toBe(true);
      expect(foundBoth).toBe(true);
    });

    it("should satisfy attribution constraint at bins with both outcomes", () => {
      const attack = d20
        .plus(5)
        .ac(15)
        .onHit(roll(2, 6).plus(3))
        .onCrit(roll(2, 6));
      const pmf = attack.toQuery().combinedWithAttribution();

      for (const [damage, bin] of pmf.map) {
        if (bin.attr?.hit && bin.attr?.crit) {
          const hitAttr = bin.attr.hit as number;
          const critAttr = bin.attr.crit as number;
          const attrSum = hitAttr + critAttr;
          const expected = damage * bin.p;

          expect(Math.abs(attrSum - expected)).toBeLessThan(1e-10);
        }
      }
    });

    it("should match expectedDamageFrom for each outcome", () => {
      const attack = d20
        .plus(5)
        .ac(15)
        .onHit(roll(2, 6).plus(3))
        .onCrit(roll(2, 6));
      const query = attack.toQuery();
      const pmf = query.combinedWithAttribution();

      let totalHitDamage = 0;
      let totalCritDamage = 0;
      for (const [, bin] of pmf.map) {
        if (bin.attr) {
          totalHitDamage += (bin.attr.hit as number) || 0;
          totalCritDamage += (bin.attr.crit as number) || 0;
        }
      }

      const expectedHit = query.expectedDamageFrom("hit");
      const expectedCrit = query.expectedDamageFrom("crit");

      expect(Math.abs(totalHitDamage - expectedHit)).toBeLessThan(1e-9);
      expect(Math.abs(totalCritDamage - expectedCrit)).toBeLessThan(1e-9);
    });
  });

  describe("Multiple attacks", () => {
    it("should work with multiple independent attacks", () => {
      const attack1 = d20.plus(5).ac(15).onHit(roll(2, 6).plus(3)).noCrit();
      const attack2 = d20.plus(3).ac(15).onHit(roll(1, 8).plus(2)).noCrit();
      const query = attack1.toQuery().convolve(attack2.toQuery());
      const pmf = query.combinedWithAttribution();

      for (const [damage, bin] of pmf.map) {
        if (bin.attr && damage > 0) {
          const attrSum = Object.values(bin.attr).reduce(
            (sum, val) => sum + (val as number),
            0
          );
          const expected = damage * bin.p;
          expect(Math.abs(attrSum - expected)).toBeLessThan(1e-9);
        }
      }
    });

    it("should preserve total expected damage", () => {
      const attack1 = d20.plus(5).ac(15).onHit(roll(2, 6).plus(3)).noCrit();
      const attack2 = d20.plus(3).ac(15).onHit(roll(1, 8).plus(2)).noCrit();
      const query = attack1.toQuery().convolve(attack2.toQuery());

      const pmf = query.combinedWithAttribution();

      let totalAttrDamage = 0;
      for (const [damage, bin] of pmf.map) {
        if (bin.attr) {
          // Only sum non-missNone outcomes (missNone contributes 0 damage)
          for (const [outcome, val] of Object.entries(bin.attr)) {
            if (outcome !== "missNone") {
              totalAttrDamage += val as number;
            }
          }
        }
      }

      const expectedMean = query.mean();
      expect(Math.abs(totalAttrDamage - expectedMean)).toBeLessThan(1e-6);
    });
  });

  describe("Save attacks", () => {
    it("should work with save-based attacks", () => {
      const save = roll
        .d20()
        .plus(5)
        .dc(15)
        .onSaveFailure(roll(4, 6))
        .saveHalf();
      const pmf = save.toQuery().combinedWithAttribution();

      for (const [damage, bin] of pmf.map) {
        if (damage > 0 && bin.attr) {
          const attrSum = Object.values(bin.attr).reduce(
            (sum, val) => sum + (val as number),
            0
          );
          const expected = damage * bin.p;
          expect(Math.abs(attrSum - expected)).toBeLessThan(1e-9);
        }
      }
    });

    it("should have saveFail and saveHalf attribution", () => {
      const save = roll
        .d20()
        .plus(5)
        .dc(15)
        .onSaveFailure(roll(4, 6))
        .saveHalf();
      const pmf = save.toQuery().combinedWithAttribution();

      let foundSaveFail = false;
      let foundSaveHalf = false;

      for (const [, bin] of pmf.map) {
        if (bin.attr) {
          if (bin.attr.saveFail && (bin.attr.saveFail as number) > 0)
            foundSaveFail = true;
          if (bin.attr.saveHalf && (bin.attr.saveHalf as number) > 0)
            foundSaveHalf = true;
        }
      }

      expect(foundSaveFail).toBe(true);
      expect(foundSaveHalf).toBe(true);
    });
  });

  describe("Comparison with parser", () => {
    it("should produce similar attribution structure to parser", () => {
      // Create equivalent expressions
      const builderAttack = d20
        .plus(5)
        .ac(15)
        .onHit(roll(2, 6).plus(3))
        .onCrit(roll(2, 6));
      const builderPMF = builderAttack.toQuery().combinedWithAttribution();

      const parserPMF = parse("d20+5 AC 15 * (2d6+3) crit (2d6)");

      // Both should have similar outcome types
      const builderOutcomes = new Set<string>();
      const parserOutcomes = new Set<string>();

      for (const [damage, bin] of builderPMF.map) {
        if (bin.attr && damage > 0) {
          // Only include outcomes with non-zero attribution
          for (const outcome in bin.attr) {
            if ((bin.attr[outcome] as number) > 1e-10) {
              builderOutcomes.add(outcome);
            }
          }
        }
      }

      for (const [damage, bin] of parserPMF.map) {
        if (bin.attr && damage > 0) {
          for (const outcome in bin.attr) {
            if ((bin.attr[outcome] as number) > 1e-10) {
              parserOutcomes.add(outcome);
            }
          }
        }
      }

      // Should have same outcome types (hit, crit)
      expect(builderOutcomes).toEqual(parserOutcomes);
    });

    it("should have approximately equal attribution for equivalent expressions", () => {
      const builderAttack = d20
        .plus(5)
        .ac(15)
        .onHit(roll(2, 6).plus(3))
        .onCrit(roll(2, 6));
      const builderQuery = builderAttack.toQuery();
      const builderPMF = builderQuery.combinedWithAttribution();

      const parserPMF = parse("d20+5 AC 15 * (2d6+3) crit (2d6)");
      const parserQuery = parserPMF.query();

      // Compare expected damage from each outcome type
      const outcomes = ["hit", "crit", "missNone"] as const;

      for (const outcome of outcomes) {
        const builderExpected = builderQuery.expectedDamageFrom(outcome);
        const parserExpected = parserQuery.expectedDamageFrom(outcome);

        expect(Math.abs(builderExpected - parserExpected)).toBeLessThan(0.1);
      }

      // Compare attribution sums
      let builderHitTotal = 0;
      let builderCritTotal = 0;
      for (const [, bin] of builderPMF.map) {
        if (bin.attr) {
          builderHitTotal += (bin.attr.hit as number) || 0;
          builderCritTotal += (bin.attr.crit as number) || 0;
        }
      }

      let parserHitTotal = 0;
      let parserCritTotal = 0;
      for (const [, bin] of parserPMF.map) {
        if (bin.attr) {
          parserHitTotal += (bin.attr.hit as number) || 0;
          parserCritTotal += (bin.attr.crit as number) || 0;
        }
      }

      expect(Math.abs(builderHitTotal - parserHitTotal)).toBeLessThan(0.1);
      expect(Math.abs(builderCritTotal - parserCritTotal)).toBeLessThan(0.1);
    });
  });

  describe("Caching", () => {
    it("should cache the result", () => {
      const attack = d20.plus(5).ac(15).onHit(roll(2, 6).plus(3));
      const query = attack.toQuery();

      const pmf1 = query.combinedWithAttribution();
      const pmf2 = query.combinedWithAttribution();

      // Should return the same instance
      expect(pmf1).toBe(pmf2);
    });

    it("should skip recomputation when attr already exists (parser PMFs)", () => {
      const parserPMF = parse("d20+5 AC 15 * (2d6+3) crit (2d6)");

      // Parser PMFs already have attr
      let hasAttr = false;
      for (const [damage, bin] of parserPMF.map) {
        if (damage > 0 && bin.attr && Object.keys(bin.attr).length > 0) {
          hasAttr = true;
          break;
        }
      }
      expect(hasAttr).toBe(true);

      // withAttribution should return the same instance (fast path)
      const withAttr = parserPMF.withAttribution();
      expect(withAttr).toBe(parserPMF);
    });

    it("should compute attr for builder PMFs (slow path)", () => {
      const builderPMF = d20.plus(5).ac(15).onHit(roll(2, 6).plus(3)).pmf;

      // Builder PMFs don't have attr initially
      let hasAttr = false;
      for (const [damage, bin] of builderPMF.map) {
        if (damage > 0 && bin.attr && Object.keys(bin.attr).length > 0) {
          hasAttr = true;
          break;
        }
      }
      expect(hasAttr).toBe(false);

      // withAttribution should return a new instance
      const withAttr = builderPMF.withAttribution();
      expect(withAttr).not.toBe(builderPMF);

      // And it should have attr
      let hasAttrAfter = false;
      for (const [damage, bin] of withAttr.map) {
        if (damage > 0 && bin.attr && Object.keys(bin.attr).length > 0) {
          hasAttrAfter = true;
          break;
        }
      }
      expect(hasAttrAfter).toBe(true);
    });
  });

  describe("Edge cases", () => {
    it("should work with zero damage outcomes", () => {
      const attack = d20.plus(5).ac(15).onHit(0);
      const pmf = attack.toQuery().combinedWithAttribution();

      // Should have attribution at damage=0
      const zeroBin = pmf.map.get(0);
      expect(zeroBin).toBeDefined();

      if (zeroBin?.attr) {
        const attrSum = Object.values(zeroBin.attr).reduce(
          (sum, val) => sum + (val as number),
          0
        );
        // At damage=0, attr sum should be 0 regardless of probability
        expect(attrSum).toBe(0);
      }
    });

    it("should work with single PMF", () => {
      const attack = d20.plus(5).ac(15).onHit(roll(1, 6));
      const pmf = attack.toQuery().combinedWithAttribution();

      for (const [damage, bin] of pmf.map) {
        if (bin.attr && damage > 0) {
          const attrSum = Object.values(bin.attr).reduce(
            (sum, val) => sum + (val as number),
            0
          );
          const expected = damage * bin.p;
          expect(Math.abs(attrSum - expected)).toBeLessThan(1e-10);
        }
      }
    });

    it("should work with advantage/disadvantage", () => {
      const attack = d20
        .withAdvantage()
        .plus(5)
        .ac(15)
        .onHit(roll(2, 6).plus(3));
      const pmf = attack.toQuery().combinedWithAttribution();

      for (const [damage, bin] of pmf.map) {
        if (bin.attr && damage > 0) {
          const attrSum = Object.values(bin.attr).reduce(
            (sum, val) => sum + (val as number),
            0
          );
          const expected = damage * bin.p;
          expect(Math.abs(attrSum - expected)).toBeLessThan(1e-10);
        }
      }
    });
  });

  describe("Integration with chart methods", () => {
    it("should work with toDamageAttributionChartSeries", () => {
      const attack = d20
        .plus(5)
        .ac(15)
        .onHit(roll(2, 6).plus(3))
        .onCrit(roll(2, 6));
      const query = attack.toQuery();

      // Replace combined with attributed version
      const attrQuery = new (query.constructor as typeof DiceQuery)(
        query.singles,
        query.combinedWithAttribution()
      );

      const chartData = attrQuery.toDamageAttributionChartSeries();

      expect(chartData.support.length).toBeGreaterThan(0);
      expect(chartData.outcomes.length).toBeGreaterThan(0);
      expect(chartData.data).toBeDefined();

      // Should have hit and crit in outcomes
      expect(chartData.outcomes).toContain("hit");
      expect(chartData.outcomes).toContain("crit");
    });
  });

  describe("Performance", () => {
    it("should complete in reasonable time for typical scenarios", () => {
      const attacks = [
        d20.plus(5).ac(15).onHit(roll(2, 6).plus(3)).onCrit(roll(2, 6)),
        d20.plus(5).ac(15).onHit(roll(1, 8).plus(4)),
        d20.plus(3).ac(15).onHit(roll(1, 6).plus(2)),
      ];

      const query = attacks.reduce(
        (q, attack) => q.convolve(attack.toQuery()),
        attacks[0].toQuery()
      );

      const start = Date.now();
      const pmf = query.combinedWithAttribution();
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(100); // Should complete in < 100ms
      expect(pmf.support().length).toBeGreaterThan(0);
    });
  });
});
