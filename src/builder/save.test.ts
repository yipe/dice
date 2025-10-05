import { describe, expect, it } from "vitest";
import { parse } from "../parser/parser";
import { d20, d4, d6, d8, roll } from "./";

describe("SaveRollBuilder", () => {
  it("should handle a basic saving throw", () => {
    const save = roll.d20().dc(10);
    expect(save.toExpression()).toBe("(d20 DC 10)");
    const pmf = save.toPMF();
    expect(pmf.mean()).toBeCloseTo(0.45, 12);
    expect(pmf.min()).toBe(0);
    expect(pmf.max()).toBe(1);
  });

  it("should handle save roll builder", () => {
    const builder = roll.d20().plus(5).dc(10);
    expect(builder.toExpression()).toBe("(d20 + 5 DC 10)");
    expect(builder.toPMF()).toBeDefined();
    expect(builder.toPMF()?.mean()).toBeCloseTo(0.2, 12);
  });

  it("should handle save roll builder with advantage", () => {
    const builder = roll.d20().plus(5).withAdvantage().dc(10);
    expect(builder.toExpression()).toBe("(d20 > d20 + 5 DC 10)");
    expect(builder.toPMF()).toBeDefined();
    expect(builder.toPMF()?.mean()).toBeCloseTo(0.04, 12);
  });

  it("should handle save roll builder with advantage different order", () => {
    const builder = roll.d20().withAdvantage().plus(5).dc(10);
    expect(builder.toExpression()).toBe("(d20 > d20 + 5 DC 10)");
    expect(builder.toPMF()).toBeDefined();
    expect(builder.toPMF()?.mean()).toBeCloseTo(0.04, 12);
  });

  it("should handle save roll builder with disadvantage", () => {
    const builder = roll.d20().plus(5).withDisadvantage().dc(10);
    expect(builder.toExpression()).toBe("(d20 < d20 + 5 DC 10)");
    expect(builder.toPMF()).toBeDefined();
    expect(builder.toPMF()?.mean()).toBeCloseTo(0.36, 12);
  });

  it("should handle saveHalf() method", () => {
    const fireballDamage = roll(8).d6();
    const builder = roll
      .d20()
      .plus(7)
      .withAdvantage()
      .dc(15)
      .onSaveFailure(fireballDamage)
      .saveHalf();

    expect(builder.toExpression()).toBe(
      "(d20 > d20 + 7 DC 15) * (8d6) save half"
    );
    expect(builder.toPMF()).toBeDefined();
  });

  it("should handle onSaveFailure() method", () => {
    const damage = roll(6).d6().plus(4);
    const builder = roll.d20().plus(3).dc(12).onSaveFailure(damage);

    expect(builder.toExpression()).toBe("(d20 + 3 DC 12) * (6d6 + 4)");
    expect(builder.toPMF()).toBeDefined();
  });

  it("should handle complex save scenario with advantage", () => {
    const lightningBolt = roll(8).d6();
    const builder = roll
      .d20()
      .plus(6)
      .withAdvantage()
      .dc(16)
      .onSaveFailure(lightningBolt)
      .saveHalf();

    expect(builder.toExpression()).toBe(
      "(d20 > d20 + 6 DC 16) * (8d6) save half"
    );
    expect(builder.toPMF()).toBeDefined();
    expect(builder.toPMF()?.mean()).toBeCloseTo(16.635625, 5);
  });

  it("should throw error when using elven accuracy with DC check", () => {
    expect(() => {
      roll.d20().plus(6).withElvenAccuracy().dc(16);
    }).toThrow(
      "Cannot use dc() on an AttackRollBuilder. Use ac() for attack rolls instead."
    );
  });

  it("should handle save without any effects (just the check)", () => {
    const builder = roll.d20().plus(8).dc(20);

    expect(builder.toExpression()).toBe("(d20 + 8 DC 20)");
    expect(builder.toPMF()).toBeDefined();
    expect(builder.toPMF()?.mean()).toBe(0.55);
  });

  it("should handle save with only failure effect (no save half)", () => {
    const poisonDamage = roll(3).d6().plus(1);
    const builder = roll.d20().plus(2).dc(11).onSaveFailure(poisonDamage);

    expect(builder.toExpression()).toBe("(d20 + 2 DC 11) * (3d6 + 1)");
    expect(builder.toPMF()).toBeDefined();
    expect(builder.toPMF()?.mean()).toBeCloseTo(4.6, 5);
  });

  it("should provide access to root die configuration", () => {
    const builder = roll
      .d20()
      .plus(7)
      .withAdvantage()
      .dc(15)
      .onSaveFailure(roll(8).d6());

    // Test root die config access
    const rootConfig = builder.check.getRootDieConfig();
    expect(rootConfig).toBeDefined();
    expect(rootConfig?.sides).toBe(20);
    expect(rootConfig?.count).toBe(1);
    expect(rootConfig?.rollType).toBe("advantage");

    // Test save bonus calculation
    expect(builder.check.modifier).toBe(7);

    // Test all configs access
    const allConfigs = builder.check.getAllDieConfigs();
    expect(allConfigs).toHaveLength(1);
    expect(allConfigs[0].sides).toBe(20);
  });

  it("should handle complex dice chains with multiple configurations", () => {
    const builder = d20
      .plus(3)
      .withBonus(roll(2).d6().plus(2))
      .dc(12)
      .onSaveFailure(roll(4).d8());

    // Test root die config access (should be the first die with sides > 0)
    const rootConfig = builder.check.getRootDieConfig();
    expect(rootConfig).toBeDefined();
    expect(rootConfig?.sides).toBe(20);
    expect(rootConfig?.count).toBe(1);
    expect(rootConfig?.rollType).toBe("flat");

    // Test save bonus calculation (sum of all modifiers)
    expect(builder.check.modifier).toBe(5);

    // Test all configs access
    const allConfigs = builder.check.getAllDieConfigs();
    expect(allConfigs).toHaveLength(2);
    expect(allConfigs[0].sides).toBe(20);
    expect(allConfigs[0].modifier).toBe(3);
    expect(allConfigs[1].sides).toBe(6);
    expect(allConfigs[1].count).toBe(2);
    expect(allConfigs[1].modifier).toBe(2);
  });

  describe("Error Handling", () => {
    it("should handle invalid DC values", () => {
      const d20roll = roll.d20();
      expect(() => {
        d20roll.dc(-1);
      }).not.toThrow(); // Currently allows negative DC, but should validate

      expect(() => {
        d20roll.dc(0);
      }).not.toThrow(); // Currently allows 0 DC, but should validate
    });

    it("should prevent elven accuracy usage on SaveRollBuilder", () => {
      const d20roll = roll.d20().dc(15);
      expect(() => {
        d20roll.withElvenAccuracy();
      }).toThrow(
        "Elven Accuracy cannot be used with saving throws (DC checks). It is only valid for attack rolls (AC checks)."
      );
    });

    it("should handle invalid save effects", () => {
      const d20roll = roll.d20().dc(15);
      expect(() => {
        d20roll.onSaveFailure(roll.flat(NaN));
      }).toThrow();
    });
  });

  describe("Mathematical Correctness", () => {
    it("should have correct save probability for +4 vs DC 12", () => {
      const save = roll.d20().plus(4).dc(12);
      expect(save.toExpression()).toBe("(d20 + 4 DC 12)");
      const pmf = save.toPMF();

      expect(pmf.mean()).toBe(0.35);
      expect(pmf.min()).toBe(0); // Save rolls can result in 0 (failure)
      expect(pmf.max()).toBe(1); // Save rolls can result in 1 (success)
    });

    it("should have correct save probability for +2 vs DC 16", () => {
      const save = roll.d20().plus(2).dc(16);
      expect(save.toExpression()).toBe("(d20 + 2 DC 16)");
      const pmf = save.toPMF();

      expect(pmf.mean()).toBe(0.65);
      expect(pmf.min()).toBe(0); // Save rolls can result in 0 (failure)
      expect(pmf.max()).toBe(1); // Save rolls can result in 1 (success)
    });

    it("should have correct save probability for +6 vs DC 18 with advantage", () => {
      const save = roll.d20().plus(6).withAdvantage().dc(18);
      const pmf = save.toPMF();

      expect(pmf.mean()).toBeCloseTo(0.3025, 1);
      expect(pmf.min()).toBe(0); // Save rolls can result in 0 (failure)
      expect(pmf.max()).toBe(1); // Save rolls can result in 1 (success)
    });
  });

  describe("SaveBuilder configuration methods", () => {
    it("should provide correct root die configuration", () => {
      const builder = roll
        .d20()
        .plus(6)
        .withDisadvantage()
        .dc(14)
        .onSaveFailure(roll(3).d8());

      const rootConfig = builder.check.getRootDieConfig();
      expect(rootConfig).toBeDefined();
      expect(rootConfig?.sides).toBe(20);
      expect(rootConfig?.count).toBe(1);
      expect(rootConfig?.rollType).toBe("disadvantage");
    });

    it("should provide all die configurations", () => {
      const builder = roll
        .d20()
        .plus(4)
        .addRoll(2)
        .d6()
        .plus(1)
        .dc(13)
        .onSaveFailure(roll(5).d4());

      const allConfigs = builder.check.getAllDieConfigs();
      expect(allConfigs).toHaveLength(2);
      expect(allConfigs[0].sides).toBe(20);
      expect(allConfigs[0].modifier).toBe(4);
      expect(allConfigs[1].sides).toBe(6);
      expect(allConfigs[1].count).toBe(2);
      expect(allConfigs[1].modifier).toBe(1);
    });

    it("should calculate save bonus correctly", () => {
      const builder = d20
        .plus(7)
        .plus(d4)
        .plus(2)
        .dc(16)
        .onSaveFailure(roll(2).d10());
      const saveBonus = builder.check.modifier;
      expect(saveBonus).toBe(9);
    });

    it("should handle complex dice chains in configuration methods", () => {
      const builder = roll
        .d20()
        .plus(3)
        .addRoll(1)
        .d6()
        .plus(1)
        .addRoll(2)
        .d4()
        .plus(2)
        .dc(15)
        .onSaveFailure(roll.flat(10));

      const rootConfig = builder.check.getRootDieConfig();
      expect(rootConfig?.sides).toBe(20);

      const allConfigs = builder.check.getAllDieConfigs();
      expect(allConfigs).toHaveLength(3);

      const saveBonus = builder.check.modifier;
      expect(saveBonus).toBe(6); // 3 + 1 + 2
    });
  });

  describe("saveProbabilities function (via computePMF)", () => {
    it("should calculate correct probabilities for different DC values", () => {
      // Test with +5 modifier vs different DCs
      const dc10 = roll.d20().plus(5).dc(10).onSaveFailure(roll.flat(10));
      const dc15 = roll.d20().plus(5).dc(15).onSaveFailure(roll.flat(10));
      const dc20 = roll.d20().plus(5).dc(20).onSaveFailure(roll.flat(10));

      const pmf10 = dc10.resolve().pmf;
      const pmf15 = dc15.resolve().pmf;
      const pmf20 = dc20.resolve().pmf;

      // Higher DC should result in higher damage (more failures)
      expect(pmf10.mean()).toBeLessThan(pmf15.mean());
      expect(pmf15.mean()).toBeLessThan(pmf20.mean());
    });

    it("should calculate correct probabilities for different roll types", () => {
      const damage = roll.flat(10);

      // Normal roll
      const normal = roll.d20().plus(3).dc(12);
      const normalWithFailure = normal.onSaveFailure(damage);
      const normalPMF = normalWithFailure.resolve().pmf;

      // Advantage roll
      const advantage = roll.d20().plus(3).withAdvantage().dc(12);
      const advantageWithFailure = advantage.onSaveFailure(damage);
      const advantagePMF = advantageWithFailure.resolve().pmf;

      // Disadvantage roll
      const disadvantage = roll.d20().plus(3).withDisadvantage().dc(12);
      const disadvantageWithFailure = disadvantage.onSaveFailure(damage);
      const disadvantagePMF = disadvantageWithFailure.resolve().pmf;

      // Advantage should have lower damage (more successes)
      expect(advantagePMF.mean()).toBeLessThan(normalPMF.mean());
      // Disadvantage should have higher damage (more failures)
      expect(normalPMF.mean()).toBeLessThan(disadvantagePMF.mean());
    });

    it("should handle edge cases in probability calculation", () => {
      // Very high DC (impossible save)
      const impossible = roll.d20().plus(0).dc(30);
      const impossibleWithFailure = impossible.onSaveFailure(roll.flat(10));
      const impossiblePMF = impossibleWithFailure.resolve().pmf;
      expect(impossiblePMF.mean()).toBeCloseTo(10, 1); // Always fails, full damage

      // Very low DC (guaranteed save)
      const guaranteed = roll.d20().plus(10).dc(1);
      const guaranteedWithFailure = guaranteed.onSaveFailure(roll.flat(10));
      const guaranteedPMF = guaranteedWithFailure.resolve().pmf;
      expect(guaranteedPMF.mean()).toBeCloseTo(0, 2); // Always succeeds, no damage
    });

    it("should handle different save bonuses correctly", () => {
      const damage = roll.flat(10);

      const lowBonus = roll.d20().plus(1).dc(15).onSaveFailure(damage);
      const highBonus = roll.d20().plus(10).dc(15).onSaveFailure(damage);

      const lowPMF = lowBonus.resolve().pmf;
      const highPMF = highBonus.resolve().pmf;

      // Higher bonus should result in lower damage (more successes)
      expect(highPMF.mean()).toBeLessThan(lowPMF.mean());
    });
  });

  describe("SaveBuilder edge cases", () => {
    it("should handle save with undefined failure effect", () => {
      const builder = roll.d20().plus(4).dc(10).onSaveFailure(roll.flat(0));

      const pmf = builder.resolve().pmf;
      expect(pmf).toBeDefined();
      expect(pmf.mean()).toBe(0);
    });

    it("should handle save half with very small damage", () => {
      const tinyDamage = roll.flat(1);
      const builder = roll
        .d20()
        .plus(3)
        .dc(12)
        .onSaveFailure(tinyDamage)
        .saveHalf();

      const pmf = builder.resolve().pmf;
      expect(pmf).toBeDefined();
      expect(pmf.mean()).toBeGreaterThanOrEqual(0);
    });

    it("should handle save with complex dice expressions", () => {
      const complexDamage = roll(3).d6().plus(2).addRoll(1).d4();
      const builder = roll
        .d20()
        .plus(5)
        .withAdvantage()
        .dc(16)
        .onSaveFailure(complexDamage)
        .saveHalf();

      expect(builder.toExpression()).toBe(
        "(d20 > d20 + 5 DC 16) * (3d6 + 1d4 + 2) save half"
      );
      // This logs: (d20 > d20 + 5 DC 16) * (3d6 + 1d4 + 2) save half

      const pmf = builder.resolve().pmf;
      expect(pmf).toBeDefined();
      expect(pmf.mean()).toBeGreaterThan(0);
    });

    it("should handle bonus save dice", () => {
      const damage = d6;
      const builder = roll.d20().plus(5).dc(15).onSaveFailure(damage);

      expect(builder.toExpression()).toBe("(d20 + 5 DC 15) * (1d6)");

      const result = builder.resolve();
      expect(result.pmf).toBeDefined();
      expect(result.pmf.mean()).toBeGreaterThan(0);
    });

    it("should handle different save outcome types", () => {
      const damage = roll(2).d8();

      // Test that saveOutcome property affects the result
      const normalSave = d20.plus(4).dc(13).onSaveFailure(damage);

      // Can't just chain on normalSave because the builder mutates as it goes
      const halfSave = d20.plus(4).dc(13).onSaveFailure(damage).saveHalf();

      const normalPMF = normalSave.resolve().pmf;
      const halfPMF = halfSave.resolve().pmf;

      expect(normalPMF).toBeDefined();
      expect(halfPMF).toBeDefined();
      // The distributions should be different
      expect(halfPMF.mean()).not.toBe(normalPMF.mean());
    });
  });
});

