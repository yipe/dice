import { describe, expect, it } from "vitest";
import "../src/builder/ac";
import "../src/builder/dc";
import { d } from "../src/builder/factory";
import { ParsedCheckError, RollBuilder } from "../src/builder/roll";

describe("a parsed string used as an attack or save check", () => {
  it.each([
    ["d('d20+5').ac(15)", () => d("d20+5").ac(15)],
    ["RollBuilder.fromArgs('d20+5').ac(15)", () => RollBuilder.fromArgs("d20+5").ac(15)],
    ["d('d20+5').dc(15)", () => d("d20+5").dc(15)],
    ["RollBuilder.fromArgs('d20 + 3 + 1d4').dc(12)", () => RollBuilder.fromArgs("d20 + 3 + 1d4").dc(12)],
  ])("%s throws instead of dropping the string's flats and dice", (_name, build) => {
    expect(build).toThrow(ParsedCheckError);
    expect(build).toThrow(/d20\.plus|AC/);
  });

  it("stays usable as a damage payload", () => {
    expect(d("2d6+3").toPMF().mean()).toBeCloseTo(10, 12);
  });
});
