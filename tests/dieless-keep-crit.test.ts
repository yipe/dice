import { describe, expect, it } from "vitest";
import { parse } from "../src/parser/parser";
import { AmbiguousCritDoublingError, scaleParsedDice } from "../src/parser/scaleDice";

/**
 * A keep with no dice inside is a constant, so an attack payload made of it has nothing to double:
 * its crit is the hit payload itself, whatever the keep's mode or count.
 */
describe("a keep with no dice inside doubles to itself", () => {
  it("(d20 + 5 AC 15) * (3kl2(4)) hits and crits for 8: mean 11/20 · 8 = 22/5", () => {
    const pmf = parse("(d20 + 5 AC 15) * (3kl2(4))");
    expect(pmf.mean()).toBeCloseTo(22 / 5, 12);
    expect(pmf.outcomeProbability("crit")).toBeCloseTo(1 / 20, 12);
    expect(pmf.filterOutcome("crit").support()).toEqual([8]);
  });

  it("scaleParsedDice leaves a dieless keep alone and still refuses a keep of dice", () => {
    expect(scaleParsedDice("2kh2(0) + 5", 2)).toBe("2kh2(0) + 5");
    expect(scaleParsedDice("3kl2(4)", 2)).toBe("3kl2(4)");
    expect(() => scaleParsedDice("3kl2(1d4)", 2)).toThrow(AmbiguousCritDoublingError);
  });
});
