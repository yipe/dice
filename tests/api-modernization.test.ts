import { describe, expect, it } from "vitest";
import { DiceParseError, parse, PMF } from "../src/index";

describe("DiceParseError", () => {
  it("is thrown for unexpected tokens and is an Error", () => {
    let caught: unknown;
    try {
      parse("d6@3");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DiceParseError);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as DiceParseError).message).toContain("Unexpected token");
    expect((caught as DiceParseError).expression).toBe("d6@3");
  });

  it("wraps parse failures with the original cause", () => {
    let caught: unknown;
    try {
      parse("d6+");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DiceParseError);
    expect((caught as DiceParseError).cause).toBeDefined();
  });
});

describe("PMF JSON serialization", () => {
  it("toJSON returns a plain object (no double-encoding)", () => {
    const pmf = PMF.delta(3);
    const json = pmf.toJSON();
    expect(typeof json).toBe("object");
    expect(Array.isArray(json.bins)).toBe(true);
  });

  it("round-trips through JSON.stringify + fromJSON", () => {
    const pmf = parse("2d6 + 3");
    const restored = PMF.fromJSON(JSON.parse(JSON.stringify(pmf)));
    expect(restored.mean()).toBeCloseTo(pmf.mean(), 12);
    expect(restored.support()).toEqual(pmf.support());
  });

  it("toJSONString preserves the legacy string output", () => {
    const pmf = PMF.delta(5);
    const str = pmf.toJSONString();
    expect(typeof str).toBe("string");
    expect(JSON.parse(str)).toEqual(pmf.toJSON());
  });
});

describe("DiceQuery.stdev alias", () => {
  it("matches stddev()", () => {
    const q = parse("2d6 + 3").query();
    expect(q.stdev()).toBe(q.stddev());
  });
});
