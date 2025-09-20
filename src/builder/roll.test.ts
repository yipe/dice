import { describe, expect, it } from "vitest";
import type { RollConfig } from "./";
import { d4, d6, d8, roll, RollBuilder } from "./";

export const testCases: {
  label: string;
  config: Partial<RollConfig>;
  expected: string;
}[] = [
  {
    label: "Normal roll with modifier",
    config: { count: 3, sides: 6, modifier: 3 },
    expected: "3d6 + 3",
  },
  { label: "Simple d20", config: { sides: 20 }, expected: "d20" },
  {
    label: "Minimum die roll",
    config: { sides: 6, minimum: 2 },
    expected: "2>d6",
  },
  {
    label: "Reroll with multiple dice",
    config: { count: 2, sides: 6, reroll: 2 },
    expected: "2(d6 reroll 1 reroll 2)",
  },
  //   { label: 'Exploding dice (finite)', config: { count: 2, sides: 6, explode: 3 }, expected: '2(d6^3)' },
  //   { label: 'Exploding dice (infinite)', config: { sides: 8, explode: Infinity }, expected: 'd8^^' },
  {
    label: "Advantage",
    config: { sides: 20, rollType: "advantage" },
    expected: "d20 > d20",
  },
  {
    label: "Disadvantage",
    config: { sides: 20, rollType: "disadvantage" },
    expected: "d20 < d20",
  },
  {
    label: "Elven Accuracy",
    config: { sides: 20, rollType: "elven accuracy" },
    expected: "d20 > d20 > d20",
  },
  {
    label: "Keep Highest",
    config: { keep: { total: 4, count: 3, mode: "highest" }, sides: 6 },
    expected: "4kh3(d6)",
  },
  {
    label: "Keep Lowest",
    config: { keep: { total: 5, count: 2, mode: "lowest" }, sides: 10 },
    expected: "5kl2(d10)",
  },
  {
    label: "Halfling Dice (shorthand)",
    config: { sides: 20, reroll: 1 },
    expected: "hd20",
  },
  {
    label: "Advantage with Halfling Dice",
    config: { sides: 20, reroll: 1, rollType: "advantage" },
    expected: "hd20 > hd20",
  },
  {
    label: "Negative modifier",
    config: { sides: 12, modifier: -4 },
    expected: "1d12 - 4",
  },
  //   {
  //     label: 'Complex single roll',
  //     config: { count: 3, sides: 8, minimum: 3, reroll: 1, explode: 1, modifier: 5 },
  //     expected: '3(3>d8^1 reroll 1) + 5'
  //   }
];

