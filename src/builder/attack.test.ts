import { describe, expect, it } from "vitest";
import { d20, d4, d6, d8, roll } from "./";
import type { AttackBuilder } from "./attack";

describe("Attack Builder", () => {
  it("should build an attack roll", () => {
    const attackRoll: AttackBuilder = d20.plus(5).ac(15).onHit(d8);
    expect(attackRoll.toExpression()).toBe(
      "(d20 + 5 AC 15) * (1d8) crit (2d8)"
    );
    expect(attackRoll).toBeDefined();
  });
});

describe("AttackBuilder", () => {
  describe("Immutability", () => {
    it("should be immutable", () => {
      const check = d20.plus(5).ac(15);
      const hitEffect = roll(2).d(6);
      const critEffect = roll(4).d(6);

      const attackBuilder = check.onHit(hitEffect).onCrit(critEffect);

      const originalExpression = attackBuilder.toExpression();

      // "Mutate" by creating a new builder
      const newCheck = check.ac(20);
      expect(newCheck).not.toBe(check);

      // The original attackBuilder should be unaffected
      expect(attackBuilder.toExpression()).toBe(originalExpression);
      expect(attackBuilder.check.attackConfig.ac).toBe(15);
    });
  });

  describe("Mathematical Correctness", () => {
    it("should calculate correct probabilities for a simple attack", () => {
      const attack = d20.plus(5).ac(15).onHit(1, 8, 3);
      const resolution = attack.resolve();

      expect(resolution.weights.miss).toBeCloseTo(0.45);
      expect(resolution.weights.hit).toBeCloseTo(0.5);
      expect(resolution.weights.crit).toBeCloseTo(0.05);

      const expectedMean = 0.5 * 7.5 + 0.05 * 12;
      expect(resolution.pmf.mean()).toBeCloseTo(expectedMean);
    });

    it("should calculate correct probabilities with advantage", () => {
      const attack = d20.withAdvantage().plus(5).ac(15).onHit(1, 8, 3);
      const resolution = attack.resolve();

      expect(resolution.weights.miss).toBeCloseTo(0.2025);
      expect(resolution.weights.hit).toBeCloseTo(0.7);
      expect(resolution.weights.crit).toBeCloseTo(0.0975);

      const expectedMean = 0.7 * 7.5 + 0.0975 * 12 + 0.2025 * 0;
      expect(resolution.pmf.mean()).toBeCloseTo(expectedMean);
    });

    it("should calculate correct probabilities with disadvantage", () => {
      const attack = d20.withDisadvantage().plus(5).ac(15).onHit(1, 8, 3);
      const resolution = attack.resolve();

      expect(resolution.weights.miss).toBeCloseTo(0.6975);
      expect(resolution.weights.hit).toBeCloseTo(0.3);
      expect(resolution.weights.crit).toBeCloseTo(0.0025);

      const expectedMean = 0.3 * 7.5 + 0.0025 * 12;
      expect(resolution.pmf.mean()).toBeCloseTo(expectedMean);
    });

    it("should handle onMiss effects", () => {
      const attack = d20.plus(5).ac(15).onHit(1, 8, 3).onMiss(d4);
      const resolution = attack.resolve();

      // Probabilities are for a simple attack
      expect(resolution.weights.miss).toBeCloseTo(0.45);
      expect(resolution.weights.hit).toBeCloseTo(0.5);
      expect(resolution.weights.crit).toBeCloseTo(0.05);

      const expectedMean = 0.5 * 7.5 + 0.05 * 12 + 0.45 * 2.5;
      expect(resolution.pmf.mean()).toBeCloseTo(expectedMean);
    });

    it("should handle onCrit effects", () => {
      const attack = d20.plus(5).ac(15).onHit(1, 8, 3).onCrit(3, 8, 3);
      const resolution = attack.resolve();

      // Probabilities are for a simple attack
      expect(resolution.weights.miss).toBeCloseTo(0.45);
      expect(resolution.weights.hit).toBeCloseTo(0.5);
      expect(resolution.weights.crit).toBeCloseTo(0.05);

      const expectedMean = 0.5 * 7.5 + 0.05 * 16.5;
      expect(resolution.pmf.mean()).toBeCloseTo(expectedMean);
    });

    it("should handle noCrit()", () => {
      const attack = d20.plus(5).ac(15).onHit(1, 8, 3).noCrit();
      const resolution = attack.resolve();

      // With noCrit, the crit chance is rolled into the hit chance.
      // There is no separate damage for a crit.
      expect(resolution.weights.miss).toBeCloseTo(0.45);
      expect(resolution.weights.hit).toBeCloseTo(0.55); // 0.5 hit + 0.05 crit
      expect(resolution.weights.crit).toBeCloseTo(0);
      const expectedMean = 0.55 * 7.5;
      expect(resolution.pmf.mean()).toBeCloseTo(expectedMean);
    });

    it("should handle bonus dice", () => {
      const bless = d4;
      const attack = d20.plus(5).withBonus(bless).ac(15).onHit(1, 8, 3);
      const resolution = attack.resolve();

      const psuccess = 0.675;
      const pcrit = 0.05;
      const phit = psuccess - pcrit;
      const pmiss = 1 - psuccess;

      expect(resolution.weights.miss).toBeCloseTo(pmiss);
      expect(resolution.weights.hit).toBeCloseTo(phit);
      expect(resolution.weights.crit).toBeCloseTo(pcrit);

      const expectedMean = phit * 7.5 + pcrit * 12;
      expect(resolution.pmf.mean()).toBeCloseTo(expectedMean);
    });
  });

  describe("Edge Cases", () => {
    it("should handle an attack with no onHit effect", () => {
      const check = d20.plus(5).ac(15);
      const pmf = check.toPMF();

      expect(pmf.mean()).toBeCloseTo(11);
      expect(pmf.min()).toBe(0);
      expect(pmf.max()).toBe(25);
    });

    it("should handle a guaranteed hit scenario but still miss on a 1", () => {
      const attack = d20.plus(20).ac(5).onHit(d6);
      const resolution = attack.resolve();

      expect(resolution.weights.miss).toBeCloseTo(0.05);
      expect(resolution.weights.hit).toBeCloseTo(0.9);
      expect(resolution.weights.crit).toBeCloseTo(0.05);
      const expectedMean = 0.9 * 3.5 + 0.05 * 7;
      expect(resolution.pmf.mean()).toBeCloseTo(expectedMean);
    });

    it("should handle an impossible hit scenario but still crit on a 20", () => {
      const attack = d20.plus(0).ac(30).onHit(d6);
      const resolution = attack.resolve();

      expect(resolution.weights.miss).toBeCloseTo(0.95);
      expect(resolution.weights.hit).toBeCloseTo(0);
      expect(resolution.weights.crit).toBeCloseTo(0.05);
      const expectedMean = 0.05 * 7;
      expect(resolution.pmf.mean()).toBeCloseTo(expectedMean);
    });

    it("should still miss on a natural 1 even with high bonuses", () => {
      const attack = d20.plus(20).ac(10).onHit(d6);
      const resolution = attack.resolve();

      expect(resolution.weights.miss).toBeCloseTo(0.05);
      expect(resolution.weights.hit).toBeCloseTo(0.9);
      expect(resolution.weights.crit).toBeCloseTo(0.05);
      const expectedMean = 0.9 * 3.5 + 0.05 * 7;
      expect(resolution.pmf.mean()).toBeCloseTo(expectedMean);
    });

    it("should still miss on a natural 1 with advantage", () => {
      const attack = d20.withAdvantage().plus(20).ac(10).onHit(d6);
      const resolution = attack.resolve();

      expect(resolution.weights.miss).toBeCloseTo(1 / 400);
      expect(resolution.weights.crit).toBeCloseTo(39 / 400);
      expect(resolution.weights.hit).toBeCloseTo(1 - 40 / 400);
    });

    it("should still miss on a natural 1 with disadvantage", () => {
      const attack = d20.withDisadvantage().plus(20).ac(10).onHit(d6);
      const resolution = attack.resolve();

      expect(resolution.weights.miss).toBeCloseTo(39 / 400);
      expect(resolution.weights.crit).toBeCloseTo(1 / 400);
      expect(resolution.weights.hit).toBeCloseTo(1 - 40 / 400);
    });
  });

  describe("Complex Attack Strings", () => {
    it("should double crit dice for keepHighest", () => {
      const attack = d20
        .plus(13)
        .ac(20)
        .onHit(roll(1).d(4).keepHighest(2, 1).plus(2));
      expect(attack.toExpression()).toBe(
        "(d20 + 13 AC 20) * (2kh1(1d4) + 2) crit (2kh1(2d4) + 2)"
      );
    });

    it("should double crit dice for keepLowest", () => {
      const attack = d20
        .plus(10)
        .ac(18)
        .onHit(roll(1).d(6).keepLowest(3, 2).plus(3));
      expect(attack.toExpression()).toBe(
        "(d20 + 10 AC 18) * (3kl2(1d6) + 3) crit (3kl2(2d6) + 3)"
      );
    });

    it("should handle 2kh1(1d12) with correct expected value", () => {
      const attack = d20
        .plus(11)
        .ac(15)
        .onHit(roll(1).d(12).keepHighest(2, 1).plus(5));
      expect(attack.toExpression()).toBe(
        "(d20 + 11 AC 15) * (2kh1(1d12) + 5) crit (2kh1(2d12) + 5)"
      );

      // Test the expected value of 2kh1(1d12) component
      const keepHighestComponent = roll(1).d(12).keepHighest(2, 1);
      const pmf = keepHighestComponent.toPMF();

      // Expected value should be approximately 8.4861 according to mathematical calculation
      expect(pmf.mean()).toBeCloseTo(8.4861, 3);

      // Test the full damage roll expected value
      const damageRoll = roll(1).d(12).keepHighest(2, 1).plus(5);
      expect(damageRoll.toPMF().mean()).toBeCloseTo(13.4861, 3);
      //
      // Test attack resolution
      const resolution = attack.resolve();
      expect(resolution.weights.hit).toBeCloseTo(0.8); // hits on 4-19 (d20+11 vs AC 15)
      expect(resolution.weights.crit).toBeCloseTo(0.05); // crits on 20
      expect(resolution.weights.miss).toBeCloseTo(0.15); // misses on 1-3

      // Expected DPR calculation:
      // Normal hit: 0.80 * 13.4861 ≈ 10.789
      // Crit: 0.05 * (5 + E[2kh1(2d12)]) = 0.05 * (5 + 15.7861) ≈ 1.039
      // Total DPR ≈ 11.828
      const expectedDPR = 11.8282;
      expect(resolution.pmf.mean()).toBeCloseTo(expectedDPR, 2);
    });
  });
});
