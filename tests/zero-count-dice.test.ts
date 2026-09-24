import { describe, expect, it } from "vitest";
import { d20, d6, d8, flat, roll } from "../src/builder/factory";
import { RollBuilder } from "../src/builder/roll";
import { expectDist, point, repeat, uniform } from "./enumerate-dice";

/** A group of zero dice rolls nothing: only its flat modifier is left. */
describe("zero-count dice groups", () => {
  it.each([
    ["roll(0, d6)", () => roll(0, d6)],
    ["roll(0, 6)", () => roll(0, 6)],
    ["new RollBuilder(0).d6()", () => new RollBuilder(0).d6()],
    ["roll(0, d20)", () => roll(0, d20)],
    ["roll(0, d6.plus(2))", () => roll(0, d6.plus(2))],
    ["roll(0, d6).reroll(1)", () => roll(0, d6).reroll(1)],
    ["roll(0, d6).minimum(3)", () => roll(0, d6).minimum(3)],
    ["roll(0, d6).keepHighest(2, 1)", () => roll(0, d6).keepHighest(2, 1)],
    ["roll(0, d6).keepHighest(3, 2)", () => roll(0, d6).keepHighest(3, 2)],
    ["roll(0, d6).bestOf(1)", () => roll(0, d6).bestOf(1)],
    ["roll(0, d6).explode(1)", () => roll(0, d6).explode(1)],
    ["roll(0, d8).explodePool(2)", () => roll(0, d8).explodePool(2)],
    ["roll(0, d6).withAdvantage()", () => roll(0, d6).withAdvantage()],
  ])("%s is always 0", (_name, build) => {
    expectDist(build().toPMF(), point(0));
  });

  it("keeps the flat modifier of a zero-dice group", () => {
    expectDist(roll(0, d6).plus(3).toPMF(), point(3));
    expectDist(roll(0, 6, 3).toPMF(), point(3));
  });

  it("adds nothing when a zero-dice group joins a roll", () => {
    expectDist(d8.plus(roll(0, d6)).toPMF(), uniform(8));
    expectDist(roll(2, d8).plus(0, d6).toPMF(), repeat(uniform(8), 2));
    expect(roll(2, d8).plus(0, d6).toPMF().mean()).toBeCloseTo(9, 12);
  });

  it("leaves the flat-only rolls unchanged", () => {
    expectDist(roll(0).toPMF(), point(0));
    expectDist(flat(4).toPMF(), point(4));
    expectDist(roll.flat(-2).toPMF(), point(-2));
  });
});