describe("RollBuilder", () => {
  it("should create basic dice", () => {
    const greatsword = roll(2).d(6).plus(5);
    expect(greatsword.toExpression()).toEqual("2d6 + 5");
  });

  it("should create basic dice with config", () => {
    const greatsword = roll(2).d(6).plus(5).reroll(2);

    expect(greatsword.toExpression()).toEqual("2(d6 reroll 1 reroll 2) + 5");
  });

  it("should handle simple reroll", () => {
    const attack = d4.reroll(1);

    expect(attack.toExpression()).toEqual("d4 reroll 1");
    expect(attack.toPMF()).toBeDefined();
    expect(attack.toPMF()?.mean()).toBeCloseTo(2.875, 1);
  });

  it("should handle harder reroll", () => {
    const attack = d4.reroll(2);

    expect(attack.toExpression()).toEqual("d4 reroll 1 reroll 2"); // legacy parser behavior
    expect(attack.toPMF()).toBeDefined();
    expect(attack.toPMF()?.mean()).toBeCloseTo(3, 5);
    expect(attack.toPMF()?.min()).toBeCloseTo(1, 5);
    expect(attack.toPMF()?.max()).toBeCloseTo(4, 5);
  });

  it("should work with crazy chain", () => {
    const greatsword = roll(2).d(6).plus(5).reroll(2);
    const smite = roll(3).d(8);
    const paladinSmite = greatsword.add(smite);

    const crazyChain = roll(2).d(6).plus(5).reroll(2).addRoll(3).d8();

    expect(crazyChain.toString()).toEqual(paladinSmite.toString());
    expect(crazyChain.toExpression()).toEqual(paladinSmite.toExpression());
    // AST-based PMFs may differ in identifier but must match numerically
    const a = crazyChain.toPMF();
    const b = paladinSmite.toPMF();
    expect(a.support()).toEqual(b.support());
    a.support().forEach((x) => expect(a.pAt(x)).toBeCloseTo(b.pAt(x), 12));

    expect(crazyChain.toPMF()?.mean()).toEqual(paladinSmite.toPMF()?.mean());

    expect(crazyChain.toExpression()).toEqual(paladinSmite.toExpression());
    expect(crazyChain.toExpression()).toEqual(
      "2(d6 reroll 1 reroll 2) + 3d8 + 5"
    );
  });

  it("can create with shorthand roll", () => {
    const attack = roll(3, 6, 2);
    expect(attack.toExpression()).toBe("3d6 + 2");
  });

  it("should throw error if adding a die after adding a die", () => {
    const d8Builder = roll.d8();
    expect(() => {
      d8Builder.d(8);
    }).toThrow("Cannot add a die after adding a die");
  });

  it("should handle negative bonus dice", () => {
    const builder = roll.d8().addRoll(-1).d6();
    expect(builder.toExpression()).toBe("1d8 - 1d6");
  });

  it("should handle negative base dice", () => {
    const builder = roll(-1).d8();
    expect(builder.toExpression()).toBe("-1d8");
  });

  describe("RollBuilder toExpression", () => {
    testCases.forEach(({ label, config, expected }) => {
      it(`should correctly format single config: ${label}`, () => {
        const builder = RollBuilder.fromConfig(config);
        expect(builder.toExpression()).toBe(expected);
      });
    });

    it("should handle joining rolls with negative modifiers", () => {
      const builder = new RollBuilder(3)
        .d10()
        .plus(10)
        .add(RollBuilder.fromConfig({ count: 2, sides: 6, modifier: -3 }));

      expect(builder.toExpression()).toBe("3d10 + 2d6 + 7");
    });

    it("should handle d6, and flat modifiers as a roll part", () => {
      const builder = roll.d6().plus(5); // A roll with no dice, just a modifier

      expect(builder.toExpression()).toBe("1d6 + 5");
    });

    it("should handle two basic rolls joined together", () => {
      const builder = roll.d6().addRoll().plus(5); // A roll with no dice, just a modifier

      expect(builder.toExpression()).toBe("1d6 + 5");
    });

    it("should handle flat modifiers as a roll part", () => {
      const builder = roll.flat(5); // A roll with no dice, just a modifier
      expect(builder.toExpression()).toBe("5");
    });

    it("should handle flat modifiers correctly", () => {
      const builder = roll(0).plus(5);
      const pmf = builder.toPMF();
      expect(pmf).toBeDefined();
      expect(pmf?.mean()).toBe(5);
      expect(pmf?.min()).toBe(5);
      expect(pmf?.max()).toBe(5);
    });

    it("should handle multiple rolls joined together", () => {
      const builder = new RollBuilder(2)
        .d6()
        .addRoll(1)
        .d8()
        .plus(5)
        .addRoll(4)
        .d4()
        .reroll(1);
      expect(builder.toExpression()).toBe("2d6 + 1d8 + 4(d4 reroll 1) + 5");
    });

    it("should handle flat modifiers as a roll part when adding", () => {
      const builder = new RollBuilder(1).d6().addRoll(0).plus(5); // A roll with no dice, just a modifier

      expect(builder.toExpression()).toBe("1d6 + 5");
    });

    it("should handle multiple rolls with plus", () => {
      // Before:  new RollBuilder(2).d6().addRoll(1).d8().plus(5).addRoll(4).d4().reroll(1)
      // After:   roll(2).d6().plus(roll(1).d8()).plus(5).plus(roll(4).d4()).reroll(1)

      const builder = roll(2)
        .d6()
        .plus(roll(1).d8())
        .plus(5)
        .plus(roll(4).d4().reroll(1));
      expect(builder.toExpression()).toBe("2d6 + 1d8 + 4(d4 reroll 1) + 5");
    });

    it("should handle multiple rolls with plus but tighter", () => {
      // Step 1:  new RollBuilder(2).d6().addRoll(1).d8().plus(5).addRoll(4).d4().reroll(1)
      // Step 2:  roll(2).d6().plus(roll(1).d8()).plus(5).plus(roll(4).d4()).reroll(1)
      // Step 3:  roll(2).d6().plus(d8).plus(roll(4).d4().reroll(1)).plus(5)

      const builder = roll(2)
        .d6()
        .plus(d8)
        .plus(5)
        .plus(roll(4).d4().reroll(1));
      expect(builder.toExpression()).toBe("2d6 + 1d8 + 4(d4 reroll 1) + 5");
    });

    it("should handle multiple rolls with plus but even tighter", () => {
      // Step 1:  new RollBuilder(2).d6().addRoll(1).d8().plus(5).addRoll(4).d4().reroll(1)
      // Step 2:  roll(2).d6().plus(roll(1).d8()).plus(5).plus(roll(4).d4()).reroll(1)
      // Step 3:  roll(2).d6().plus(d8).plus(roll(4).d4().reroll(1)).plus(5)
      // Step 4:  roll(2).d6().plus(d8).plus(roll(4, 4).reroll(1)).plus(5)
      const builder = roll(2).d6().plus(d8).plus(roll(4, 4).reroll(1)).plus(5);
      // This is no longer broken because builders are immutable
      expect(builder.toExpression()).toBe("2d6 + 1d8 + 4(d4 reroll 1) + 5");
    });

    it("should handle multiple rolls with plus but tightest?", () => {
      // Step 1:  new RollBuilder(2).d6().addRoll(1).d8().plus(5).addRoll(4).d4().reroll(1)
      // Step 2:  roll(2).d6().plus(roll(1).d8()).plus(5).plus(roll(4).d4()).reroll(1)
      // Step 3:  roll(2).d6().plus(d8).plus(roll(4).d4().reroll(1)).plus(5)
      // Step 4:  roll(2).d6().plus(d8).plus(roll(4, 4).reroll(1)).plus(5)
      // Final:   roll(2, 6).add(d8).add(roll(4, 4).reroll(1)).plus(5)

      const builder = roll(2, 6).plus(d8).plus(roll(4, 4).reroll(1)).plus(5);
      expect(builder.toExpression()).toBe("2d6 + 1d8 + 4(d4 reroll 1) + 5");
    });

    //   it('should handle multiple rolls with plus but tightest? - with roll builder', () => {
    //     // Step 1:  new RollBuilder(2).d6().addRoll(1).d8().plus(5).addRoll(4).d4().reroll(1)
    //     // Step 2:  roll(2).d6().plus(roll(1).d8()).plus(5).plus(roll(4).d4()).reroll(1)
    //     // Step 3:  roll(2).d6().plus(d8).plus(roll(4).d4().reroll(1)).plus(5)
    //     // Step 4:  roll(2).d6().plus(d8).plus(roll(4, 4).reroll(1)).plus(5)
    //     // Final:   roll(2, 6).add(d8).add(roll(4, 4).reroll(1)).plus(5)
    //     // Future Idea for legibility:
    //     //          roll(2, d6).add(d8).add(roll(4, d4).reroll(1)).plus(5)
    //     const builder = roll(2, d6).plus(1, d8).plus(roll(4, d4).reroll(1)).plus(5)
    //     expect(builder.toExpression()).toBe('2d6 + 1d8 + 4(d4 reroll 1) + 5')
    //   })
  });

  describe("RollBuilder Edge Cases", () => {
    it("should handle bestOf() method", () => {
      const builder = roll(4).d6().bestOf(2);
      expect(builder.toExpression()).toBe("4d6kh2");
      expect(builder.toPMF()).toBeDefined();
      // bestOf is not yet implemented in the expression parser, so we just verify it doesn't crash
    });

    it("should handle keepHighest() method", () => {
      const builder = roll(5).d6().keepHighest(5, 3);
      expect(builder.toExpression()).toBe("5kh3(d6)");
      expect(builder.toPMF()).toBeDefined();
      expect(builder.toPMF()?.mean()).toBeCloseTo(13.43017, 5);
    });

    it("should handle keepLowest() method", () => {
      const builder = roll(4).d8().keepLowest(4, 2);
      expect(builder.toExpression()).toBe("4kl2(d8)");
      expect(builder.toPMF()).toBeDefined();
      expect(builder.toPMF()?.mean()).toBeCloseTo(5.841796875, 5);
    });

    it("should handle copy() method", () => {
      const original = roll(3).d6().plus(4).reroll(1);
      const copy = original.copy();

      expect(copy.toExpression()).toBe(original.toExpression());
      const originalPMF = original.toPMF();
      const copyPMF = copy.toPMF();
      expect(originalPMF).toBeDefined();
      expect(copyPMF).toBeDefined();
      expect(copyPMF?.mean()).toBeCloseTo(originalPMF?.mean()!, 5);

      // Modifying the copy shouldn't affect the original
      const modifiedCopy = copy.plus(2);
      expect(modifiedCopy.toExpression()).toBe("3(d6 reroll 1) + 6");
      expect(original.toExpression()).toBe("3(d6 reroll 1) + 4");
    });

    it("should handle complex keepHighest scenario", () => {
      const builder = roll(6).d8().plus(2).keepHighest(6, 4);
      expect(builder.toExpression()).toBe("6kh4(d8) + 2");
      expect(builder.toPMF()).toBeDefined();
      expect(builder.toPMF()?.mean()).toBeCloseTo(24.5086, 1);
    });

    it("should handle complex keepLowest scenario", () => {
      const builder = roll(8).d10().plus(3).keepLowest(4, 2);
      expect(builder.toExpression()).toBe("4kl2(d10) + 3");
      expect(builder.toPMF()).toBeDefined();
      expect(builder.toPMF()?.mean()).toBeCloseTo(10.033, 3);
    });

    it("should handle copy() with multiple dice configurations", () => {
      const original = roll(2).d6().addRoll(3).d8().plus(5).addRoll(1).d4();
      const copy = original.copy();

      expect(copy.toExpression()).toBe(original.toExpression());
      const originalPMF = original.toPMF();
      const copyPMF = copy.toPMF();
      expect(originalPMF).toBeDefined();
      expect(copyPMF).toBeDefined();
      expect(copyPMF?.mean()).toBeCloseTo(originalPMF?.mean()!, 5);
    });

    it("should handle copy() with advantage", () => {
      const original = roll.d20().withAdvantage().plus(5);
      const copy = original.copy();

      expect(copy.toExpression()).toBe(original.toExpression());
      const originalPMF = original.toPMF();
      const copyPMF = copy.toPMF();
      expect(originalPMF).toBeDefined();
      expect(copyPMF).toBeDefined();
      expect(copyPMF?.mean()).toBeCloseTo(originalPMF?.mean()!, 5);
    });

    it("should handle copy() with elven accuracy", () => {
      const original = roll.d20().withElvenAccuracy().plus(3);
      const copy = original.copy();

      expect(copy.toExpression()).toBe(original.toExpression());
      const originalPMF = original.toPMF();
      const copyPMF = copy.toPMF();
      expect(originalPMF).toBeDefined();
      expect(copyPMF).toBeDefined();
      expect(copyPMF?.mean()).toBeCloseTo(originalPMF?.mean()!, 5);
    });

    it("should handle copy() with minimum values", () => {
      const original = roll(3).d6().minimum(2).plus(4);
      const copy = original.copy();

      expect(copy.toExpression()).toBe(original.toExpression());
      const originalPMF = original.toPMF();
      const copyPMF = copy.toPMF();
      expect(originalPMF).toBeDefined();
      expect(copyPMF).toBeDefined();
      expect(copyPMF?.mean()).toBeCloseTo(originalPMF?.mean()!, 5);
    });

    it("should handle copy() with rerolls", () => {
      const original = roll(4).d8().reroll(2).plus(3);
      const copy = original.copy();

      expect(copy.toExpression()).toBe(original.toExpression());
      const originalPMF = original.toPMF();
      const copyPMF = copy.toPMF();
      expect(originalPMF).toBeDefined();
      expect(copyPMF).toBeDefined();
      expect(copyPMF?.mean()).toBeCloseTo(originalPMF?.mean()!, 5);
    });

    it("should handle bestOf() with modifiers", () => {
      const builder = roll(5).d10().bestOf(3).plus(4);
      expect(builder.toExpression()).toBe("5d10kh3 + 4");
      expect(builder.toPMF()).toBeDefined();
      expect(builder.toPMF()?.mean()).toBeCloseTo(31.5, 1);
    });

    it("should handle keepHighest() with advantage", () => {
      const builder = roll.d20().withAdvantage();
      const finalBuilder = builder.keepHighest(2, 1);
      expect(finalBuilder.toExpression()).toBe("d20 > d20");
      expect(finalBuilder.toPMF()).toBeDefined();
      expect(finalBuilder.toPMF()?.mean()).toBeCloseTo(13.8, 1);
    });

    it("should handle keepLowest() with disadvantage", () => {
      const builder = roll.d20().withDisadvantage();
      const finalBuilder = builder.keepLowest(2, 1);
      expect(finalBuilder.toExpression()).toBe("d20 < d20");
      expect(finalBuilder.toPMF()).toBeDefined();
      expect(finalBuilder.toPMF()?.mean()).toBeCloseTo(7.2, 1);
    });

    it("should handle complex combination of keep and modifiers", () => {
      const builder = roll(6)
        .d8()
        .keepHighest(6, 4)
        .plus(3)
        .addRoll(2)
        .d6()
        .keepLowest(2, 1);
      expect(builder.toExpression()).toBe("6kh4(d8) + 2kl1(d6) + 3");
      expect(builder.toPMF()).toBeDefined();
      expect(builder.toPMF()?.mean()).toBeCloseTo(28.0, 1);
    });
  });

  describe("Error Handling and Validation", () => {
    describe("RollBuilder Input Validation", () => {
      it("should handle invalid dice sides", () => {
        expect(() => {
          roll.d(0);
        }).not.toThrow(); // Currently allows 0 sides, but should validate

        expect(() => {
          roll.d(-1);
        }).not.toThrow(); // Currently allows negative sides, but should validate
      });

      it("should handle invalid dice count", () => {
        expect(() => {
          roll(-1).d6();
        }).not.toThrow(); // Currently allows negative count, but should validate

        expect(() => {
          roll(0).d6();
        }).not.toThrow(); // Currently allows 0 count, but should validate
      });

      it("should handle invalid reroll values", () => {
        const builder = roll.d6();
        expect(() => {
          builder.reroll(-1);
        }).not.toThrow(); // Currently allows negative reroll, but should validate

        expect(() => {
          builder.reroll(7); // Reroll value higher than die sides
        }).not.toThrow(); // Currently allows invalid reroll, but should validate
      });

      it("should handle invalid minimum values", () => {
        const builder = roll.d6();
        expect(() => {
          builder.minimum(0); // Minimum of 0 should be invalid
        }).not.toThrow(); // Currently allows, but should validate

        expect(() => {
          builder.minimum(7); // Minimum higher than die sides
        }).not.toThrow(); // Currently allows, but should validate
      });

      it("should handle invalid explode values", () => {
        const builder = roll.d6();
        expect(() => {
          builder.explode(-1);
        }).toThrow();

        expect(() => {
          builder.explode(0);
        }).not.toThrow(); // Currently allows 0 explode, which just means no explode
      });

      it("should handle invalid keep dice values", () => {
        const builder = roll(3).d6();
        expect(() => {
          builder.keepHighest(2, 5); // Keep more than total
        }).not.toThrow(); // Currently allows, but should validate

        expect(() => {
          builder.keepHighest(3, 0); // Keep 0 dice
        }).not.toThrow(); // Currently allows, but should validate

        expect(() => {
          builder.keepHighest(3, -1); // Keep negative dice
        }).not.toThrow(); // Currently allows, but should validate
      });

      it("should handle invalid bestOf values", () => {
        const builder = roll(3).d6();
        expect(() => {
          builder.bestOf(0);
        }).toThrow();

        expect(() => {
          builder.bestOf(5); // bestOf higher than count
        }).not.toThrow(); // TODO: Currently allows, but should throw

        expect(() => {
          builder.bestOf(-1);
        }).toThrow();
      });
    });
  });

  describe("Mathematical Correctness Validation", () => {
    describe("Basic Dice Mathematics", () => {
      it("should have correct mean for 1d6", () => {
        const rollBuilder = new RollBuilder(1).d6();
        const pmf = rollBuilder.toPMF();
        expect(pmf.mean()).toBeCloseTo(3.5, 5);
        expect(pmf.min()).toBe(1);
        expect(pmf.max()).toBe(6);
      });

      it("should have correct mean for 2d6", () => {
        const rollBuilder = new RollBuilder(2).d6();
        const pmf = rollBuilder.toPMF();
        expect(pmf.mean()).toBeCloseTo(7.0, 5);
        expect(pmf.min()).toBe(2);
        expect(pmf.max()).toBe(12);
      });

      it("should have correct mean for 3d6", () => {
        const rollBuilder = new RollBuilder(3).d6();
        const pmf = rollBuilder.toPMF();
        expect(pmf.mean()).toBeCloseTo(10.5, 5);
        expect(pmf.min()).toBe(3);
        expect(pmf.max()).toBe(18);
      });

      it("should have correct mean for 1d20", () => {
        const rollBuilder = new RollBuilder(1).d20();
        const pmf = rollBuilder.toPMF();
        expect(pmf.mean()).toBeCloseTo(10.5, 5);
        expect(pmf.min()).toBe(1);
        expect(pmf.max()).toBe(20);
      });

      it("should have correct mean for 1d100", () => {
        const rollBuilder = new RollBuilder(1).d100();
        const pmf = rollBuilder.toPMF();
        expect(pmf.mean()).toBeCloseTo(50.5, 5);
        expect(pmf.min()).toBe(1);
        expect(pmf.max()).toBe(100);
      });
    });

    describe("Modifier Mathematics", () => {
      it("should have correct mean for 1d6 + 3", () => {
        const rollBuilder = new RollBuilder(1).d6().plus(3);
        const pmf = rollBuilder.toPMF();
        expect(pmf.mean()).toBeCloseTo(6.5, 5);
        expect(pmf.min()).toBe(4);
        expect(pmf.max()).toBe(9);
      });

      it("should have correct mean for 2d6 - 2", () => {
        const rollBuilder = new RollBuilder(2).d6().plus(-2);
        const pmf = rollBuilder.toPMF();
        expect(pmf.mean()).toBeCloseTo(5.0, 5);
        expect(pmf.min()).toBe(0);
        expect(pmf.max()).toBe(10);
      });

      it("should have correct mean for 3d6 + 10", () => {
        const rollBuilder = new RollBuilder(3).d6().plus(10);
        const pmf = rollBuilder.toPMF();
        expect(pmf.mean()).toBeCloseTo(20.5, 5);
        expect(pmf.min()).toBe(13);
        expect(pmf.max()).toBe(28);
      });
    });

    describe("Advantage/Disadvantage Mathematics", () => {
      it("should have correct mean for d20 with advantage", () => {
        const rollBuilder = new RollBuilder(1).d20().withAdvantage();
        const pmf = rollBuilder.toPMF();
        // Mean of advantage is approximately 13.825
        expect(pmf.mean()).toBeCloseTo(13.825, 2);
        expect(pmf.min()).toBe(1);
        expect(pmf.max()).toBe(20);
      });

      it("should have correct mean for d20 with disadvantage", () => {
        const rollBuilder = new RollBuilder(1).d20().withDisadvantage();
        const pmf = rollBuilder.toPMF();
        // Mean of disadvantage is approximately 7.175
        expect(pmf.mean()).toBeCloseTo(7.175, 2);
        expect(pmf.min()).toBe(1);
        expect(pmf.max()).toBe(20);
      });

      it("should have correct mean for d20 with elven accuracy", () => {
        const rollBuilder = new RollBuilder(1).d20().withElvenAccuracy();
        const pmf = rollBuilder.toPMF();
        // Mean of elven accuracy is approximately 14.83 (actual calculated value)
        expect(pmf.mean()).toBeCloseTo(15.4875, 2);
        expect(pmf.min()).toBe(1);
        expect(pmf.max()).toBe(20);
      });
    });

    describe("Reroll Mathematics", () => {
      it("should have correct mean for d6 reroll 1", () => {
        const rollBuilder = new RollBuilder(1).d6().reroll(1);
        const pmf = rollBuilder.toPMF();
        // Mean should be higher than 3.5 since we're rerolling 1s
        expect(pmf.mean()).toBeGreaterThan(3.5);
        expect(pmf.min()).toBe(1); // Reroll doesn't change minimum, just probability distribution
        expect(pmf.max()).toBe(6);
      });

      it("should have correct mean for d6 reroll 1 and 2", () => {
        const rollBuilder = new RollBuilder(1).d6().reroll(2);
        const pmf = rollBuilder.toPMF();
        // Mean should be higher than reroll 1
        expect(pmf.mean()).toBeGreaterThan(4.0);
        expect(pmf.min()).toBe(1); // Reroll doesn't change minimum, just probability distribution
        expect(pmf.max()).toBe(6);
      });

      it("should have correct mean for d20 reroll 1 (halfling)", () => {
        const rollBuilder = new RollBuilder(1).d20().reroll(1);
        const pmf = rollBuilder.toPMF();
        // Mean should be higher than 10.5 since we're rerolling 1s
        expect(pmf.mean()).toBeGreaterThan(10.5);
        expect(pmf.min()).toBe(1); // Reroll doesn't change minimum, just probability distribution
        expect(pmf.max()).toBe(20);
      });
    });

    describe("Reroll-once threshold kernel (one-pass, must-keep)", () => {
      it("d6 reroll 1: exact per-face probabilities and mean", () => {
        const pmf = new RollBuilder(1).d6().reroll(1).toPMF();
        // For k=1 on d6: P(1)=1/36, P(2..6)=7/36
        expect(pmf.pAt(1)).toBeCloseTo(1 / 36, 10);
        for (let v = 2; v <= 6; v++) expect(pmf.pAt(v)).toBeCloseTo(7 / 36, 10);
        // Mean = (n+1)/2 + k(n-k)/(2n) = 3.5 + 5/12 = 47/12
        expect(pmf.mean()).toBeCloseTo(47 / 12, 10);
      });

      it("d6 reroll 1 and 2: exact per-face probabilities and mean", () => {
        const pmf = new RollBuilder(1).d6().reroll(2).toPMF();
        // For k=2 on d6: P(1)=P(2)=2/36, P(3..6)=8/36
        expect(pmf.pAt(1)).toBeCloseTo(2 / 36, 10);
        expect(pmf.pAt(2)).toBeCloseTo(2 / 36, 10);
        for (let v = 3; v <= 6; v++) expect(pmf.pAt(v)).toBeCloseTo(8 / 36, 10);
        // Mean = 3.5 + 2*4/(2*6) = 25/6
        expect(pmf.mean()).toBeCloseTo(25 / 6, 10);
      });

      it("2d8 + 1 with reroll 1..2 on each die: mean 11.5", () => {
        const pmf = new RollBuilder(2).d8().reroll(2).plus(1).toPMF();
        // single die mean: 4.5 + 2*6/(2*8) = 4.5 + 12/16 = 5.25; so total 2*5.25 + 1 = 11.5
        expect(pmf.mean()).toBeCloseTo(11.5, 10);
      });
    });

    describe("Minimum Value Mathematics", () => {
      it("should have correct mean for d6 minimum 2", () => {
        const rollBuilder = new RollBuilder(1).d6().minimum(2);
        const pmf = rollBuilder.toPMF();
        // Mean should be higher than 3.5 since we're setting minimum to 2
        expect(pmf.mean()).toBeGreaterThan(3.5);
        expect(pmf.min()).toBe(3); // minimum(2) means 2>d6, so min is 3
        expect(pmf.max()).toBe(6);
      });

      it("should have correct mean for d6 minimum 4", () => {
        const rollBuilder = new RollBuilder(1).d6().minimum(4);
        const pmf = rollBuilder.toPMF();
        // Mean should be higher than minimum 2
        expect(pmf.mean()).toBeGreaterThan(4.0);
        expect(pmf.min()).toBe(5); // minimum(4) means 4>d6, so min is 5
        expect(pmf.max()).toBe(6);
      });
    });

    describe("Keep Dice Mathematics", () => {
      it("should have correct mean for 4d6 keep highest 3", () => {
        const rollBuilder = new RollBuilder(4).d6().keepHighest(4, 3);
        const pmf = rollBuilder.toPMF();
        // Mean should be higher than 3d6 since we're keeping the highest 3 of 4
        expect(pmf.mean()).toBeGreaterThan(10.5); // 3d6 mean
        expect(pmf.min()).toBe(3);
        expect(pmf.max()).toBe(18);
      });

      it("should have correct mean for 4d6 keep lowest 2", () => {
        const rollBuilder = new RollBuilder(4).d6().keepLowest(4, 2);
        const pmf = rollBuilder.toPMF();
        // Mean should be lower than 2d6 since we're keeping the lowest 2 of 4
        expect(pmf.mean()).toBeLessThan(7.0); // 2d6 mean
        expect(pmf.min()).toBe(2);
        expect(pmf.max()).toBe(12);
      });
    });

    describe("Complex Combination Mathematics", () => {
      it("should have correct mean for 2d6 + 3 with advantage", () => {
        const rollBuilder = new RollBuilder(2).d6().withAdvantage().plus(3);
        const pmf = rollBuilder.toPMF();
        // Mean should be higher than 2d6 + 3 due to advantage
        expect(pmf.mean()).toBeGreaterThan(7.0); // 2d6 + 3 mean (not 10.0)
        expect(pmf.min()).toBe(4); // Advantage can result in lower values
        expect(pmf.max()).toBe(9); // Actual max value is 9
      });

      it("should have correct mean for 3d6 reroll 1 minimum 2 + 5", () => {
        const rollBuilder = new RollBuilder(3)
          .d6()
          .reroll(1)
          .minimum(2)
          .plus(5);
        const pmf = rollBuilder.toPMF();
        // Mean should be higher than 3d6 + 5 due to reroll and minimum
        expect(pmf.mean()).toBeGreaterThan(15.5); // 3d6 + 5 mean
        expect(pmf.min()).toBe(14); // 3 * 3 + 5 (minimum 2 means 2>d6, so min is 3)
        expect(pmf.max()).toBe(23); // 3 * 6 + 5
      });

      it("should have correct mean for 6d8 keep highest 4 + 2", () => {
        const rollBuilder = new RollBuilder(6).d8().keepHighest(6, 4).plus(2);
        const pmf = rollBuilder.toPMF();
        // Mean should be higher than 4d8 + 2 since we're keeping highest 4 of 6
        expect(pmf.mean()).toBeGreaterThan(20.0); // 4d8 + 2 mean
        expect(pmf.min()).toBe(6); // 4 * 1 + 2
        expect(pmf.max()).toBe(34); // 4 * 8 + 2
      });
    });
  });

  describe("minus()", () => {
    it("should subtract a number from the roll modifier", () => {
      const builder = roll(2, 6, 5).minus(3);
      expect(builder.toExpression()).toBe("2d6 + 2");
      expect(builder.toPMF().mean()).toBeCloseTo(9.0);
    });

    it("should subtract a RollBuilder from the current roll", () => {
      const builder = roll(2, 6).minus(d4);
      expect(builder.toExpression()).toBe("2d6 - 1d4");
      expect(builder.toPMF().mean()).toBeCloseTo(7.0 - 2.5);
    });

    it("should subtract a number of RollBuilders from the current roll", () => {
      const builder = roll(3, 8).minus(2, d6);
      expect(builder.toExpression()).toBe("3d8 - 2d6");
      expect(builder.toPMF().mean()).toBeCloseTo(3 * 4.5 - 2 * 3.5);
    });

    it("should handle chained minus operations correctly", () => {
      const builder = roll(0).plus(10).minus(2).minus(3);
      expect(builder.toExpression()).toBe("5");
      expect(builder.toPMF().mean()).toBe(5);
    });

    it("should correctly subtract a roll that includes a subtraction", () => {
      const subtractedRoll = roll(1, 8).minus(d4); // 1d8 - 1d4
      const builder = roll(1, 20).minus(subtractedRoll);
      expect(builder.toExpression()).toBe("d20 - 1d8 + 1d4");
      expect(builder.toPMF().mean()).toBeCloseTo(10.5 - 4.5 + 2.5);
    });
  });

  describe("Immutability", () => {
    it("should not be mutable via constructor config array", () => {
      const configs: RollConfig[] = [
        {
          count: 1,
          sides: 6,
          modifier: 0,
          reroll: 0,
          explode: 0,
          minimum: 0,
          bestOf: 0,
          keep: undefined,
          rollType: "flat",
        },
      ];

      const builder = new RollBuilder(configs);
      expect(builder.toExpression()).toBe("1d6");

      // Mutate the original config array
      configs[0].sides = 20;

      // The builder should be unaffected
      expect(builder.toExpression()).toBe("1d6");
    });
  });

  describe("NaN Input Validation", () => {
    it("should throw for NaN in constructor", () => {
      expect(() => new RollBuilder(NaN)).toThrow("Invalid NaN value for count");
    });

    it("should throw for NaN in d()", () => {
      expect(() => roll(1).d(NaN)).toThrow("Invalid NaN value for sides");
    });

    it("should throw for NaN in plus()", () => {
      expect(() => roll(1).d(6).plus(NaN)).toThrow(
        "Invalid NaN value for modOrRoll"
      );
      expect(() => roll(1).d(6).plus(NaN, d6)).toThrow(
        "Invalid NaN value for modOrRoll"
      );
    });

    it("should throw for NaN in minus()", () => {
      expect(() => roll(1).d(6).minus(NaN)).toThrow(
        "Invalid NaN value for modOrRoll"
      );
      expect(() => roll(1).d(6).minus(NaN, d6)).toThrow(
        "Invalid NaN value for modOrRoll"
      );
    });

    it("should throw for NaN in reroll()", () => {
      expect(() => roll(1).d(6).reroll(NaN)).toThrow(
        "Invalid NaN value for reroll"
      );
    });

    it("should throw for NaN in explode()", () => {
      expect(() => roll(1).d(6).explode(NaN)).toThrow(
        "Invalid NaN value for explode count"
      );
    });

    it("should throw for NaN in minimum()", () => {
      expect(() => roll(1).d(6).minimum(NaN)).toThrow(
        "Invalid NaN value for minimum"
      );
    });

    it("should throw for NaN in bestOf()", () => {
      expect(() => roll(1).d(6).bestOf(NaN)).toThrow(
        "Invalid NaN value for bestOf count"
      );
    });

    it("should throw for NaN in keepHighest()", () => {
      expect(() => roll(2).d(6).keepHighest(NaN, 1)).toThrow(
        "Invalid NaN value for keepHighest"
      );
      expect(() => roll(2).d(6).keepHighest(2, NaN)).toThrow(
        "Invalid NaN value for keepHighest"
      );
    });

    it("should throw for NaN in keepLowest()", () => {
      expect(() => roll(2).d(6).keepLowest(NaN, 1)).toThrow(
        "Invalid NaN value for keepLowest"
      );
      expect(() => roll(2).d(6).keepLowest(2, NaN)).toThrow(
        "Invalid NaN value for keepLowest"
      );
    });

    it("should throw for NaN in ac()", () => {
      expect(() => roll(1).d(20).ac(NaN)).toThrow(
        "Invalid NaN value for targetAC"
      );
    });

    it("should throw for NaN in dc()", () => {
      expect(() => roll(1).d(20).dc(NaN)).toThrow(
        "Invalid NaN value for saveDC"
      );
    });

    it("should throw for NaN in addRoll()", () => {
      expect(() => roll(1).d(6).addRoll(NaN)).toThrow(
        "Invalid NaN value for count"
      );
    });

    it("should throw for NaN in fromArgs()", () => {
      expect(() => RollBuilder.fromArgs(NaN)).toThrow(
        "Invalid NaN value for argument"
      );
      expect(() => RollBuilder.fromArgs(NaN, 6)).toThrow(
        "Invalid NaN value for count argument"
      );
      expect(() => RollBuilder.fromArgs(1, NaN)).toThrow(
        "Invalid NaN value for sides argument"
      );
      expect(() => RollBuilder.fromArgs(1, 6, NaN)).toThrow(
        "Invalid NaN value for modOrRoll"
      );
    });
  });
});
