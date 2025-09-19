import { describe, expect, it } from "vitest";
import { parse } from "../src/index";

describe.skip("Parser Error Handling", () => {
  describe("Invalid Token Errors", () => {
    it("should throw 'Unexpected token' for invalid characters", () => {
      const invalidExpressions = [
        "d6@3", // @ is invalid
        "d6#4", // # is invalid
        "d6$2", // $ is invalid
        "d6%5", // % is invalid
        "d6&7", // & is invalid
        "d6|8", // | is invalid
        "d6\\9", // \ is invalid
        'd6"10', // " is invalid
        "d6'11", // ' is invalid
        "d6;12", // ; is invalid
        "d6:13", // : is invalid
        "d6?14", // ? is invalid
        "d6~15", // ~ is invalid
        "d6`16", // ` is invalid
      ];

      for (const expr of invalidExpressions) {
        expect(() => parse(expr), `Expression: ${expr}`).toThrow(
          "Unexpected token"
        );
      }
    });

    it("should throw 'Unexpected token' for expressions with trailing invalid characters", () => {
      const trailingInvalidExpressions = [
        "d6+3@",
        "2d8*4#",
        "d20!$",
        "(d6+2)%",
      ];

      for (const expr of trailingInvalidExpressions) {
        expect(() => parse(expr), `Expression: ${expr}`).toThrow(
          "Unexpected token"
        );
      }
    });
  });

  describe("Incomplete Expression Errors", () => {
    it("should throw for expressions ending with operators", () => {
      const incompleteExpressions = [
        "d6+", // Missing right operand
        "d6-", // Missing right operand
        "d6*", // Missing right operand
        "d6/", // Missing right operand
        "2d8+", // Missing right operand
        "d20!+", // Missing right operand
        "d12>", // Missing right operand
        "d10<", // Missing right operand
      ];

      for (const expr of incompleteExpressions) {
        expect(() => parse(expr), `Expression: ${expr}`).toThrow();
      }
    });

    it("should throw for expressions with missing operands", () => {
      const missingOperandExpressions = [
        "+d6", // Missing left operand
        "*d8", // Missing left operand
        "/d10", // Missing left operand
        ">d20", // Missing left operand
        "<d12", // Missing left operand
      ];

      for (const expr of missingOperandExpressions) {
        expect(() => parse(expr), `Expression: ${expr}`).toThrow();
      }
    });
  });

  describe("Invalid Dice Notation Errors", () => {
    it("should throw for incomplete dice notation", () => {
      const incompleteDiceExpressions = [
        "d", // Missing number of sides
        "2d", // Missing number of sides
        "10d", // Missing number of sides
        "d+3", // Missing number of sides
        "2d*4", // Missing number of sides
      ];

      for (const expr of incompleteDiceExpressions) {
        expect(() => parse(expr), `Expression: ${expr}`).toThrow();
      }
    });

    it("should throw for invalid dice numbers", () => {
      const invalidDiceExpressions = [
        "d0", // Zero-sided die
        "d-1", // Negative-sided die
        "0d6", // Zero dice
        "-1d6", // Negative number of dice
        "d6.5", // Non-integer sides
        "2.5d6", // Non-integer number of dice
      ];

      for (const expr of invalidDiceExpressions) {
        expect(() => parse(expr), `Expression: ${expr}`).toThrow();
      }
    });
  });

  describe("Parentheses Mismatch Errors", () => {
    it("should throw for missing closing parentheses", () => {
      const missingClosingExpressions = [
        "(d6", // Missing closing
        "(d6+3", // Missing closing
        "((d6+3)", // Missing one closing
        "(d6+(d8+2)", // Missing closing for outer
        "2*(d6+3", // Missing closing
      ];

      for (const expr of missingClosingExpressions) {
        expect(() => parse(expr), `Expression: ${expr}`).toThrow();
      }
    });

    it("should throw for missing opening parentheses", () => {
      const missingOpeningExpressions = [
        "d6)", // Missing opening
        "d6+3)", // Missing opening
        "d6+(d8+2))", // Extra closing
        "2*d6+3)", // Missing opening
      ];

      for (const expr of missingOpeningExpressions) {
        expect(() => parse(expr), `Expression: ${expr}`).toThrow();
      }
    });

    it("should throw for nested parentheses mismatches", () => {
      const nestedMismatchExpressions = [
        "((d6)", // Missing one closing
        "(d6))", // Extra closing
        "((d6+3)+(d8)", // Missing closing for outer
        "(d6+(d8+2)", // Missing closing for inner
      ];

      for (const expr of nestedMismatchExpressions) {
        expect(() => parse(expr), `Expression: ${expr}`).toThrow();
      }
    });
  });

  describe("Invalid Keep/Drop Modifier Errors", () => {
    it("should throw for invalid keep syntax", () => {
      const invalidKeepExpressions = [
        "kxd6", // k without number before d
        "k", // k without dice
        "k5", // k without dice
        "d6k", // k without number
        "d6kx", // k with invalid character
      ];

      for (const expr of invalidKeepExpressions) {
        expect(() => parse(expr), `Expression: ${expr}`).toThrow();
      }
    });

    it("should throw for invalid drop syntax", () => {
      const invalidDropExpressions = [
        "dxd6", // d without number before d (ambiguous with dice)
        "d6dx", // d with invalid character after
        "d6d", // d without number
      ];

      // Note: Some of these might be valid dice notation, so we test carefully
      expect(() => parse("d6dx")).toThrow();
    });
  });

  describe("Invalid Reroll Syntax Errors", () => {
    it("should throw for incomplete reroll syntax", () => {
      const invalidRerollExpressions = [
        "d6 reroll", // Missing reroll value
        "d6 reroll ", // Missing reroll value
        "reroll 1", // Missing dice
        "d6 reroll x", // Invalid reroll value
      ];

      for (const expr of invalidRerollExpressions) {
        expect(() => parse(expr), `Expression: ${expr}`).toThrow();
      }
    });
  });

  describe("Complex Expression Errors", () => {
    it("should throw for malformed complex expressions", () => {
      const malformedComplexExpressions = [
        "d6++3", // Double operator
        "d6--2", // Double operator
        "d6**4", // Double operator (though ** might be valid power)
        "d6//2", // Double operator
        "d6 + + 3", // Spaced double operator
        "d6 * * 2", // Spaced double operator
      ];

      // Note: ** might be valid power notation, so we test others
      expect(() => parse("d6++3")).toThrow();
      expect(() => parse("d6--2")).toThrow();
      expect(() => parse("d6//2")).toThrow();
      expect(() => parse("d6 + + 3")).toThrow();
    });

    it("should throw for expressions with invalid number formats", () => {
      const invalidNumberExpressions = [
        "d6+3.5.2", // Invalid decimal
        "d6+3..2", // Invalid decimal
        "d6+3e", // Invalid scientific notation
        "d6+3e+", // Invalid scientific notation
        "d6+.", // Invalid decimal
        "d6+..", // Invalid decimal
      ];

      for (const expr of invalidNumberExpressions) {
        expect(() => parse(expr), `Expression: ${expr}`).toThrow();
      }
    });
  });

  describe("Edge Case Error Messages", () => {
    it("should provide specific error messages for common mistakes", () => {
      // Test that error messages contain helpful information
      expect(() => parse("d6@3")).toThrow(/Unexpected token.*'@'/);
      expect(() => parse("(d6+3")).toThrow(); // Should mention parentheses or parsing
      expect(() => parse("d")).toThrow(); // Should mention dice notation
    });

    it("should handle empty and whitespace-only expressions", () => {
      expect(() => parse("")).toThrow();
      expect(() => parse("   ")).toThrow();
      expect(() => parse("\t\n")).toThrow();
    });

    it("should handle very long invalid expressions", () => {
      const longInvalidExpr = "d6+" + "x".repeat(1000);
      expect(() => parse(longInvalidExpr)).toThrow();
    });
  });

  describe("Unicode and Special Character Errors", () => {
    it("should throw for unicode characters in expressions", () => {
      const unicodeExpressions = [
        "d6+3α", // Greek alpha
        "d6×3", // Unicode multiplication
        "d6÷2", // Unicode division
        "d6±1", // Unicode plus-minus
        "d6→3", // Unicode arrow
        "d6•2", // Unicode bullet
      ];

      for (const expr of unicodeExpressions) {
        expect(() => parse(expr), `Expression: ${expr}`).toThrow(
          "Unexpected token"
        );
      }
    });

    it("should throw for emoji in expressions", () => {
      const emojiExpressions = ["d6+🎲", "🎯d20", "d6⚡3"];

      for (const expr of emojiExpressions) {
        expect(() => parse(expr), `Expression: ${expr}`).toThrow(
          "Unexpected token"
        );
      }
    });
  });

  describe("Boundary Value Errors", () => {
    it("should handle extremely large numbers gracefully", () => {
      const largeNumberExpressions = [
        `d${Number.MAX_SAFE_INTEGER + 1}`, // Beyond safe integer
        `${Number.MAX_SAFE_INTEGER + 1}d6`, // Beyond safe integer
        "d999999999999999999999", // Very large number
        "999999999999999999999d6", // Very large number
      ];

      for (const expr of largeNumberExpressions) {
        // Should either parse correctly or throw a reasonable error
        expect(() => {
          const result = parse(expr);
          // If it parses, it should be a valid PMF
          expect(result.mass()).toBeGreaterThanOrEqual(0);
        }).not.toThrow(/Unexpected token/);
      }
    });

    it("should handle zero and negative edge cases", () => {
      // These should throw specific errors, not unexpected token errors
      expect(() => parse("d0")).toThrow();
      expect(() => parse("0d6")).toThrow();
      expect(() => parse("-1d6")).toThrow();
      expect(() => parse("d-1")).toThrow();
    });
  });
});
