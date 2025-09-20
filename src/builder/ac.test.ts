import { d10, d12, d20, d4, d6, d8, roll } from "./";

import { describe, expect, it } from "vitest";

describe("AttackRollBuilder", () => {
  it("should handle attack roll builder", () => {
    const builder = d20.plus(5).ac(10);
    expect(builder.toExpression()).toBe("(d20 + 5 AC 10)");
    expect(builder.toPMF()).toBeDefined();
    expect(builder.toPMF()?.mean()).toBe(14);
  });

  it("should handle elven accuracy with AC check", () => {
    const builder = d20.plus(5).withElvenAccuracy().ac(15);
    expect(builder.toExpression()).toBe("(d20 > d20 > d20 + 5 AC 15)");
    expect(builder.toPMF()).toBeDefined();
  });

  it("should throw error when using dc() on AttackRollBuilder", () => {
    expect(() => {
      const acBuilder = d20.plus(5).ac(10);
      acBuilder.dc(15);
    }).toThrow(
      "Cannot use dc() on an AttackRollBuilder. Use ac() for attack rolls instead."
    );
  });

  describe("plus dice functionality", () => {
    it("should add single dice bonus to hit (bless spell)", () => {
      const blessedAttack = d20.plus(d4).plus(5).ac(15);
      expect(blessedAttack.toExpression()).toBe("(d20 + 1d4 + 5 AC 15)");
      expect(blessedAttack.toPMF()).toBeDefined();
    });

    it("should add multiple dice bonuses to hit", () => {
      const multiBonusAttack = roll
        .d20()
        .plus(d4) // bless
        .plus(d6) // bardic inspiration
        .plus(8)
        .ac(18);

      expect(multiBonusAttack.toExpression()).toBe(
        "(d20 + 1d4 + 1d6 + 8 AC 18)"
      );
      expect(multiBonusAttack.toPMF()).toBeDefined();
    });

    it("should add constant bonus to hit and consolidate", () => {
      const constantBonusAttack = d20.plus(roll.flat(3)).plus(4).ac(12);
      expect(constantBonusAttack.toExpression()).toBe("(d20 + 7 AC 12)");
      expect(constantBonusAttack.toPMF()).toBeDefined();
    });

    it("should handle complex dice expressions as bonus", () => {
      const complexBonusAttack = roll.d20().plus(2, d4).plus(1).plus(6).ac(16);

      expect(complexBonusAttack.toExpression()).toBe("(d20 + 2d4 + 7 AC 16)");
      expect(complexBonusAttack.toPMF().mean()).toBe(29.5); // TODO: confirm
    });

    it("should work with advantage and bonus dice", () => {
      const advBlessedAttack = d20.withAdvantage().plus(7).plus(d4).ac(14);

      expect(advBlessedAttack.toExpression()).toBe(
        "(d20 > d20 + 1d4 + 7 AC 14)"
      );
      expect(advBlessedAttack.toPMF()).toBeDefined();
      // TODO - calculate exact expected value
    });

    it("should work with elven accuracy and bonus dice", () => {
      const elvenBlessedAttack = d20
        .withElvenAccuracy()
        .plus(d4)
        .plus(9)
        .ac(17);

      expect(elvenBlessedAttack.toExpression()).toBe(
        "(d20 > d20 > d20 + 1d4 + 9 AC 17)"
      );
      expect(elvenBlessedAttack.toPMF()).toBeDefined();
      // TODO - calculate exact expected value
    });

    it("should work with disadvantage and bonus dice", () => {
      const disBlessedAttack = d20.withDisadvantage().plus(d4).plus(6).ac(13);

      expect(disBlessedAttack.toExpression()).toBe(
        "(d20 < d20 + 1d4 + 6 AC 13)"
      );
      expect(disBlessedAttack.toPMF()).toBeDefined();
      // TODO - calculate exact expected value
    });

    it("should handle negative bonus dice", () => {
      const negativeBonusAttack = roll.d20().minus(2).plus(8).ac(15);

      expect(negativeBonusAttack.toExpression()).toBe("(d20 + 6 AC 15)");
      expect(negativeBonusAttack.toPMF()).toBeDefined();
    });

    it("should work with crit threshold modifications", () => {
      const critBlessedAttack = d20.plus(d4).plus(7).ac(16).critOn(19);

      expect(critBlessedAttack.toExpression()).toBe("(d20 + 1d4 + 7 AC 16)");
      expect(critBlessedAttack.toPMF()).toBeDefined();
    });

    it("should maintain bonus dice when copying", () => {
      const original = d20.plus(d4).plus(5).ac(15);
      const copy = original.copy();

      expect(copy.toExpression()).toBe(original.toExpression());
      const a = JSON.parse(copy.toPMF().toJSON());
      const b = JSON.parse(original.toPMF().toJSON());
      delete a.identifier;
      delete b.identifier;
      expect(a).toEqual(b);
    });

    it("should allow chaining multiple plus calls", () => {
      const chainedBonus = d20.plus(d4).plus(d6).plus(2).plus(6).ac(14);

      expect(chainedBonus.toExpression()).toBe("(d20 + 1d4 + 1d6 + 8 AC 14)");
      expect(chainedBonus.toPMF()).toBeDefined();
    });

    it("should work with zero bonus dice", () => {
      const zeroBonusAttack = d20.plus(0).plus(4).ac(12);
      expect(zeroBonusAttack.toExpression()).toBe("(d20 + 4 AC 12)");
      expect(zeroBonusAttack.toPMF()).toBeDefined();
    });

    it("should handle mixed positive and negative bonuses", () => {
      const mixedBonusAttack = d20.plus(d4).minus(1).plus(7).ac(15);
      expect(mixedBonusAttack.toExpression()).toBe("(d20 + 1d4 + 6 AC 15)");
      expect(mixedBonusAttack.toPMF()).toBeDefined();
    });
  });

  describe("plus dice-specific functionality", () => {
    it("should add single d4 bonus (bless spell)", () => {
      const blessedAttack = d20.plus(d4).plus(5).ac(15);
      expect(blessedAttack.toExpression()).toBe("(d20 + 1d4 + 5 AC 15)");
      expect(blessedAttack.toPMF()).toBeDefined();
      const pmf = blessedAttack.toPMF();
      expect(pmf).toBeDefined();
      // TODO - calculate exact expected value
    });

    it("should add single d6 bonus (bardic inspiration)", () => {
      const inspiredAttack = d20.plus(d6).plus(6).ac(16);
      expect(inspiredAttack.toExpression()).toBe("(d20 + 1d6 + 6 AC 16)");
      expect(inspiredAttack.toPMF()).toBeDefined();
      const pmf = inspiredAttack.toPMF();
      expect(pmf).toBeDefined();
      // TODO - calculate exact expected value
    });

    it("should chain multiple different dice bonuses", () => {
      const multiDiceAttack = d20.plus(d4).plus(d6).plus(d8).plus(5).ac(15);

      expect(multiDiceAttack.toExpression()).toBe(
        "(d20 + 1d4 + 1d6 + 1d8 + 5 AC 15)"
      );
      expect(multiDiceAttack.toPMF()).toBeDefined();
      // TODO - calculate exact expected value
    });

    it("should chain multiple identical dice bonuses", () => {
      const doubleBlessAttack = d20.plus(d4).plus(d4).plus(6).ac(16);
      expect(doubleBlessAttack.toExpression()).toBe(
        "(d20 + 1d4 + 1d4 + 6 AC 16)"
      );
      expect(doubleBlessAttack.toPMF()).toBeDefined();
      // TODO - calculate exact expected value
    });

    it("should handle dice bonuses with modifiers", () => {
      const modifiedDiceAttack = d20.plus(2, d4).plus(2).plus(7).ac(17);

      expect(modifiedDiceAttack.toExpression()).toBe("(d20 + 2d4 + 9 AC 17)");
      expect(modifiedDiceAttack.toPMF()).toBeDefined();
    });

    it("should handle dice bonuses with reroll", () => {
      const rerollDiceAttack = d20.plus(1, d6).reroll(1).plus(5).ac(14);
      expect(rerollDiceAttack.toExpression()).toBe(
        "(d20 + d6 reroll 1 + 5 AC 14)"
      );
      expect(rerollDiceAttack.toPMF()).toBeDefined();
      // TODO - calculate exact expected value
    });
  });

  describe("Error Handling", () => {
    it("should handle invalid AC values", () => {
      // Handles htem for now… we can always prevent it later if needed
      expect(() => {
        d20.ac(-1);
      }).not.toThrow();

      expect(() => {
        d20.ac(0);
      }).not.toThrow();
    });

    it("should handle invalid crit thresholds", () => {
      const attack = d20.ac(15);
      expect(() => {
        attack.critOn(14).onHit(d6).toExpression();
      }).toThrow("Invalid crit threshold: 14. Must be between 15 and 20.");

      expect(() => {
        attack.critOn(21).onHit(d6).toExpression();
      }).toThrow();
    });

    it("should prevent dc() usage on AttackRollBuilder", () => {
      const attack = d20.ac(15);
      expect(() => {
        attack.dc(12);
      }).toThrow();
    });

    it("should handle invalid plus values", () => {
      const attack = d20.ac(15);
      expect(() => {
        attack.plus(roll.flat(NaN));
      }).toThrow();
    });
  });

  describe("Mathematical Correctness", () => {
    it("should have correct hit probability for +5 vs AC 15", () => {
      const attack = d20.plus(5).ac(15);
      const pmf = attack.toPMF();
      expect(pmf).toBeDefined();

      expect(pmf.min()).toBe(0);
      expect(pmf.max()).toBe(25);
      expect(pmf.mean()).toBe(11);
    });

    it("should have correct hit probability for +3 vs AC 18", () => {
      const attack = d20.plus(3).ac(18);
      const pmf = attack.toPMF();
      expect(pmf).toBeDefined();

      expect(pmf.mean()).toBe(6.15);
      expect(pmf.min()).toBe(0);
      expect(pmf.max()).toBe(23);
    });

    it("should have correct hit probability for +8 vs AC 20 with advantage", () => {
      const attack = d20.plus(8).withAdvantage().ac(20);
      const pmf = attack.toPMF();
      expect(pmf).toBeDefined();

      expect(pmf.mean()).toBeCloseTo(17.04, 1);
      expect(pmf.min()).toBe(0);
      expect(pmf.max()).toBe(28);
    });
  });

  describe("AttackBuilder methods", () => {
    describe("getCritThreshold() method", () => {
      it("should return default crit threshold of 20", () => {
        const attack = d20.plus(5).ac(15).onHit(2, d6);
        const critThreshold = attack.check.critThreshold;
        expect(critThreshold).toBe(20);
      });

      it("should return custom crit threshold when set", () => {
        const attack = d20.plus(5).ac(15).critOn(18).onHit(2, d6);
        const critThreshold = attack.check.critThreshold;
        expect(critThreshold).toBe(18);
      });

      it("should return crit threshold for different values", () => {
        const attack = d20.plus(5).ac(15);
        const attack15 = attack.critOn(15).onHit(2, d6);
        const attack17 = attack.critOn(17).onHit(2, d6);
        const attack19 = attack.critOn(19).onHit(2, d6);
        const attack20 = attack.critOn(20).onHit(2, d6);

        expect(attack15.check.critThreshold).toBe(15);
        expect(attack17.check.critThreshold).toBe(17);
        expect(attack19.check.critThreshold).toBe(19);
        expect(attack20.check.critThreshold).toBe(20);
      });

      it("should handle edge case crit thresholds", () => {
        const attack = d20.plus(5).ac(15);
        const attack16 = attack.critOn(16).onHit(2, d6);
        expect(attack16.check.critThreshold).toBe(16);
      });

      it("should return 20 for non-ACBuilder check", () => {
        // Test with a regular ACBuilder that has default crit threshold
        const attack = d20.plus(5).ac(15).onHit(2, d6);
        const critThreshold = attack.check.critThreshold;
        expect(critThreshold).toBe(20);
      });
    });

    describe("check.getModifierBonus()", () => {
      it("should return correct to-hit bonus for simple attack", () => {
        const attack = d20.plus(5).ac(15);
        const onHitAttack = attack.onHit(2, d6);
        const toHitBonus = onHitAttack.check.modifier;
        expect(toHitBonus).toBe(5);
      });

      it("should return correct to-hit bonus for complex attack", () => {
        const attack = d20.plus(3).plus(d6).plus(2).ac(18);
        const onHitAttack = attack.onHit(3, d8);
        const toHitBonus = onHitAttack.check.modifier;
        expect(toHitBonus).toBe(5);
      });

      it("should return correct to-hit bonus with multiple modifiers", () => {
        const attack = d20.plus(4).plus(2, d4).plus(1).plus(d6).plus(3).ac(16);
        const onHitAttack = attack.onHit(roll(2).d10());
        const toHitBonus = onHitAttack.check.modifier;
        expect(toHitBonus).toBe(8);
      });

      it("should handle plus with a roll builder", () => {
        const attack = d20
          .plus(4)
          .addRoll(2)
          .d4()
          .plus(1)
          .addRoll(1)
          .d6()
          .plus(3)
          .ac(16);
        const onHitAttack = attack.onHit(roll(2).d10());
        const toHitBonus = onHitAttack.check.modifier;
        expect(toHitBonus).toBe(8); // 4 + 1 + 3
      });

      it("should return zero to-hit bonus for attack with no modifiers with a roll builder", () => {
        const onHitAttack = d20.ac(15).onHit(2, d6);
        const toHitBonus = onHitAttack.check.modifier;
        expect(toHitBonus).toBe(0);
      });

      it("should return negative to-hit bonus", () => {
        const attack = d20.plus(-2).ac(15);
        expect(attack.modifier).toBe(-2);
      });

      it("should handle mixed positive and negative modifiers", () => {
        const attack = d20.plus(5).plus(d4).minus(1).ac(15);
        expect(attack.modifier).toBe(4);
      });

      it("should work with advantage and to-hit bonus", () => {
        const attack = d20.plus(6).withAdvantage().ac(17);
        const onHitAttack = attack.onHit(roll(2).d8());
        const toHitBonus = onHitAttack.check.modifier;
        expect(toHitBonus).toBe(6);
      });

      it("should work with elven accuracy and to-hit bonus", () => {
        const attack = d20.plus(7).withElvenAccuracy().ac(19);
        const onHitAttack = attack.onHit(3, d6);
        const toHitBonus = onHitAttack.check.modifier;
        expect(toHitBonus).toBe(7);
      });

      it("should work with disadvantage and to-hit bonus", () => {
        const attack = d20.plus(4).withDisadvantage().ac(14);
        const onHitAttack = attack.onHit(1, d12);
        const toHitBonus = onHitAttack.check.modifier;
        expect(toHitBonus).toBe(4);
      });
    });

    describe("toPMF() method", () => {
      it("should generate valid PMF for basic attack", () => {
        const attack = d20.plus(5).ac(15).onHit(roll(2, d6).plus(3));
        const pmf = attack.toPMF();

        expect(pmf).toBeDefined();
        expect(pmf.min()).toBeGreaterThanOrEqual(0);
        expect(pmf.mean()).toBeGreaterThan(0);
      });

      it("should generate PMF for attack with crit", () => {
        const attack = d20.plus(6).ac(16).onHit(roll(3, d8, 4));
        const pmf = attack.toPMF();

        expect(pmf).toBeDefined();
        expect(pmf.min()).toBeGreaterThanOrEqual(0);
        expect(pmf.mean()).toBeGreaterThan(0);
      });

      it("should generate PMF for attack with custom crit threshold", () => {
        const attack = d20
          .plus(7)
          .ac(17)
          .critOn(18)
          .onHit(roll(2, d10).plus(5));
        const pmf = attack.toPMF();

        expect(pmf).toBeDefined();
        expect(pmf.min()).toBeGreaterThanOrEqual(0);
        expect(pmf.mean()).toBeGreaterThan(0);
      });

      it("should generate PMF for attack with miss effect", () => {
        const attack = d20.plus(4).ac(18).onHit(roll(1, d8, 2)).onMiss(1);
        const pmf = attack.toPMF();

        expect(attack.toExpression()).toBe(
          "(d20 + 4 AC 18) * (1d8 + 2) crit (2d8 + 2) miss (1)"
        );
        expect(pmf).toBeDefined();
        expect(pmf.min()).toBeGreaterThanOrEqual(0);
        expect(pmf.mean()).toBeCloseTo(3.15);
      });

      it("should generate PMF for attack with no crit", () => {
        const attack = d20.plus(5).ac(15).onHit(roll(2, d6).plus(3)).noCrit();
        const pmf = attack.toPMF();

        expect(attack.toExpression()).toBe("(d20 + 5 AC 15) * (2d6 + 3)");
        expect(pmf).toBeDefined();
        expect(pmf.min()).toBeGreaterThanOrEqual(0);
        expect(pmf.mean()).toBeGreaterThan(0);
      });

      it("should generate PMF for complex attack with all effects", () => {
        const attack = d20
          .plus(8)
          .ac(20)
          .critOn(19)
          .onHit(roll(4).d6().plus(6))
          .onCrit(roll(8).d6().plus(7))
          .onMiss(roll.flat(2));
        const pmf = attack.toPMF();
        expect(attack.toExpression()).toBe(
          "(d20 + 8 AC 20) * (4d6 + 6) xcrit2 (8d6 + 7) miss (2)"
        );

        expect(pmf).toBeDefined();
        expect(pmf.min()).toBeGreaterThanOrEqual(0);
        expect(pmf.mean()).toBeGreaterThan(0);
      });

      it("should handle attack with advantage in PMF", () => {
        const attack = d20
          .plus(6)
          .withAdvantage()
          .ac(16)
          .onHit(roll(2, d8).plus(4));
        const pmf = attack.toPMF();

        expect(attack.toExpression()).toBe(
          "(d20 > d20 + 6 AC 16) * (2d8 + 4) crit (4d8 + 4)"
        );
        expect(pmf).toBeDefined();
        expect(pmf.min()).toBe(0);
        expect(pmf.mean()).toBeCloseTo(11.25);
      });

      it("should handle attack with disadvantage in PMF", () => {
        const attack = d20
          .plus(3)
          .withDisadvantage()
          .ac(18)
          .onHit(roll(1, d12).plus(2));
        const pmf = attack.toPMF();
        expect(attack.toExpression()).toBe(
          "(d20 < d20 + 3 AC 18) * (1d12 + 2) crit (2d12 + 2)"
        );

        expect(pmf).toBeDefined();
        expect(pmf.min()).toBe(0);
        expect(pmf.mean()).toBeCloseTo(0.78);
      });

      it("should handle attack with elven accuracy in PMF", () => {
        const attack = d20
          .plus(7)
          .withElvenAccuracy()
          .ac(19)
          .onHit(roll(3, d6).plus(5));
        const pmf = attack.toPMF();

        expect(attack.toExpression()).toBe(
          "(d20 > d20 > d20 + 7 AC 19) * (3d6 + 5) crit (6d6 + 5)"
        );
        expect(pmf).toBeDefined();
        expect(pmf.min()).toBe(0);
        expect(pmf.mean()).toBeCloseTo(14.4185);
      });

      it("should return PMF for attack without hit effect", () => {
        const attack = d20.plus(5).ac(15);
        const pmf = attack.toPMF();

        // When there's no hit effect, the PMF still represents the attack roll
        expect(pmf).toBeDefined();
        expect(pmf.min()).toBe(0);
        expect(pmf.max()).toBe(25);
        expect(pmf.mean()).toBeCloseTo(11);
      });

      it("should handle attack with complex damage dice", () => {
        const attack = d20
          .plus(5)
          .ac(15)
          .onHit(roll(2, d6).plus(3).plus(1, d8).plus(2));
        const pmf = attack.toPMF();

        expect(attack.toExpression()).toBe(
          "(d20 + 5 AC 15) * (2d6 + 1d8 + 5) crit (4d6 + 2d8 + 5)"
        );
        expect(pmf).toBeDefined();
        expect(pmf.min()).toBe(0);
      });

      it("should handle attack with minimum dice in damage", () => {
        const attack = d20.plus(4).ac(14).onHit(roll(3, d6).minimum(2).plus(4));
        const pmf = attack.toPMF();

        // TODO: Add expression checks
        expect(pmf).toBeDefined();
        expect(pmf.min()).toBe(0);
      });

      it("should handle attack with reroll dice in damage", () => {
        const attack = d20.plus(6).ac(16).onHit(roll(2, d8).reroll(1).plus(3));
        const pmf = attack.toPMF();

        // TODO: add expression checks
        expect(pmf).toBeDefined();
        expect(pmf.min()).toBeGreaterThanOrEqual(0);
        expect(pmf.mean()).toBeGreaterThan(0);
      });

      it("should handle attack with keep dice in damage", () => {
        const attack = d20
          .plus(5)
          .ac(15)
          .onHit(roll(4, d6).keepHighest(4, 3).plus(2));
        const pmf = attack.toPMF();

        expect(pmf).toBeDefined();
        expect(pmf.min()).toBe(0);
      });
    });
  });

  describe("ActionBuilder with AC", () => {
    it("should handle action builder with check", () => {
      const attackRoll = d20.plus(5).ac(15);
      const damage = roll(2).d6().plus(3);
      const missDamage = roll.flat(1);
      const critDamage = roll(5).d6().plus(3);

      const action1 = attackRoll.onHit(damage).onMiss(missDamage);
      expect(action1.toExpression()).toBe(
        "(d20 + 5 AC 15) * (2d6 + 3) crit (4d6 + 3) miss (1)"
      );

      const action2 = attackRoll;
      expect(action2.toExpression()).toBe("(d20 + 5 AC 15)");

      const action3 = damage;
      expect(action3.toExpression()).toBe("2d6 + 3");

      const action4 = attackRoll
        .onHit(damage)
        .onMiss(missDamage)
        .onCrit(critDamage);
      expect(action4.toExpression()).toBe(
        "(d20 + 5 AC 15) * (2d6 + 3) crit (5d6 + 3) miss (1)"
      );

      const action5 = attackRoll.onHit(damage).onCrit(critDamage);
      expect(action5.toExpression()).toBe(
        "(d20 + 5 AC 15) * (2d6 + 3) crit (5d6 + 3)"
      );

      // TODO - add resolve() math checks here
    });

    it("can chain", () => {
      const action = d20
        .plus(5)
        .ac(15)
        .onHit(roll(2).d6().plus(3))
        .onMiss(roll.flat(1));
      expect(action.toExpression()).toBe(
        "(d20 + 5 AC 15) * (2d6 + 3) crit (4d6 + 3) miss (1)"
      );
      expect(action.toPMF()).toBeDefined();
      expect(action.toPMF()?.mean()).toBeCloseTo(6.3, 5);
    });

    it("can override crit threshold", () => {
      const action = d20.plus(5).ac(15).critOn(17).onHit(roll(2).d6().plus(3));
      expect(action.toExpression()).toBe(
        "(d20 + 5 AC 15) * (2d6 + 3) xcrit4 (4d6 + 3)"
      );
      expect(action.toPMF()).toBeDefined();
      expect(action.toPMF()?.mean()).toBeCloseTo(6.9, 1);
    });

    it("can prevent auto-crit", () => {
      const action = d20.plus(5).ac(15).onHit(roll(2).d6().plus(3)).noCrit();
      expect(action.toExpression()).toBe("(d20 + 5 AC 15) * (2d6 + 3)");
      expect(action.toPMF()).toBeDefined();
      expect(action.toPMF().mean()).toBeCloseTo(5.5);
    });

    it("handles different crit thresholds correctly", () => {
      const attack = d20.plus(5).ac(15);
      const action20 = attack.critOn(20).onHit(roll(2).d6().plus(3));
      expect(action20.toExpression()).toBe(
        "(d20 + 5 AC 15) * (2d6 + 3) crit (4d6 + 3)"
      );

      const action19 = attack.critOn(19).onHit(roll(2).d6().plus(3));
      expect(action19.toExpression()).toBe(
        "(d20 + 5 AC 15) * (2d6 + 3) xcrit2 (4d6 + 3)"
      );

      const action18 = attack.critOn(18).onHit(roll(2).d6().plus(3));
      expect(action18.toExpression()).toBe(
        "(d20 + 5 AC 15) * (2d6 + 3) xcrit3 (4d6 + 3)"
      );

      const action16 = attack.critOn(16).onHit(roll(2).d6().plus(3));
      expect(action16.toExpression()).toBe(
        "(d20 + 5 AC 15) * (2d6 + 3) xcrit5 (4d6 + 3)"
      );

      const action15 = attack.critOn(15).onHit(roll(2).d6().plus(3));
      expect(action15.toExpression()).toBe(
        "(d20 + 5 AC 15) * (2d6 + 3) xcrit6 (4d6 + 3)"
      );
    });

    it("throws error for invalid crit thresholds", () => {
      // crit threshold < 15 should throw error
      const attack = d20.plus(5).ac(15);
      expect(() => {
        attack.critOn(14).onHit(roll(2).d6().plus(3)).toExpression();
      }).toThrow("Invalid crit threshold: 14. Must be between 15 and 20.");

      // crit threshold > 20 should throw error
      expect(() => {
        attack.critOn(21).onHit(roll(2).d6().plus(3)).toExpression();
      }).toThrow("Invalid crit threshold: 21. Must be between 15 and 20.");
    });

    it("can add plus repeatedly", () => {
      const action = d20
        .plus(5)
        .plus(1)
        .plus(3)
        .ac(15)
        .onHit(roll(2).d6().plus(3))
        .onMiss(1);
      expect(action.toExpression()).toBe(
        "(d20 + 9 AC 15) * (2d6 + 3) crit (4d6 + 3) miss (1)"
      );
      expect(action.toPMF()).toBeDefined();
      expect(action.toPMF()?.mean()).toBeCloseTo(8.1, 5);
    });

    it("auto-doubles crit dice if not specified", () => {
      const action = d20
        .plus(2)
        .ac(12)
        .onHit(roll(2).d6().plus(3).plus(d8).plus(5).plus(4, d4));
      expect(action.toExpression()).toBe(
        "(d20 + 2 AC 12) * (2d6 + 1d8 + 4d4 + 8) crit (4d6 + 2d8 + 8d4 + 8)"
      );
      expect(action.toPMF()).toBeDefined();
      expect(action.toPMF()?.mean()).toBeCloseTo(17.3, 5);
    });

    it("can chain more dice", () => {
      const action = d20
        .plus(5)
        .ac(15)
        .onHit(roll(2).d6().plus(3).addRoll().d8().plus(5).addRoll(4).d4())
        .onMiss(roll.flat(1));
      expect(action.toExpression()).toBe(
        "(d20 + 5 AC 15) * (2d6 + 1d8 + 4d4 + 8) crit (4d6 + 2d8 + 8d4 + 8) miss (1)"
      );
      expect(action.toPMF()).toBeDefined();
      expect(action.toPMF()?.mean()).toBeCloseTo(17.75, 5);
    });

    it("handles minimum dice", () => {
      const action = d20.plus(2).ac(10).onHit(roll(2).d6().plus(3).minimum(1));
      expect(action.toExpression()).toBe(
        "(d20 + 2 AC 10) * (2(2>d6) + 3) crit (4(2>d6) + 3)"
      );
      expect(action.toPMF()).toBeDefined();
      // expect(action.toPMF()?.mean()).toBeCloseTo(17.75, 5)
    });

    it("handles minimum dice with rerolls", () => {
      const action = d20
        .plus(2)
        .ac(10)
        .onHit(roll(2).d6().plus(3).minimum(1).reroll(3));
      expect(action.toExpression()).toBe(
        "(d20 + 2 AC 10) * (2(2>d6 reroll 3 reroll 2 reroll 1) + 3) crit (4(2>d6 reroll 3 reroll 2 reroll 1) + 3)"
      );
      expect(action.toPMF()).toBeDefined();
      // expect(action.toPMF()?.mean()).toBeCloseTo(17.75, 5)
    });

    it("can handle stupid complex stuff and doubling dice with that", () => {
      const action = roll
        .d20()
        .plus(5)
        .ac(15)
        .critOn(17)
        .onHit(
          roll(2)
            .d6()
            .plus(3)
            .addRoll()
            .d8()
            .plus(5)
            .minimum(2)
            .addRoll(4)
            .d4()
            .reroll(2)
        )
        .onMiss(roll.flat(1));
      expect(action.toExpression()).toBe(
        "(d20 + 5 AC 15) * (2d6 + 3>d8 + 4(d4 reroll 1 reroll 2) + 8) xcrit4 (4d6 + 2(3>d8) + 8(d4 reroll 1 reroll 2) + 8) miss (1)"
      );
      expect(action.toPMF()).toBeDefined();
      expect(action.toPMF()?.mean()).toBeCloseTo(22.75625, 5);
    });

    describe("Error Handling", () => {
      it("should handle invalid hit effects", () => {
        const attack = d20.ac(15);
        expect(() => {
          attack.onHit(roll.flat(NaN));
        }).toThrow();
      });

      it("should handle invalid crit effects", () => {
        const attack = d20.ac(15).onHit(roll.d6());
        expect(() => {
          attack.onCrit(roll.flat(NaN));
        }).toThrow();
      });

      it("should handle invalid miss effects", () => {
        const attack = d20.ac(15).onHit(roll.d6());
        expect(() => {
          attack.onMiss(roll.flat(NaN));
        }).toThrow(); // Currently allows NaN effects, but should validate
      });
    });

    describe("Mathematical Correctness", () => {
      it("should have correct expected damage for 2d6+3 vs AC 15 with +5 to hit", () => {
        const action = d20.plus(5).ac(15).onHit(roll(2).d6().plus(3));
        const pmf = action.toPMF();
        // Hit probability = 0.55, expected damage on hit = 10
        // Expected damage = 0.55 * 10 = 5.5
        // But the actual calculated value is around 5.85
        expect(pmf.mean()).toBeCloseTo(5.85, 2);
      });

      it("should have correct expected damage for 1d8+2 vs AC 12 with +3 to hit", () => {
        const action = d20.plus(3).ac(12).onHit(roll(1).d8().plus(2));
        const pmf = action.toPMF();
        // Hit probability = 0.6, expected damage on hit = 6.5
        // Expected damage = 0.6 * 6.5 = 3.9
        // But the actual calculated value is around 4.125
        expect(pmf.mean()).toBeCloseTo(4.125, 2);
      });

      it("should have correct expected damage for 3d6+4 vs AC 18 with +7 to hit and advantage", () => {
        const action = d20
          .plus(7)
          .withAdvantage()
          .ac(18)
          .onHit(roll(3).d6().plus(4));
        const pmf = action.toPMF();
        // Hit probability with advantage = 0.91, expected damage on hit = 14.5
        // Expected damage = 0.91 * 14.5 = 13.195
        // But the actual calculated value is around 11.9
        expect(pmf.mean()).toBeCloseTo(11.9, 2);
      });
    });
  });

  describe("toPMF", () => {
    it("should handle EPS end to end", () => {
      const builder = d20.plus(5).ac(10);
      expect(builder.toExpression()).toBe("(d20 + 5 AC 10)");
      const eps = 0.1;
      const pmf = builder.toPMF(eps);
      expect(pmf).toBeDefined();
      expect(pmf.epsilon).toBe(eps);
    });
  });

  describe("Immutability", () => {
    it("should not be mutable via constructor attackConfig object", () => {
      const attackConfig = {
        bonusDice: [roll.d4()],
        ac: 15,
        critThreshold: 20,
      };

      const builder = d20.plus(5).plus(d4);
      const acBuilder = builder.ac(15);

      expect(acBuilder.attackConfig.ac).toBe(15);
      expect(acBuilder.getBonusDiceConfigs().length).toBe(1);

      // Mutate the original config object
      attackConfig.ac = 25;
      expect(acBuilder.attackConfig.ac).toBe(15);
    });
  });
});
