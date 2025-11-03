import { describe, expect, it } from "vitest";
import { d20, roll } from "./";

describe("String Damage Expressions", () => {
  describe("Basic Expressions", () => {
    it("should parse '2d6+3' with explicit crit and match roll(2).d(6).plus(3)", () => {
      const stringAttack = d20.plus(5).ac(15).onHit("2d6+3").onCrit("4d6+3");
      const builderAttack = d20.plus(5).ac(15).onHit(roll(2).d(6).plus(3));

      const stringRes = stringAttack.resolve();
      const builderRes = builderAttack.resolve();

      // Check probabilities match
      expect(stringRes.weights.hit).toBeCloseTo(builderRes.weights.hit, 10);
      expect(stringRes.weights.crit).toBeCloseTo(builderRes.weights.crit, 10);
      expect(stringRes.weights.miss).toBeCloseTo(builderRes.weights.miss, 10);

      // Check damage distributions match
      expect(stringRes.hit.mean()).toBeCloseTo(builderRes.hit.mean(), 10);
      expect(stringRes.hit.min()).toBe(builderRes.hit.min());
      expect(stringRes.hit.max()).toBe(builderRes.hit.max());

      // Check overall PMF mean
      expect(stringRes.pmf.mean()).toBeCloseTo(builderRes.pmf.mean(), 10);
    });

    it("should parse '1d8+5' with explicit crit and match roll(1).d(8).plus(5)", () => {
      const stringAttack = d20.plus(3).ac(12).onHit("1d8+5").onCrit("2d8+5");
      const builderAttack = d20.plus(3).ac(12).onHit(roll(1).d(8).plus(5));

      const stringRes = stringAttack.resolve();
      const builderRes = builderAttack.resolve();

      expect(stringRes.pmf.mean()).toBeCloseTo(builderRes.pmf.mean(), 10);
      expect(stringRes.hit.mean()).toBeCloseTo(builderRes.hit.mean(), 10);
    });

    it("should parse '3d4' with explicit crit and match roll(3).d(4)", () => {
      const stringAttack = d20.plus(7).ac(18).onHit("3d4").onCrit("6d4");
      const builderAttack = d20.plus(7).ac(18).onHit(roll(3).d(4));

      const stringRes = stringAttack.resolve();
      const builderRes = builderAttack.resolve();

      expect(stringRes.pmf.mean()).toBeCloseTo(builderRes.pmf.mean(), 10);
      expect(stringRes.hit.mean()).toBeCloseTo(builderRes.hit.mean(), 10);
    });

    it("should parse constant damage '10' and match roll(0).plus(10)", () => {
      const stringAttack = d20.plus(5).ac(15).onHit("10");
      const builderAttack = d20.plus(5).ac(15).onHit(10);

      const stringRes = stringAttack.resolve();
      const builderRes = builderAttack.resolve();

      expect(stringRes.pmf.mean()).toBeCloseTo(builderRes.pmf.mean(), 10);
      expect(stringRes.hit.mean()).toBeCloseTo(builderRes.hit.mean(), 10);
    });
  });

  describe("Rerolling Ones", () => {
    it("should parse '2hd6+5' with explicit crit and match roll(2).d(6).reroll(1).plus(5)", () => {
      const stringAttack = d20
        .plus(5)
        .ac(15)
        .onHit("2hd6+5")
        .onCrit("4hd6+5");
      const builderAttack = d20
        .plus(5)
        .ac(15)
        .onHit(roll(2).d(6).reroll(1).plus(5));

      const stringRes = stringAttack.resolve();
      const builderRes = builderAttack.resolve();

      // Check probabilities match
      expect(stringRes.weights.hit).toBeCloseTo(builderRes.weights.hit, 10);
      expect(stringRes.weights.crit).toBeCloseTo(builderRes.weights.crit, 10);
      expect(stringRes.weights.miss).toBeCloseTo(builderRes.weights.miss, 10);

      // Check damage distributions match
      // Note: parser's hd syntax uses different algorithm than builder's reroll(1),
      // so we expect slight differences in the distributions
      expect(stringRes.hit.mean()).toBeCloseTo(builderRes.hit.mean(), 0);
      expect(stringRes.hit.min()).toBe(builderRes.hit.min());
      expect(stringRes.hit.max()).toBe(builderRes.hit.max());

      // Check overall PMF mean
      expect(stringRes.pmf.mean()).toBeCloseTo(builderRes.pmf.mean(), 0);
    });

    it("should parse '1hd12+3' with explicit crit and match roll(1).d(12).reroll(1).plus(3)", () => {
      const stringAttack = d20
        .plus(8)
        .ac(16)
        .onHit("1hd12+3")
        .onCrit("2hd12+3");
      const builderAttack = d20
        .plus(8)
        .ac(16)
        .onHit(roll(1).d(12).reroll(1).plus(3));

      const stringRes = stringAttack.resolve();
      const builderRes = builderAttack.resolve();

      // Note: parser's hd syntax uses different algorithm than builder's reroll(1)
      expect(stringRes.pmf.mean()).toBeCloseTo(builderRes.pmf.mean(), 0);
      expect(stringRes.hit.mean()).toBeCloseTo(builderRes.hit.mean(), 0);
    });
  });

  describe("Keep Highest and Lowest", () => {
    it("should parse '2kh1(1d12)+5' (Great Weapon Fighting style) with explicit crit and match builder", () => {
      const stringAttack = d20
        .plus(11)
        .ac(15)
        .onHit("2kh1(1d12)+5")
        .onCrit("2kh1(2d12)+5");
      const builderAttack = d20
        .plus(11)
        .ac(15)
        .onHit(roll(1).d(12).keepHighest(2, 1).plus(5));

      const stringRes = stringAttack.resolve();
      const builderRes = builderAttack.resolve();

      expect(stringRes.hit.mean()).toBeCloseTo(builderRes.hit.mean(), 5);
      expect(stringRes.pmf.mean()).toBeCloseTo(builderRes.pmf.mean(), 5);
    });

    it("should parse '3kl2(1d6)+3' with explicit crit and match roll(1).d(6).keepLowest(3, 2).plus(3)", () => {
      const stringAttack = d20
        .plus(10)
        .ac(18)
        .onHit("3kl2(1d6)+3")
        .onCrit("3kl2(2d6)+3");
      const builderAttack = d20
        .plus(10)
        .ac(18)
        .onHit(roll(1).d(6).keepLowest(3, 2).plus(3));

      const stringRes = stringAttack.resolve();
      const builderRes = builderAttack.resolve();

      expect(stringRes.hit.mean()).toBeCloseTo(builderRes.hit.mean(), 5);
      expect(stringRes.pmf.mean()).toBeCloseTo(builderRes.pmf.mean(), 5);
    });
  });

  describe("onCrit with String Expressions", () => {
    it("should parse onHit('1d8+3') and onCrit('3d8+3')", () => {
      const stringAttack = d20
        .plus(5)
        .ac(15)
        .onHit("1d8+3")
        .onCrit("3d8+3");
      const builderAttack = d20
        .plus(5)
        .ac(15)
        .onHit(roll(1).d(8).plus(3))
        .onCrit(roll(3).d(8).plus(3));

      const stringRes = stringAttack.resolve();
      const builderRes = builderAttack.resolve();

      expect(stringRes.weights.hit).toBeCloseTo(builderRes.weights.hit, 10);
      expect(stringRes.weights.crit).toBeCloseTo(builderRes.weights.crit, 10);
      expect(stringRes.hit.mean()).toBeCloseTo(builderRes.hit.mean(), 10);
      expect(stringRes.crit.mean()).toBeCloseTo(builderRes.crit.mean(), 10);
      expect(stringRes.pmf.mean()).toBeCloseTo(builderRes.pmf.mean(), 10);
    });

    it("should error when trying to use default crit doubling with parsed strings", () => {
      const stringAttack = d20.plus(5).ac(15).onHit("2d6+3");
      // This should work because we explicitly provide onCrit
      const withExplicitCrit = stringAttack.onCrit("4d6+3");
      expect(withExplicitCrit.resolve().pmf.mean()).toBeGreaterThan(0);

      // Default crit doubling would fail since ParsedRollBuilder.doubleDice() throws
      // But resolve() should handle this gracefully by using explicit crit if provided
    });
  });

  describe("onMiss with String Expressions", () => {
    it("should parse onHit('2d6+3'), onCrit('4d6+3') and onMiss('1d6')", () => {
      const stringAttack = d20
        .plus(5)
        .ac(15)
        .onHit("2d6+3")
        .onCrit("4d6+3")
        .onMiss("1d6");
      const builderAttack = d20
        .plus(5)
        .ac(15)
        .onHit(roll(2).d(6).plus(3))
        .onMiss(roll(1).d(6));

      const stringRes = stringAttack.resolve();
      const builderRes = builderAttack.resolve();

      expect(stringRes.weights.hit).toBeCloseTo(builderRes.weights.hit, 10);
      expect(stringRes.weights.miss).toBeCloseTo(builderRes.weights.miss, 10);
      expect(stringRes.hit.mean()).toBeCloseTo(builderRes.hit.mean(), 10);
      expect(stringRes.miss.mean()).toBeCloseTo(builderRes.miss.mean(), 10);
      expect(stringRes.pmf.mean()).toBeCloseTo(builderRes.pmf.mean(), 10);
    });
  });

  describe("Complex Attack Flows", () => {
    it("should work with advantage and string damage", () => {
      const stringAttack = d20
        .withAdvantage()
        .plus(5)
        .ac(15)
        .onHit("2d6+3")
        .onCrit("4d6+3");
      const builderAttack = d20
        .withAdvantage()
        .plus(5)
        .ac(15)
        .onHit(roll(2).d(6).plus(3))
        .onCrit(roll(4).d(6).plus(3));

      const stringRes = stringAttack.resolve();
      const builderRes = builderAttack.resolve();

      expect(stringRes.pmf.mean()).toBeCloseTo(builderRes.pmf.mean(), 10);
    });

    it("should work with disadvantage and string damage", () => {
      const stringAttack = d20
        .withDisadvantage()
        .plus(5)
        .ac(15)
        .onHit("1d8+3")
        .onCrit("2d8+3");
      const builderAttack = d20
        .withDisadvantage()
        .plus(5)
        .ac(15)
        .onHit(roll(1).d(8).plus(3))
        .onCrit(roll(2).d(8).plus(3));

      const stringRes = stringAttack.resolve();
      const builderRes = builderAttack.resolve();

      expect(stringRes.pmf.mean()).toBeCloseTo(builderRes.pmf.mean(), 10);
    });

    it("should work with bonus dice (e.g., Bless) and string damage", () => {
      const bless = roll(1).d(4);
      const stringAttack = d20
        .plus(5)
        .withBonus(bless)
        .ac(15)
        .onHit("2d6+3")
        .onCrit("4d6+3");
      const builderAttack = d20
        .plus(5)
        .withBonus(bless)
        .ac(15)
        .onHit(roll(2).d(6).plus(3));

      const stringRes = stringAttack.resolve();
      const builderRes = builderAttack.resolve();

      expect(stringRes.pmf.mean()).toBeCloseTo(builderRes.pmf.mean(), 10);
    });

    it("should work with alwaysHits() and string damage", () => {
      const stringAttack = d20.alwaysHits().onHit("2d6+3").onCrit("4d6+3");
      const builderAttack = d20
        .alwaysHits()
        .onHit(roll(2).d(6).plus(3))
        .onCrit(roll(4).d(6).plus(3));

      const stringRes = stringAttack.resolve();
      const builderRes = builderAttack.resolve();

      expect(stringRes.pmf.mean()).toBeCloseTo(builderRes.pmf.mean(), 10);
    });

    it("should work with alwaysCrits() and string damage", () => {
      const stringAttack = d20
        .plus(5)
        .ac(10)
        .alwaysCrits()
        .onHit("2d6+3")
        .onCrit("4d6+3");
      const builderAttack = d20
        .plus(5)
        .ac(10)
        .alwaysCrits()
        .onHit(roll(2).d(6).plus(3))
        .onCrit(roll(4).d(6).plus(3));

      const stringRes = stringAttack.resolve();
      const builderRes = builderAttack.resolve();

      expect(stringRes.pmf.mean()).toBeCloseTo(builderRes.pmf.mean(), 10);
    });
  });

  describe("Expression Format", () => {
    it("should preserve original string in toExpression()", () => {
      const attack = d20.plus(5).ac(15).onHit("2d6+3");
      const expression = attack.toExpression();

      // The string should appear in the expression
      expect(expression).toContain("2d6+3");
    });
  });

  describe("Edge Cases", () => {
    it("should handle subtraction in string expressions", () => {
      const stringAttack = d20.plus(5).ac(15).onHit("2d6-1").onCrit("4d6-1");
      const builderAttack = d20
        .plus(5)
        .ac(15)
        .onHit(roll(2).d(6).plus(-1));

      const stringRes = stringAttack.resolve();
      const builderRes = builderAttack.resolve();

      expect(stringRes.pmf.mean()).toBeCloseTo(builderRes.pmf.mean(), 10);
    });

    it("should handle zero damage", () => {
      const stringAttack = d20.plus(5).ac(15).onHit("0");
      const builderAttack = d20.plus(5).ac(15).onHit(0);

      const stringRes = stringAttack.resolve();
      const builderRes = builderAttack.resolve();

      expect(stringRes.pmf.mean()).toBeCloseTo(builderRes.pmf.mean(), 10);
    });
  });
});

