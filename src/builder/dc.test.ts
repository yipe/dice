import { describe, expect, it } from "vitest";
import { d20, roll } from "./";
import { DCBuilder } from "./dc";
import { RollBuilder } from "./roll";

describe("DCBuilder", () => {
  it("should handle fireball save for half damage", () => {
    const fireballDamage = roll(8, 6);
    const save1 = roll
      .d20()
      .plus(7)
      .withAdvantage()
      .dc(15)
      .onSaveFailure(fireballDamage)
      .saveHalf();

    expect(save1.toExpression()).toBe(
      "(d20 > d20 + 7 DC 15) * (8d6) save half"
    );
    expect(save1.toPMF()).toBeDefined();
    expect(save1.toPMF().mean()).toBeCloseTo(15.495625, 5);

    // And without a save half or advantage…
    const save3 = roll(1, 20, 7).dc(15).onSaveFailure(fireballDamage);
    expect(save3.toExpression()).toBe("(d20 + 7 DC 15) * (8d6)");
  });

  it("should handle chaining dc() calls", () => {
    // Orientation note: mean equals failure probability (0=success,1=failure)
    const builder = roll.d20().plus(5).dc(10).dc(15);

    expect(builder.toExpression()).toBe("(d20 + 5 DC 15)");
    expect(builder.toPMF()).toBeDefined();
    expect(builder.toPMF()?.mean()).toBeCloseTo(0.45, 5);
  });

  describe("DCBuilder constructor and inheritance", () => {
    it("should inherit from RollBuilder correctly", () => {
      const baseRoll = roll.d20().plus(3).withAdvantage();
      const dcBuilder = new DCBuilder(baseRoll);

      expect(dcBuilder).toBeInstanceOf(DCBuilder);
      expect(dcBuilder).toBeInstanceOf(RollBuilder);
    });

    it("should copy subRollConfigs from base RollBuilder", () => {
      const baseRoll = roll.d20().plus(4).addRoll(2).d6().plus(1);
      const dcBuilder = new DCBuilder(baseRoll);

      const subConfigs = dcBuilder.getSubRollConfigs();
      expect(subConfigs).toHaveLength(2);
      expect(subConfigs[0].sides).toBe(20);
      expect(subConfigs[0].modifier).toBe(4);
      expect(subConfigs[1].sides).toBe(6);
      expect(subConfigs[1].count).toBe(2);
      expect(subConfigs[1].modifier).toBe(1);
    });

    it("should initialize with default save config", () => {
      const baseRoll = roll.d20().plus(2);
      const dcBuilder = new DCBuilder(baseRoll);

      expect(dcBuilder.saveDC).toBe(10); // Default DC
    });
  });

  describe("DCBuilder.dc() method", () => {
    it("should set save DC correctly", () => {
      const builder = roll.d20().plus(5).dc(15);

      expect(builder.saveDC).toBe(15);
    });

    it("should allow chaining dc() calls", () => {
      const builder = roll.d20().plus(3).dc(10).dc(20);

      expect(builder.saveDC).toBe(20); // Last dc() call should override
    });

    it("should handle different DC values", () => {
      const lowDC = roll.d20().plus(2).dc(5);
      const highDC = roll.d20().plus(2).dc(25);

      expect(lowDC.saveDC).toBe(5);
      expect(highDC.saveDC).toBe(25);
    });

    it("should handle zero and negative DC values", () => {
      const zeroDC = roll.d20().plus(1).dc(0);
      const negativeDC = roll.d20().plus(1).dc(-5);

      expect(zeroDC.saveDC).toBe(0);
      expect(negativeDC.saveDC).toBe(-5);
    });
  });

  describe("DCBuilder.withElvenAccuracy() error handling", () => {
    it("should throw error when using withElvenAccuracy", () => {
      const builder = roll.d20().plus(4).dc(12);

      expect(() => {
        builder.withElvenAccuracy();
      }).toThrow(
        "Elven Accuracy cannot be used with saving throws (DC checks). It is only valid for attack rolls (AC checks)."
      );
    });

    it("should throw error even after chaining other methods", () => {
      const builder = roll.d20().plus(6).withAdvantage().dc(16);

      expect(() => {
        builder.withElvenAccuracy();
      }).toThrow(
        "Elven Accuracy cannot be used with saving throws (DC checks). It is only valid for attack rolls (AC checks)."
      );
    });
  });

  describe("DCBuilder.onSaveFailure() method", () => {
    it("should create SaveBuilder with correct check", () => {
      const damage = roll(4).d6();
      const dcBuilder = roll.d20().plus(5).dc(15);
      const saveBuilder = dcBuilder.onSaveFailure(damage);

      expect(saveBuilder).toBeDefined();
      expect(saveBuilder.toExpression()).toBe("(d20 + 5 DC 15) * (4d6)");
    });

    it("should pass DC configuration to SaveBuilder", () => {
      const damage = roll(2).d8().plus(3);
      const dcBuilder = roll.d20().plus(7).dc(18);
      const saveBuilder = dcBuilder.onSaveFailure(damage);

      expect(saveBuilder.check.modifier).toBe(7);
      expect(saveBuilder.check.getRootDieConfig()?.sides).toBe(20);
    });

    it("should handle complex dice expressions in failure effect", () => {
      const complexDamage = roll(3).d6().plus(2).addRoll(1).d4();
      const dcBuilder = roll.d20().plus(4).withDisadvantage().dc(12);
      const saveBuilder = dcBuilder.onSaveFailure(complexDamage);

      expect(saveBuilder).toBeDefined();
      expect(saveBuilder.toExpression()).toContain("(d20 < d20 + 4 DC 12)");
      expect(saveBuilder.toExpression()).toContain("(3d6 + 1d4 + 2)"); // Modifiers are combined
    });
  });

  describe("DCBuilder.toExpression() and toPMF() methods", () => {
    it("should generate correct expression with DC", () => {
      const builder = roll.d20().plus(6).dc(14);

      expect(builder.toExpression()).toBe("(d20 + 6 DC 14)");
    });

    it("should generate correct expression without DC", () => {
      const baseRoll = roll.d20().plus(3);
      const dcBuilder = new DCBuilder(baseRoll);

      expect(dcBuilder.toExpression()).toBe("(d20 + 3 DC 10)"); // Default DC
    });

    it("should generate correct expression with complex dice", () => {
      const builder = roll.d20().plus(2).addRoll(1).d6().plus(1).dc(16);

      expect(builder.toExpression()).toBe("(d20 + 1d6 + 3 DC 16)"); // Modifiers are combined
    });

    it("should generate correct expression with advantage", () => {
      const builder = roll.d20().plus(5).withAdvantage().dc(13);

      expect(builder.toExpression()).toBe("(d20 > d20 + 5 DC 13)");
    });

    it("should generate correct expression with disadvantage", () => {
      const builder = roll.d20().plus(4).withDisadvantage().dc(11);

      expect(builder.toExpression()).toBe("(d20 < d20 + 4 DC 11)");
    });

    it("should generate valid PMF from expression", () => {
      const builder = roll.d20().plus(3).dc(12);
      const pmf = builder.toPMF();

      expect(pmf).toBeDefined();
      expect(pmf.mean()).toBeGreaterThanOrEqual(0);
      expect(pmf.mean()).toBeLessThanOrEqual(1); // Save rolls are 0 or 1
    });

    it("should handle different DC values in PMF generation", () => {
      const lowDC = roll.d20().plus(5).dc(5);
      const highDC = roll.d20().plus(5).dc(20);

      const lowPMF = lowDC.toPMF();
      const highPMF = highDC.toPMF();

      // Higher DC should result in lower success probability
      // Both should be valid PMFs (0 or 1 values)
      expect(lowPMF).toBeDefined();
      expect(highPMF).toBeDefined();
      expect(lowPMF.mean()).toBeGreaterThanOrEqual(0);
      expect(highPMF.mean()).toBeGreaterThanOrEqual(0);
    });
  });

  describe("DCBuilder edge cases", () => {
    it("should handle empty base roll", () => {
      const emptyRoll = new RollBuilder(0);
      const dcBuilder = new DCBuilder(emptyRoll).dc(15);

      expect(dcBuilder.toExpression()).toBe("(0 DC 15)");
      expect(dcBuilder.saveDC).toBe(15);
    });

    it("should handle very large DC values", () => {
      const builder = roll.d20().plus(10).dc(100);

      expect(builder.saveDC).toBe(100);
      expect(builder.toExpression()).toBe("(d20 + 10 DC 100)");
    });

    it("should handle bonus to save", () => {
      const builder = d20.plus(3).addRoll(-1).d4().plus(2).dc(18);
      expect(builder.saveDC).toBe(18);
      expect(builder.toExpression()).toBe("(d20 - 1d4 + 5 DC 18)"); // Modifiers are combined
    });
  });

  describe("Immutability", () => {
    it("should not be mutable via constructor saveConfig object", () => {
      const saveConfig = { dc: 15 };

      const builder = roll.d20().plus(5);
      const dcBuilder = new (builder.dc(10).constructor as any)(
        builder,
        saveConfig
      );

      expect(dcBuilder.saveDC).toBe(15);

      // Mutate the original config object
      saveConfig.dc = 25;

      // The builder should be unaffected
      expect(dcBuilder.saveDC).toBe(15);
    });
  });
});
