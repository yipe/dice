import { describe, expect, it } from "vitest";
import { DiceParseError } from "../src/common/errors";
import { parse } from "../src/parser/parser";

/**
 * A repeat whose outcome counts outgrow exact whole numbers still resolves: its counts become
 * probabilities instead of overflowing to an empty distribution.
 */
describe("large repeats keep their mass", () => {
  it("200d100 has mean 10100 and variance 200 · (100² - 1) / 12", () => {
    const pmf = parse("200d100");
    expect(pmf.mass()).toBeCloseTo(1, 12);
    expect(pmf.mean()).toBeCloseTo(10100, 8);
    expect(pmf.variance()).toBeCloseTo((200 * (100 * 100 - 1)) / 12, 6);
  });

  it("(1d100)d6 has mean 101/2 · 7/2 = 707/4", () => {
    const pmf = parse("(1d100)d6");
    expect(pmf.mass()).toBeCloseTo(1, 12);
    expect(pmf.mean()).toBeCloseTo(707 / 4, 9);
  });

  it("a sum whose counts overflow throws a DiceParseError instead of returning mass 0", () => {
    const expression = Array.from({ length: 300 }, () => "d20").join(" ~+ ");
    expect(() => parse(expression)).toThrow(DiceParseError);
    expect(() => parse(expression)).toThrow(/overflow/);
  });
});
