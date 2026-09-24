import { describe, expect, it } from "vitest";
import { DiceParseError } from "../src/common/errors";
import { parse } from "../src/parser/parser";

describe("division by zero", () => {
  it.each(["1d6 / 0", "1d6 // 0", "(1d6 - 3) // 0", "1d6 / (1d2 - 1)", "1d6 // (1d4 - 1d4)"])("%s throws a DiceParseError", (expression) => {
    expect(() => parse(expression)).toThrow(DiceParseError);
    expect(() => parse(expression)).toThrow(/[Dd]ivision by zero/);
  });

  it("a divisor that is never 0 still divides: 1d8 / 2 rounds up, 1d8 // 2 down", () => {
    expect(parse("1d8 / 2").mean()).toBeCloseTo(5 / 2, 12);
    expect(parse("1d8 // 2").mean()).toBeCloseTo(2, 12);
    expect(parse("12 // (1d2 + 1)").mean()).toBeCloseTo(5, 12);
  });
});
