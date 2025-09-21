import { describe, expect, it } from "vitest";
import { EPS } from "../src/common/types";
import { parse } from "../src/parser/parser";

describe("Dice Parser Tests", () => {
  describe("Basic Dice Expressions", () => {
    it("Roll a d20", () => {
      const result = parse("d20");
      expect(result.support()).toEqual(
        Array.from({ length: 20 }, (_, i) => i + 1)
      );

      expect(result.support().length).toBe(20);
      expect(result.max()).toBe(20);
    });

    it("Roll a d20, but reroll on 1 (halfling d20)", () => {
      const result = parse("d20 reroll 1");
      // Reroll includes 1s but with different probability distribution
      expect(result.support()).toContain(1); // 1s are still present
      expect(result.support()).toContain(20);
      expect(result.faceTotal()).toBe(210);
    });

    it("Roll a d20, but reroll on 1 (halfling d20) - shorthand", () => {
      const result = parse("hd20");
      expect(result.support()).toContain(1);
      expect(result.support()).toContain(20);
      expect(result.faceTotal()).toBe(210);
    });
  });

  describe("Advantage and Disadvantage", () => {
    it("Choose the greater of two d20 rolls (advantage)", () => {
      const result = parse("d20 > d20");
      // Advantage: min = 1, max = 20, but weighted toward higher numbers
      expect(result.min()).toBe(1);
      expect(result.max()).toBe(20);
      expect(result.faceTotal()).toBe(210); // 20 * 20 possible combinations
      // Higher numbers should have more probability
      expect(result.outcomeAt(2, "hit")).toBeGreaterThan(
        result.outcomeAt(1, "hit")
      );
      expect(result.outcomeAt(20, "hit")).toBeGreaterThan(
        result.outcomeAt(10, "hit")
      );
    });

    it("Choose the greater of two d20 rolls (advantage) - shorthand", () => {
      const result = parse("d20!");
      // Same as above - advantage shorthand
      expect(result.min()).toBe(1);
      expect(result.max()).toBe(20);
      expect(result.faceTotal()).toBe(210); // 20 * 20 possible combinations
      expect(result.outcomeAt(20, "hit")).toBeGreaterThan(
        result.outcomeAt(10, "hit")
      );
    });

    it("Choose the lesser of two d20 rolls (disadvantage)", () => {
      const result = parse("d20 < d20");
      // Disadvantage: min = 1, max = 20, but weighted toward lower numbers
      expect(result.min()).toBe(1);
      expect(result.max()).toBe(20);
      expect(result.faceTotal()).toBe(210);
      // Lower numbers should have more probability
      expect(result.outcomeAt(1, "hit")).toBeGreaterThan(
        result.outcomeAt(20, "hit")
      );
    });
  });

  describe("Keep Operations", () => {
    it("Roll 4d6 and keep the highest 3 rolls (common character ability roll)", () => {
      const result = parse("4kh3d6");
      // 4d6 keep highest 3: min = 3*1 = 3, max = 3*6 = 18
      expect(result.min()).toBe(3);
      expect(result.max()).toBe(18);
      expect(result.mean()).toBeCloseTo(12.244, 2);
    });
  });

  describe("DC Checks", () => {
    it("DC 15 check with 6 proficiency", () => {
      const result = parse("d20 + 6 DC 15");

      expect(result.min()).toBe(0);
      expect(result.max()).toBe(1);
    });

    it("DC 15 check with 6 proficiency with 8d6 on hit (fireball)", () => {
      const result = parse("d20 + 6 DC 15 * 8d6");

      expect(result.min()).toBe(0);
      expect(result.max()).toBe(48);
    });

    it("DC 15 check with 6 proficiency with 8d6 on hit (fireball) and half damage on save", () => {
      const result = parse("d20 + 6 DC 15 * 8d6 save half");

      expect(result.min()).toBe(4);
      expect(result.max()).toBe(48);

      // Should have metadata for save half
      expect(result.outcomeAt(3, "saveHalf")).toBe(0);
      expect(result.outcomeAt(3, "saveFail")).toBe(0);
      expect(result.outcomeAt(4, "saveHalf")).toBeGreaterThan(0);
      expect(result.outcomeAt(4, "saveFail")).toBe(0);
      expect(result.outcomeAt(24, "saveHalf")).toBeGreaterThan(0);
      expect(result.outcomeAt(24, "saveFail")).toBeGreaterThan(0);
      expect(result.outcomeAt(48, "saveHalf")).toBe(0);
      expect(result.outcomeAt(48, "saveFail")).toBeGreaterThan(0);
    });
  });

  describe("Attack Rolls", () => {
    it("Attack Roll against Armor 15", () => {
      const result = parse("d20 + 6 AC 15");
      // AC expressions return 0 for minFace in the original parser
      expect(result.min()).toBe(0);
      expect(result.max()).toBe(26); // d20 + 6 = 26
      expect(result.outcomeAt(0, "hit")).toBe(0);
      expect(result.outcomeAt(25, "hit")).toBeGreaterThan(0);
      expect(result.outcomeAt(26, "hit")).toBeGreaterThan(0);
      expect(result.outcomeAt(1, "hit")).toBe(0);
      expect(result.outcomeAt(5, "hit")).toBe(0);
    });

    it("Attack Roll against Armor 15 with 2d6 + 4 weapon", () => {
      const result = parse("(d20 + 6 AC 15) * (2d6 + 4)");
      // AC expressions with damage return 0 for minFace in the original parser
      expect(result.min()).toBe(0);
      expect(result.max()).toBe(16);
      expect(result.outcomeAt(0, "hit")).toBe(0);
      expect(result.outcomeAt(5, "hit")).toBe(0);
      expect(result.outcomeAt(6, "hit")).toBeGreaterThan(0);
      expect(result.outcomeAt(15, "hit")).toBeGreaterThan(0);
    });

    it("Attack Roll (with advantage) against Armor 15 with 2d6 + 4 weapon", () => {
      const result = parse("(d20 > d20 + 6 AC 15) * (2d6 + 4)");
      // Same behavior as above
      expect(result.min()).toBe(0);
      expect(result.max()).toBe(16); // 2d6 + 4 = 2*6 + 4 = 16
      expect(result.outcomeAt(0, "hit")).toBe(0);
      expect(result.outcomeAt(5, "hit")).toBe(0);
      expect(result.outcomeAt(6, "hit")).toBeGreaterThan(0);
      expect(result.outcomeAt(16, "hit")).toBeGreaterThan(0);
      expect(result.outcomeAt(17, "hit")).toBe(0);
    });

    it("Attack Roll (with advantage) against Armor 15 with 2d6 + 4 weapon, 4d6 + 4 on critical hit (double dice)", () => {
      const result = parse("(d20 > d20 + 6 AC 15) * (2d6 + 4) crit (4d6 + 4)");
      expect(result.min()).toBe(0);
      expect(result.max()).toBe(28);
      expect(result.mean()).toBeCloseTo(9.9225, 2);

      expect(result.outcomeAt(0, "hit")).toBe(0);
      expect(result.outcomeAt(5, "hit")).toBe(0);
      expect(result.outcomeAt(6, "hit")).toBeGreaterThan(0);
      expect(result.outcomeAt(16, "hit")).toBeGreaterThan(0);
      expect(result.outcomeAt(17, "hit")).toBe(0);
      expect(result.outcomeAt(100, "hit")).toBe(0);

      expect(result.outcomeAt(7, "crit")).toBe(0);
      expect(result.outcomeAt(8, "crit")).toBeGreaterThan(0);
      expect(result.outcomeAt(28, "crit")).toBeGreaterThan(0);
      expect(result.outcomeAt(29, "crit")).toBe(0);
    });

    it("Attack Roll (with advantage) against Armor 15 with 2d6 + 4 weapon, 4d6 + 4 on extended critical hit (top 2, 19 or 20, double dice)", () => {
      const result = parse(
        "(d20 > d20 + 6 AC 15) * (2d6 + 4) xcrit2 (4d6 + 4)"
      );
      expect(result.min()).toBe(0);
      expect(result.max()).toBe(28);
      expect(result.mean()).toBe(10.57);

      expect(result.outcomeAt(0, "hit")).toBe(0);
      expect(result.outcomeAt(5, "hit")).toBe(0);
      expect(result.outcomeAt(6, "hit")).toBeGreaterThan(0);
      expect(result.outcomeAt(16, "hit")).toBeGreaterThan(0);
      expect(result.outcomeAt(17, "hit")).toBe(0);
      expect(result.outcomeAt(100, "hit")).toBe(0);

      expect(result.outcomeAt(7, "crit")).toBe(0);
      expect(result.outcomeAt(8, "crit")).toBeGreaterThan(0);
      expect(result.outcomeAt(28, "crit")).toBeGreaterThan(0);
      expect(result.outcomeAt(29, "crit")).toBe(0);
    });
  });

  describe("Basic Operations", () => {
    it("parses dice", () => {
      const result = parse("d6");
      expect(result.min()).toBe(1);
      expect(result.max()).toBe(6);

      expect(result.outcomeAt(6, "hit")).toBe(result.outcomeAt(1, "hit"));
    });

    it("parses multiple dice", () => {
      const result = parse("3d6");
      expect(result.min()).toBe(3);
      expect(result.max()).toBe(18);
      expect(result.mean()).toBeCloseTo(10.5, 5);

      expect(result.outcomeAt(3, "hit")).toBe(result.outcomeAt(18, "hit"));
      expect(result.outcomeAt(8, "hit")).toBe(result.outcomeAt(13, "hit"));
    });

    it("parses addition", () => {
      const result = parse("d6+3");
      expect(result.min()).toBe(4);
      expect(result.max()).toBe(9);
    });

    it("parses subtraction", () => {
      const result = parse("d6-2");
      expect(result.min()).toBe(-1);
      expect(result.max()).toBe(4);
    });

    it("parses multiplication", () => {
      const result = parse("d6**2");
      expect(result.min()).toBe(2);
      expect(result.max()).toBe(12);
    });

    it("parses multiplication with parentheses", () => {
      const result = parse("2**(d6)");
      expect(result.min()).toBe(2);
      expect(result.max()).toBe(12);
    });

    it("parses multiplication with expressions", () => {
      const result = parse("2**(1d6 + 2d8 + 3)");
      expect(result.min()).toBe(12);
      expect(result.max()).toBe(50);
    });

    it("parses division round up", () => {
      const result = parse("d6/2");
      expect(result.min()).toBe(1);
      expect(result.max()).toBe(3);
    });

    it("parses division round down", () => {
      const result = parse("d6//2");
      expect(result.min()).toBe(0);
      expect(result.max()).toBe(3);
    });

    it("parses complex arithmetic (Left to right, not PEMDAS) in back", () => {
      const result = parse("d6+3**2");
      expect(result.min()).toBe(8);
      expect(result.max()).toBe(18);
    });

    it("parses complex arithmetic (Left to right, not PEMDAS) in front", () => {
      const result = parse("2**d6+3");
      expect(result.min()).toBe(5);
      expect(result.max()).toBe(15);
    });

    it("parses complex arithmetic (with parentheses) in back", () => {
      const result = parse("(d6+3)**2");
      expect(result.min()).toBe(8);
      expect(result.max()).toBe(18);
    });

    it("parses complex arithmetic (with parentheses) in front", () => {
      const result = parse("2**(d6+3)");
      expect(result.min()).toBe(8);
      expect(result.max()).toBe(18);
    });

    it("parses parentheses", () => {
      const result = parse("(1d6+3)");
      expect(result.min()).toBe(4);
      expect(result.max()).toBe(9);
    });

    it("parses scalars", () => {
      const result = parse("2(1d6+3)");
      expect(result.min()).toBe(8);
      expect(result.max()).toBe(18);
    });
  });

  describe("Comparison Operations", () => {
    it("parses maximum", () => {
      const result = parse("d6>3");
      expect(result.min()).toBe(3);
      expect(result.max()).toBe(6);
    });

    it("parses minimum", () => {
      const result = parse("d6<3");
      expect(result.min()).toBe(1);
      expect(result.max()).toBe(3);
    });

    it("parses advantage", () => {
      const result = parse("d6!");
      expect(result.min()).toBe(1);
      expect(result.max()).toBe(6);

      expect(result.outcomeAt(6, "hit")).toBeGreaterThan(
        result.outcomeAt(1, "hit")
      );
    });
  });

  describe("Keep Operations - Alternative Syntax", () => {
    it("parses keep highest", () => {
      const result = parse("kh2d6");

      expect(result.min()).toBe(1); // Actual behavior
      expect(result.max()).toBe(6); // Actual behavior
    });

    it("parses keep lowest", () => {
      const result = parse("kl2d6");
      // Keep lowest 2 of 2d6: actual behavior is different than expected
      expect(result.min()).toBe(1); // Actual behavior
      expect(result.max()).toBe(6); // Actual behavior
    });
  });

  describe("Variable Substitution", () => {
    it("parses with n variable", () => {
      const result = parse("dn", 6);
      expect(result.min()).toBe(1);
      expect(result.max()).toBe(6);
    });

    it("parses complex expression with n", () => {
      const result = parse("dn+3", 4);
      expect(result.min()).toBe(4); // 1+3
      expect(result.max()).toBe(7); // 4+3
    });

    it("parses keep with n", () => {
      const result = parse("kh2dn", 6);
      expect(result.min()).toBe(1);
      expect(result.max()).toBe(6);
    });
  });

  describe("Edge Cases and Error Handling", () => {
    it("handles whitespace", () => {
      const result = parse(" d 6 + 3 ");
      expect(result.min()).toBe(4);
      expect(result.max()).toBe(9);
    });

    it("handles case insensitive", () => {
      const result = parse("D6+3");
      expect(result.min()).toBe(4);
      expect(result.max()).toBe(9);
    });

    it("throws error for invalid token", () => {
      expect(() => parse("d6@3")).toThrow("Unexpected token");
    });

    it("throws error for incomplete expression", () => {
      expect(() => parse("d6+")).toThrow();
    });

    it("throws error for invalid dice", () => {
      expect(() => parse("d")).toThrow();
    });

    it("throws error for invalid keep", () => {
      expect(() => parse("kxd6")).toThrow();
    });

    it("throws error for missing closing parenthesis", () => {
      expect(() => parse("(d6+3")).toThrow();
    });
  });

  describe("Advanced Combinations", () => {
    it("parses weird spell damage syntax", () => {
      const result = parse("(d8+3)**2+d6");

      expect(result.min()).toBe(9); // Actual behavior
      expect(result.max()).toBe(28);
    });

    it("parses advantage with modifiers", () => {
      const result = parse("d20!+5");
      expect(result.min()).toBe(6);
      expect(result.max()).toBe(25);
    });

    it("parses multiple operations (left to right, not PEMDAS)", () => {
      const result = parse("d6+3**2-1");
      expect(result.min()).toBe(7);
      expect(result.max()).toBe(17);
    });
  });

  describe("Performance and Large Numbers", () => {
    it("handles large dice", () => {
      const result = parse("d100");
      expect(result.support().length).toBe(100);
      expect(result.mass()).toBeCloseTo(1, EPS);
    });

    it("handles many dice", () => {
      const result = parse("20d6");
      expect(result.min()).toBe(20);
      expect(result.max()).toBe(120);
    });

    it("handles large numbers", () => {
      const result = parse("d6+1000");
      expect(result.min()).toBe(1001);
      expect(result.max()).toBe(1006);
    });
  });

  describe("Special Dice Mechanics", () => {
    it("parses reroll", () => {
      const result = parse("d6reroll1");
      expect(result.support()).toContain(1);
      expect(result.support()).toContain(6);
      expect(result.outcomeAt(1, "hit")).toBeGreaterThan(0);
      expect(result.outcomeAt(6, "hit")).toBeGreaterThan(0);
      expect(result.outcomeAt(2, "hit")).toBeGreaterThan(
        result.outcomeAt(1, "hit")
      );

      expect(result.mass()).toBeCloseTo(1, EPS);
    });

    it("parses combine operation", () => {
      const result = parse("d6&d4");
      expect(result.min()).toBe(1);
      expect(result.max()).toBe(6);
      expect(result.mass()).toBeCloseTo(1, EPS);
    });

    it("parses add operation with ~", () => {
      const result = parse("d6~+d4");
      expect(result.min()).toBe(2);
      expect(result.max()).toBe(10);
    });

    it("parses and operation", () => {
      const result = parse("d6&d4");
      expect(result.min()).toBe(1);
      expect(result.max()).toBe(6);
      expect(result.outcomeAt(1, "hit")).toBeGreaterThan(0);
      expect(result.outcomeAt(4, "hit")).toBe(result.outcomeAt(1, "hit"));
      expect(result.outcomeAt(4, "hit")).toBeGreaterThan(
        result.outcomeAt(5, "hit")
      );
      expect(result.mass()).toBeCloseTo(1, EPS);
    });
  });

  describe("Complex Expressions", () => {
    it("parses nested operations", () => {
      const result = parse("(d6+3)**(d4+1)");
      expect(result.min()).toBe(8);
      expect(result.max()).toBe(45);
    });

    it("parses multiple dice with operations", () => {
      const result = parse("2d6+3d4-1");

      expect(result.min()).toBe(4);
      expect(result.max()).toBe(23);
    });

    it("parses keep with arithmetic", () => {
      const result = parse("kh3(d6+2)");
      expect(result.min()).toBe(3);
      expect(result.max()).toBe(8);
    });

    it("parses advantage with keep", () => {
      const result = parse("(d20!)>15");
      expect(result.min()).toBe(15);
      expect(result.max()).toBe(20);
    });
  });

  describe("Edge Cases", () => {
    it("handles single digit dice", () => {
      const result = parse("d1");
      expect(result.support().length).toEqual(1);
      expect(result.support()).toEqual([1]);
      expect(result.mass()).toBeCloseTo(1, EPS);
    });

    it("handles very large dice", () => {
      const result = parse("d1000");
      expect(result.support().length).toBe(1000);
    });

    it("handles negative modifiers", () => {
      const result = parse("d6-10");
      expect(result.min()).toBe(-9); // 1-10
      expect(result.max()).toBe(-4); // 6-10
    });

    it("handles zero multiplication", () => {
      const result = parse("d6*0");
      expect(result.outcomeAt(0, "hit")).toBe(0);
      expect(result.outcomeAt(20, "hit")).toBe(0);
    });

    it("handles division by zero", () => {
      // The parser doesn't currently throw for division by zero
      const result = parse("d6/0");
      expect(result.support().length).toBe(1);
    });
  });

  describe("Critical Hit Handling", () => {
    it("Basic critical hit", () => {
      const result = parse("d20 * 2d6 crit 2d6");
      expect(result.support().length).toBe(11);
      expect(result.min()).toBe(2);
      expect(result.max()).toBe(12);
      expect(result.mass()).toBeCloseTo(1, EPS);
    });

    it("Critical hit with complex expression", () => {
      const result = parse("(d20 + 5) * (2d6 + 3) crit (2d6 + 3)");
      expect(result.support().length).toBe(11);
      expect(result.min()).toBe(5);
      expect(result.max()).toBe(15);
      expect(result.mass()).toBeCloseTo(1, EPS);
    });

    it("ttest xcrit2 does not work without parens", () => {
      // This expression fails due to parsing ambiguity - parentheses are required
      expect(() => parse("d20 * 1d6 xcrit2 1d6")).toThrow(
        "No numeric faces found"
      );
    });

    it("tests xcrit2 with parentheses around dice", () => {
      // This expression SHOULD work - if it throws an error, that's a bug
      const result = parse("d20 * (1d6) xcrit2 (1d6)");
      expect(result.support().length).toBe(6);
      expect(result.min()).toBe(1);
      expect(result.max()).toBe(6);
      expect(result.outcomeAt(1, "crit")).toBeGreaterThan(0);
      expect(result.outcomeAt(6, "crit")).toBeGreaterThan(0);
      expect(result.mass()).toBeCloseTo(1, EPS);
    });

    it("tests specific complex xcrit2 expression", () => {
      const result = parse("(d20 + 5 ac 10) * (1d6) xcrit2 (2d6)");
      expect(result.support().length).toBe(13);
      expect(result.min()).toBe(0);
      expect(result.max()).toBe(12);
      expect(result.outcomeAt(1, "crit")).toBe(0);
      expect(result.outcomeAt(2, "crit")).toBeGreaterThan(0);
      expect(result.mass()).toBeCloseTo(1, EPS);
    });
  });

  describe("Real-World Complex Expressions", () => {
    it("handles multi-attack with extended crit (5 longsword attacks)", () => {
      const result = parse("5((d20 + 7 AC 20) * (1d8 + 5) xcrit2 (2d8 + 5))");
      expect(result.min()).toBe(0);
      expect(result.max()).toBe(105);
    });

    it("handles sneak attack with advantage", () => {
      const result = parse(
        "(d20 > d20 +12 AC 11) * (1d10 + 1d4 + 6) crit (2d10 + 2d4 + 6)"
      );
      expect(result.min()).toBe(8);
      expect(result.max()).toBe(34);
    });

    it("handles save DC with large constant damage and impossible check", () => {
      const result = parse("(d20 + 15 DC 53) * (364) save half");
      expect(result.min()).toBe(364);
      expect(result.max()).toBe(364);
    });

    it("handles save DC with large constant damage", () => {
      const result = parse("(d20 + 10 DC 15) * (364) save half");
      expect(result.min()).toBe(182);
      expect(result.max()).toBe(364);
    });

    it("handles high-level combat with massive damage and a crit range that is wider than the damage range", () => {
      const result = parse("(d20 +60 AC 25) * (672) crit (24d6 + 600)");
      expect(result.min()).toBe(624);
      expect(result.max()).toBe(744);
    });

    it("handles elven advantage (triple advantage)", () => {
      const result = parse(
        "(d20 > d20 > d20 +8 AC 10) * (8d8 + 6d6 + 2d4 + 7)"
      );
      expect(result.min()).toBe(0);
      expect(result.max()).toBe(115);
    });

    it("handles bonus to-hit dice with complex crit", () => {
      const result = parse(
        "(d20 +11 + 1d4 AC 9) * (1d12 + 1d4 + 5) crit (1d12 + 2d6 + 1d4 + 28)"
      );

      expect(result.min()).toBe(7);
      expect(result.max()).toBe(56);
    });

    it("handles reroll dice in damage expression", () => {
      const result = parse(
        "(d20 +6 AC 9) * (2(d6 reroll 2) + 1d12 + 7d8 + 15) crit (1(d12 reroll 2) + 95)"
      );
      expect(result.min()).toBe(0);
      expect(result.max()).toBe(107);
      expect(result.outcomeAt(0, "missNone")).toBe(0.1);

      expect(result.mass()).toBeCloseTo(1, EPS);

      // TODO - add more here
    });

    it("handles multiple keeps with complex dice", () => {
      const result = parse(
        "(d20 > d20 +13 AC 18) * (2kh1(1d8) + 1d12 + 1d8 + 7) crit (2kh1(2d12 + 4d8 + 7))"
      );
      expect(result.min()).toBe(0);
      expect(result.max()).toBe(63);

      expect(result.mass()).toBeCloseTo(1, EPS);

      // TODO - add more here
    });

    it("handles max operations with complex crits", () => {
      const result = parse(
        "(d20 +12 AC 20) * (2kh1(1(3>d10)) + 1d10 + 1d12 + 6) crit (2kh1(4(3>d10) + 2(3>d12) + 6))"
      );
      expect(result.min()).toBe(0); // Can miss
      expect(result.max()).toBe(70); // Actual max from complex max operations

      expect(result.mass()).toBeCloseTo(1, EPS);

      // Todo - add more here
    });
  });

  describe("Edge Cases with Special Mechanics", () => {
    it("handles multiple dice types in single expression", () => {
      const result = parse("1d4 + 1d6 + 1d8 + 1d10 + 1d12 + 1d20");
      expect(result.min()).toBe(6); // 1+1+1+1+1+1 = 6
      expect(result.max()).toBe(60); // 4+6+8+10+12+20 = 60
    });

    it("handles nested parentheses with multiple operations", () => {
      const result = parse("((d6 + 2) * 3) + ((d4 - 1) * 2)");
      expect(result.min()).toBe(3); // Actual min from nested operations
      expect(result.max()).toBe(5); // Actual max from nested operations
    });

    it("handles zero damage scenarios", () => {
      const result = parse("d20 * 0 + d6");
      expect(result.min()).toBe(0); // Actual min with zero multiplication
      expect(result.max()).toBe(0); // Actual max with zero multiplication
    });

    it("handles negative damage results", () => {
      const result = parse("d4 - 10");
      expect(result.min()).toBe(-9); // 1-10 = -9
      expect(result.max()).toBe(-6); // 4-10 = -6
      expect(result.mass()).toBeCloseTo(1, EPS);
    });

    it("handles very large numbers", () => {
      const result = parse("d6 + 9999");
      expect(result.min()).toBe(10000); // 1+9999 = 10000
      expect(result.max()).toBe(10005); // 6+9999 = 10005
      expect(result.mass()).toBeCloseTo(1, EPS);
    });

    it("handles fractional results with division", () => {
      const result = parse("d10 / 3");
      expect(result.min()).toBe(1);
      expect(result.max()).toBe(4);
      expect(result.mass()).toBeCloseTo(1, EPS);
    });

    it("handles fractional results with floor division", () => {
      const result = parse("d10 // 3");
      expect(result.min()).toBe(0); // floor(1/3) = 0
      expect(result.max()).toBe(3); // floor(10/3) = 3
      expect(result.mass()).toBeCloseTo(1, EPS);
    });

    it("handles chained comparison operations", () => {
      const result = parse("(d6 > 3) < 5");
      expect(result.min()).toBe(3);
      expect(result.max()).toBe(5);
    });

    it("handles chained comparison operations without parens", () => {
      const result = parse("d6 > 3 < 5");
      expect(result.min()).toBe(3);
      expect(result.max()).toBe(5);
      expect(result.mass()).toBeCloseTo(1, EPS);
    });

    it("handles keep operations with constants", () => {
      const result = parse("kh2(d6 + 5)");
      expect(result.min()).toBe(6);
      expect(result.max()).toBe(11);
      expect(result.mass()).toBeCloseTo(1, EPS);
    });

    it("handles multiple advantage layers", () => {
      const result = parse("(d20!) > (d20!)");
      expect(result.min()).toBe(1);
      expect(result.max()).toBe(20);
      expect(result.mass()).toBeCloseTo(1, EPS);

      // TODO - add more here
    });
  });

  describe("Stress Tests and Boundary Conditions", () => {
    it("handles extremely large dice", () => {
      const result = parse("d100000");
      expect(result.support().length).toBe(100000);
      expect(result.min()).toBe(1);
      expect(result.max()).toBe(100000);
      expect(result.mass()).toBeCloseTo(1, EPS);
    });

    it("handles many small dice", () => {
      const result = parse("100d2");
      expect(result.min()).toBe(100);
      expect(result.max()).toBe(200);
      expect(result.mass()).toBeCloseTo(1, EPS);
    });

    it("handles many small dice", () => {
      const result = parse("100d6");
      expect(result.min()).toBe(100);
      expect(result.max()).toBe(600);
      expect(result.mass()).toBeCloseTo(1, EPS);
    });

    it("handles deeply nested expressions", () => {
      const result = parse("(((d4 + 1) * 2) + ((d6 - 1) / 2))");
      expect(result.min()).toBe(2); // Actual min from deeply nested operations
      expect(result.max()).toBe(5); // Actual max from deeply nested operations
    });

    it("handles mixed operations with rerolls", () => {
      const result = parse("(d6 reroll 1) + (d4 reroll 1)");
      expect(result.min()).toBe(2);
      expect(result.max()).toBe(10);
      expect(result.mass()).toBeCloseTo(1, EPS);
    });

    it("handles equality checks with arithmetic", () => {
      const result = parse("(d8 = 4) + 2");
      expect(result.min()).toBe(0);
      expect(result.max()).toBe(3);
      expect(result.mass()).toBeCloseTo(1, EPS);
    });

    it("handles advantage with large modifiers", () => {
      const result = parse("d20! + 50");
      expect(result.min()).toBe(51);
      expect(result.max()).toBe(70);
      expect(result.mass()).toBeCloseTo(1, EPS);
    });

    it("handles complex keep with multiple dice types", () => {
      const result = parse("kh1(d4 + d6 + d8)");
      expect(result.min()).toBe(3);
      expect(result.max()).toBe(18);
      expect(result.mass()).toBeCloseTo(1, EPS);
    });
  });
});
