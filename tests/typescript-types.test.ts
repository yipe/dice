/**
 * Test suite to verify all TypeScript type definitions are properly exported/
 */

import { describe, expect, it } from "vitest";
import {
  AttackBuilder,
  d,
  d20,
  roll,
  type ACBuilder,
  type DCBuilder,
  type RollBuilder,
  type SaveBuilder,
} from "../src/builder/index";

describe("TypeScript Type Definitions", () => {
  describe("RollBuilder methods", () => {
    it("should have .ac() method that returns ACBuilder", () => {
      const result: ACBuilder = d20.plus(5).ac(20);
      expect(result.toExpression()).toBe("(d20 + 5 AC 20)");
    });

    it("should have .dc() method that returns DCBuilder", () => {
      const result: DCBuilder = d20.plus(3).dc(15);
      expect(result.toExpression()).toBe("(d20 + 3 DC 15)");
    });
  });

  describe("ACBuilder methods", () => {
    it("should have .critOn() method", () => {
      const result = d20.plus(5).ac(18).critOn(19);
      expect(result.toExpression()).toBe("(d20 + 5 AC 18)");
      expect(result.critThreshold).toBe(19);
    });

    it("should have .onHit() method with string parameter", () => {
      const result: AttackBuilder = d20.plus(5).ac(20).onHit("2d6+3");
      expect(result.toExpression()).toContain("(2d6+3)");
    });

    it("should have .onHit() method with number parameter", () => {
      const result: AttackBuilder = d20.plus(5).ac(20).onHit(5);
      expect(result.toExpression()).toContain("(5)");
    });

    it("should have .onHit() method with RollBuilder parameter", () => {
      const damage = d(6).plus(3);
      const result: AttackBuilder = d20.plus(5).ac(20).onHit(damage);
      expect(result.toExpression()).toContain("1d6 + 3");
    });
  });

  describe("AttackBuilder methods", () => {
    it("should have .onCrit() method with string parameter", () => {
      const result: AttackBuilder = d20
        .plus(5)
        .ac(20)
        .onHit("2d6+3")
        .onCrit("2d6");
      expect(result.toExpression()).toContain("crit (2d6)");
    });

    it("should have .onCrit() method with number parameter", () => {
      const result: AttackBuilder = d20.plus(5).ac(20).onHit("1d8+4").onCrit(8);
      expect(result.toExpression()).toContain("crit (8)");
    });

    it("should have .onMiss() method with string parameter", () => {
      const result: AttackBuilder = d20
        .plus(5)
        .ac(20)
        .onHit("2d6+3")
        .onMiss("1d6");
      expect(result.toExpression()).toContain("miss (1d6)");
    });

    it("should have .onMiss() method with number parameter", () => {
      const result: AttackBuilder = d20.plus(5).ac(20).onHit("2d6+3").onMiss(5);
      expect(result.toExpression()).toContain("miss (5)");
    });

    it("should calculate attack probabilities correctly", () => {
      const attack = d20.plus(5).ac(20).onHit("1d8+4").onCrit("1d8");
      const resolved = attack.resolve();

      expect(resolved.weights.hit).toBeGreaterThan(0);
      expect(resolved.weights.crit).toBeGreaterThan(0);
      expect(resolved.weights.miss).toBeGreaterThan(0);

      // Total probability should sum to 1
      const total =
        resolved.weights.hit + resolved.weights.crit + resolved.weights.miss;
      expect(total).toBeCloseTo(1, 10);
    });
  });

  describe("DCBuilder methods", () => {
    it("should have .onSaveFailure() method with string parameter", () => {
      const result: SaveBuilder = d20.plus(3).dc(15).onSaveFailure("8d6");
      expect(result.toExpression()).toContain("(8d6)");
    });

    it("should have .onSaveFailure() method with number parameter", () => {
      const result: SaveBuilder = d20.plus(3).dc(15).onSaveFailure(20);
      expect(result.toExpression()).toContain("(20)");
    });

    it("should have .onSaveFailure() method with RollBuilder parameter", () => {
      const damage = d(6).plus(d(6)).plus(d(6));
      const result: SaveBuilder = d20.plus(3).dc(15).onSaveFailure(damage);
      expect(result.toExpression()).toContain("3d6");
    });
  });

  describe("SaveBuilder methods", () => {
    it("should have .saveHalf() method", () => {
      const result: SaveBuilder = d20
        .plus(3)
        .dc(15)
        .onSaveFailure("8d6")
        .saveHalf();
      expect(result.toExpression()).toContain("save half");
    });

    it("should calculate save probabilities correctly", () => {
      const save = d20.plus(5).dc(16).onSaveFailure("8d6").saveHalf();
      const resolved = save.resolve();

      expect(resolved.weights.success).toBeGreaterThan(0);
      expect(resolved.weights.fail).toBeGreaterThan(0);

      // Total probability should sum to 1
      const total = resolved.weights.success + resolved.weights.fail;
      expect(total).toBeCloseTo(1, 10);
    });
  });

  describe("d() function", () => {
    it("should accept string parameter", () => {
      const result: RollBuilder = d("2d6+3");
      expect(result.toExpression()).toBe("2d6+3");
    });

    it("should accept number parameter", () => {
      const result: RollBuilder = d(6);
      expect(result.toExpression()).toBe("1d6");
    });

    it("should parse complex expressions", () => {
      const result: RollBuilder = d("3d8+2d6+5");
      expect(result.toExpression()).toBe("3d8+2d6+5");
    });
  });

  describe("roll.d() factory method", () => {
    it("should accept string parameter", () => {
      const result: RollBuilder = roll.d("2d6+3");
      expect(result.toExpression()).toBe("2d6+3");
    });

    it("should accept number parameter", () => {
      const result: RollBuilder = roll.d(6);
      expect(result.toExpression()).toBe("1d6");
    });
  });

  describe("Complex attack patterns (from user's DPR project)", () => {
    it("should support full attack roll pattern", () => {
      const attack = d20
        .plus(8)
        .ac(16)
        .critOn(19)
        .onHit("1d8+4")
        .onCrit("1d8")
        .onMiss(0);

      expect(attack.toExpression()).toBe(
        "(d20 + 8 AC 16) * (1d8+4) xcrit2 (1d8) miss (0)"
      );

      const result = attack.resolve();
      const hitChance = result.weights.hit + result.weights.crit;
      expect(hitChance).toBeGreaterThan(0.6); // Should be around 65%
      expect(hitChance).toBeLessThan(0.7);
    });

    it("should support champion fighter with expanded crit range", () => {
      // Need to specify crit damage to get separate crit weight
      const champion = d20
        .plus(5)
        .ac(20)
        .critOn(19)
        .onHit("1d8+4")
        .onCrit("1d8");

      const result = champion.resolve();
      // Champion should have higher crit rate (10% instead of 5%)
      // With AC 20 and +5 to hit, need to roll 15+ (30% chance)
      // Natural 19-20 are crits (10% of total), but only if they hit
      expect(result.weights.crit).toBeGreaterThan(0.09);
      expect(result.weights.crit).toBeLessThan(0.11);
    });

    it("should support attack with miss damage", () => {
      const attack = d20.plus(5).ac(20).onHit("2d6+3").onMiss(5);

      const result = attack.resolve();
      const avgDamage = result.pmf.query().mean();

      // Even with misses, should have some damage
      expect(avgDamage).toBeGreaterThan(0);
    });
  });

  describe("Complex save patterns (from user's DPR project)", () => {
    it("should support full saving throw pattern", () => {
      const fireball = d20.plus(5).dc(16).onSaveFailure("8d6").saveHalf();

      expect(fireball.toExpression()).toBe("(d20 + 5 DC 16) * (8d6) save half");

      const result = fireball.resolve();
      const avgDamage = result.pmf.query().mean();

      // Average of 8d6 is 28, with 50% save rate and half damage on save
      // Expected: 0.5 * 28 + 0.5 * 14 = 21
      expect(avgDamage).toBeGreaterThan(19);
      expect(avgDamage).toBeLessThan(23);
    });

    it("should calculate save success rate correctly", () => {
      const save = d20.plus(5).dc(16).onSaveFailure("8d6").saveHalf();
      const result = save.resolve();

      // With +5 bonus and DC 16, need to roll 11+
      // Success rate should be 50%
      expect(result.weights.success).toBeCloseTo(0.5, 1);
    });
  });

  describe("Type exports", () => {
    it("should export AttackBuilder as a type and class", () => {
      const attack = d20.plus(5).ac(20).onHit("1d8+4");
      expect(attack).toBeInstanceOf(AttackBuilder);
    });

    it("should allow AttackBuilder as a type annotation", () => {
      const createAttack = (): AttackBuilder => {
        return d20.plus(5).ac(20).onHit("1d8+4");
      };

      const attack = createAttack();
      expect(attack).toBeInstanceOf(AttackBuilder);
    });
  });

  describe("Method chaining", () => {
    it("should support full method chain for attacks", () => {
      const result = d20
        .plus(8)
        .withAdvantage()
        .ac(16)
        .critOn(19)
        .onHit("2d6+5")
        .onCrit("2d6")
        .onMiss(3);

      expect(result).toBeInstanceOf(AttackBuilder);
      expect(result.toExpression()).toContain("AC 16");
      expect(result.toExpression()).toContain("2d6+5");
    });

    it("should support full method chain for saves", () => {
      const result = d20
        .plus(5)
        .withAdvantage()
        .dc(15)
        .onSaveFailure("10d6")
        .saveHalf();

      expect(result.toExpression()).toContain("DC 15");
      expect(result.toExpression()).toContain("save half");
    });
  });
});
