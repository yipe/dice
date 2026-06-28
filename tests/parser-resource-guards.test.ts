import { describe, expect, it } from "vitest";
import { DiceParseError, parse } from "../src/index";

/**
 * Resource-exhaustion guards (item 7).
 *
 * Adversarial expressions — an enormous die, an enormous dice count, or a keep
 * over a combinatorially huge enumerated pool — must be rejected rather than
 * exhausting memory/CPU. The caps are generous enough that every legitimate
 * expression still parses.
 */
describe("parser resource-exhaustion guards", () => {
  describe("die size cap", () => {
    it("rejects a die larger than the cap", () => {
      expect(() => parse("d2000000")).toThrow(/exceeds the maximum/);
      expect(() => parse("d2000000")).toThrow(DiceParseError);
    });

    it("still allows large-but-legal dice (d100000)", () => {
      const r = parse("d100000");
      expect(r.support().length).toBe(100000);
      expect(r.max()).toBe(100000);
    });

    it("allows a normal die", () => {
      expect(parse("d20").max()).toBe(20);
    });
  });

  describe("dice count cap", () => {
    it("rejects a dice count larger than the cap", () => {
      expect(() => parse("10001d2")).toThrow(/Dice count .* exceeds the maximum/);
      expect(() => parse("20000d6")).toThrow(DiceParseError);
    });

    it("still allows a modest dice count", () => {
      const r = parse("50d6");
      expect(r.min()).toBe(50);
      expect(r.max()).toBe(300);
    });
  });

  describe("keep enumeration cap", () => {
    it("rejects a keep over a combinatorially huge pool", () => {
      // 10^10 enumerated outcomes — far over the cap.
      expect(() => parse("10kh1d10")).toThrow(/Keep enumeration .* exceeds the maximum/);
      expect(() => parse("10kh1d10")).toThrow(DiceParseError);
    });

    it("still allows a normal keep pool (4kh3d6 = 6^4 outcomes)", () => {
      const r = parse("4kh3d6");
      // keep highest 3 of 4d6 -> support 3..18
      expect(r.min()).toBe(3);
      expect(r.max()).toBe(18);
      expect(r.mass()).toBeCloseTo(1, 9);
    });
  });

  describe("binary-operation work budget", () => {
    it("rejects a binary op between two large dice (product of face counts)", () => {
      // Each operand is individually legal (well under the die-size cap), but the
      // dice×dice operation is O(faces1 × faces2) and would otherwise hang.
      expect(() => parse("d20000 + d20000")).toThrow(/face pairs.*exceeds the maximum/);
      expect(() => parse("d20000 + d20000")).toThrow(DiceParseError);
      // Also covers other dice×dice operators (multiply / comparison).
      expect(() => parse("d20000 ** d20000")).toThrow(DiceParseError);
      expect(() => parse("d50000 > d50000")).toThrow(DiceParseError);
    });

    it("still allows a normal binary op between modest dice", () => {
      const r = parse("d1000 + d1000"); // 10^6 face pairs, well under the budget
      expect(r.min()).toBe(2);
      expect(r.max()).toBe(2000);
      expect(r.mass()).toBeCloseTo(1, 9);
    });
  });
});