describe("SaveBuilder with bonus dice", () => {
  it("should handle save with bonus dice", () => {
    const damage = roll(2).d8();
    const builder = d20.plus(5).plus(d4).dc(15).onSaveFailure(damage);

    expect(builder.toExpression()).toBe("(d20 + 5 + 1d4 DC 15) * (2d8)");

    // Note - the parse() library's only real bug is that it doesn't handle adding rolls to the d20 roll properly.
    // One hack (for SINGLE rolls) is to SUBTRACT them from the AC/DC:
    // Intead of (d20 + 1d4 + 5 DC 15) * (2d8)
    // we should be comparing values to:
    // (d20 + 5 DC (15-1d4)) * (2d8)
    // TO get test values for MULTIPLE bonus rolls, we should compare to the ludic spreadsheet
    const fauxExpression = "(d20 + 5 DC (15-1d4)) * (2d8)";
    const fauxPMF = parse(fauxExpression);
    const pmf = builder.resolve().pmf;
    expect(pmf).toBeDefined();
    expect(pmf.mean()).toBeCloseTo(2.925, 5);
    expect(pmf.mean()).toBeCloseTo(fauxPMF.mean(), 5);
    expect(pmf.min()).toBeCloseTo(fauxPMF.min(), 5);
    expect(pmf.max()).toBeCloseTo(fauxPMF.max(), 5);
  });

  it("should handle bonus dice with save half", () => {
    const damage = roll(2, d8);
    const builder = d20
      .plus(5)
      .plus(d4)
      .dc(15)
      .onSaveFailure(damage)
      .saveHalf();

    expect(builder.toExpression()).toBe(
      "(d20 + 5 + 1d4 DC 15) * (2d8) save half"
    );

    const pmf = builder.resolve().pmf;
    expect(pmf).toBeDefined();
    expect(pmf.mean()).toBeCloseTo(5.79375, 5);
  });

  it("should handle save with negative bonus dice (bane)", () => {
    const damage = roll(2, d8);
    const builder = d20.plus(5).minus(d4).dc(15).onSaveFailure(damage);

    expect(builder.toExpression()).toBe("(d20 + 5 - 1d4 DC 15) * (2d8)");

    const fauxExpression = "(d20 + 5 DC (15+1d4)) * (2d8)";
    const fauxPMF = parse(fauxExpression);
    expect(fauxPMF.mean()).toBeCloseTo(5.175, 5);

    const pmf = builder.resolve().pmf;
    expect(pmf).toBeDefined();
    expect(pmf.mean()).toBeCloseTo(5.175, 5);

    expect(pmf.mean()).toBeCloseTo(fauxPMF.mean(), 5);
    expect(pmf.min()).toBeCloseTo(fauxPMF.min(), 5);
    expect(pmf.max()).toBeCloseTo(fauxPMF.max(), 5);
  });

  it("should handle bonus dice with save half with more complex damage", () => {
    const damage = roll(2, d8, 1).reroll(2);
    const builder = d20
      .plus(5)
      .plus(d4)
      .dc(15)
      .onSaveFailure(damage)
      .saveHalf();

    expect(builder.toExpression()).toBe(
      "(d20 + 5 + 1d4 DC 15) * (2(d8 reroll 1 reroll 2) + 1) save half"
    );

    const pmf = builder.resolve().pmf;
    expect(pmf).toBeDefined();
    expect(pmf.mean()).toBeCloseTo(7.45, 5);
  });

  it("should handle lots of bonus dice", () => {
    const damage = roll(8).d6();
    const builder = roll
      .d(20)
      .plus(1)
      .addRoll(2)
      .d4()
      .addRoll(3)
      .d8()
      .dc(30)
      .onSaveFailure(damage)
      .saveHalf();

    const bonusDice = builder.check.getBonusDiceConfigs();
    expect(bonusDice).toHaveLength(2);
    expect(bonusDice[0].count).toBe(2);
    expect(bonusDice[0].sides).toBe(4);
    expect(bonusDice[1].count).toBe(3);
    expect(bonusDice[1].sides).toBe(8);

    expect(builder.toExpression()).toBe(
      "(d20 + 1 + 3d8 + 2d4 DC 30) * (8d6) save half"
    );

    const result = builder.resolve();
    expect(result).toBeDefined();
    expect(result.weights.success).toBeCloseTo(1 - 0.47534, 5);

    const pmf = builder.resolve().pmf;
    expect(pmf).toBeDefined();
    expect(pmf.mean()).toBeCloseTo(20.52362061, 5);
  });

  it("should handle lots of bonus dice plsu negative dice", () => {
    const damage = roll(8, d6);
    const builder = d20
      .plus(1)
      .plus(3, d4)
      .plus(2, d8)
      .minus(d4)
      .minus(2, d8)
      .dc(30)
      .onSaveFailure(damage)
      .saveHalf();

    const bonusDice = builder.check.getBonusDiceConfigs();
    expect(bonusDice).toHaveLength(4);
    expect(bonusDice[0].count).toBe(3);
    expect(bonusDice[0].sides).toBe(4);
    expect(bonusDice[1].count).toBe(2);
    expect(bonusDice[1].sides).toBe(8);
    expect(bonusDice[2].count).toBe(1);
    expect(bonusDice[2].isSubtraction).toBe(true);
    expect(bonusDice[2].sides).toBe(4);
    expect(bonusDice[3].count).toBe(2);
    expect(bonusDice[3].isSubtraction).toBe(true);
    expect(bonusDice[3].sides).toBe(8);

    expect(builder.toExpression()).toBe(
      "(d20 + 1 + 2d8 - 2d8 + 3d4 - 1d4 DC 30) * (8d6) save half"
    );

    const result = builder.resolve();
    expect(result).toBeDefined();
    expect(result.weights.success).toBeCloseTo(1 - 0.9559193611, 5);

    const pmf = builder.resolve().pmf;
    expect(pmf).toBeDefined();
    expect(pmf.mean()).toBeCloseTo(27.3718509, 5);
  });

  it("should handle lots of bonus dice and the helper", () => {
    // This is the preferred way to add bonus dice, but addRoll is still supported
    const damage = roll(8).d6();
    const builder = roll
      .d(20)
      .plus(1)
      .withBonus(roll(3).d4())
      .withBonus(roll(2).d8())
      .withBonus(roll(-1).d4())
      .withBonus(roll(-2).d8())
      .dc(30)
      .onSaveFailure(damage)
      .saveHalf();

    const bonusDice = builder.check.getBonusDiceConfigs();
    expect(bonusDice).toHaveLength(4);
    expect(bonusDice[0].count).toBe(3);
    expect(bonusDice[0].sides).toBe(4);
    expect(bonusDice[1].count).toBe(2);
    expect(bonusDice[1].sides).toBe(8);
    expect(bonusDice[2].count).toBe(-1);
    expect(bonusDice[2].sides).toBe(4);
    expect(bonusDice[3].count).toBe(-2);
    expect(bonusDice[3].sides).toBe(8);

    expect(builder.toExpression()).toBe(
      "(d20 + 1 + 2d8 - 2d8 + 3d4 - 1d4 DC 30) * (8d6) save half"
    );

    const result = builder.resolve();
    expect(result).toBeDefined();
    expect(result.weights.success).toBeCloseTo(1 - 0.9559193611, 5);

    const pmf = builder.resolve().pmf;
    expect(pmf).toBeDefined();
    expect(pmf.mean()).toBeCloseTo(27.3718509, 5);
  });

  describe("toPMF", () => {
    it("should handle EPS end to end", () => {
      const builder = d20.plus(5).dc(10);
      expect(builder.toExpression()).toBe("(d20 + 5 DC 10)");
      const eps = 0.1;
      const pmf = builder.toPMF(eps);
      expect(pmf).toBeDefined();
      expect(pmf.epsilon).toBe(eps);

      // Later - check this with yipe/dice v0.1.5+
      //   const eps2 = 0.01
      //   const pruned = pmf.pruneRelative(eps2)
      //   expect(pruned.epsilon).toBe(eps2)
    });
  });
});
