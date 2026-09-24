import { describe, expect, it } from "vitest";
import { d6, d8, roll } from "../src/builder/factory";
import { AmbiguousKeepError, RollBuilder } from "../src/builder/roll";
import { expectDist, keep, max, min, point, repeat, uniform } from "./enumerate-dice";

const u6 = uniform(6);

describe("per-die keepHighest/keepLowest shapes with one reading", () => {
  it("one die: keep K of T dice", () => {
    expectDist(roll(1, d6).keepHighest(3, 2).toPMF(), keep(u6, 3, 2, true));
    expectDist(roll(1, d6).keepLowest(3, 2).toPMF(), keep(u6, 3, 2, false));
    expectDist(roll(1, d6).keepLowest(2, 1).toPMF(), min(u6, u6));
  });

  it("N dice, keep K >= 2 of those N dice", () => {
    expectDist(roll(3, d6).keepHighest(3, 2).toPMF(), keep(u6, 3, 2, true));
    expectDist(roll(4, d8).keepLowest(4, 2).toPMF(), keep(uniform(8), 4, 2, false));
  });

  it("N dice, keep the best of T rolls of the whole N-dice sum", () => {
    const threeD6 = repeat(u6, 3);
    const pmf = roll(3, d6).keepHighest(3, 1).toPMF();
    expectDist(pmf, max(threeD6, threeD6, threeD6));
    expect(pmf.mean()).toBeCloseTo(22489 / 1728, 12);
    expectDist(roll(2, d6).keepHighest(2, 1).toPMF(), max(repeat(u6, 2), repeat(u6, 2)));
  });

  it("N dice, keep the worst of T != N rolls of the whole N-dice sum", () => {
    const twoD6 = repeat(u6, 2);
    expectDist(roll(2, d6).keepLowest(3, 1).toPMF(), min(twoD6, twoD6, twoD6));
  });

  it("keeping none of the dice is 0", () => {
    expectDist(roll(2, d6).keepHighest(3, 0).toPMF(), point(0));
  });

  it("bestOf(k) keeps the k highest of the individual dice", () => {
    expectDist(roll(3, d6).bestOf(1).toPMF(), max(u6, u6, u6));
    expectDist(roll(4, d6).bestOf(3).toPMF(), keep(u6, 4, 3, true));
  });
});

describe("per-die keep shapes with more than one reading throw", () => {
  it.each([
    ["roll(3,d6).keepHighest(4,2)", () => roll(3, d6).keepHighest(4, 2)],
    ["roll(2,d6).keepHighest(4,3)", () => roll(2, d6).keepHighest(4, 3)],
    ["roll(3,d8).keepHighest(4,3)", () => roll(3, d8).keepHighest(4, 3)],
    ["roll(8,d10).keepLowest(4,2)", () => roll(8, 10).keepLowest(4, 2)],
    ["roll(2,d6).keepLowest(4,3)", () => roll(2, d6).keepLowest(4, 3)],
    ["roll(3,d6).keepLowest(3,1)", () => roll(3, d6).keepLowest(3, 1)],
    ["roll(2,d6).keepLowest(2,1)", () => roll(2, d6).keepLowest(2, 1)],
  ])("%s", (_name, build) => {
    expect(build).toThrow(AmbiguousKeepError);
    expect(build).toThrow(/keepHighestAll|keepLowestAll/);
  });

  it("also throws when the shape reaches the resolver from a hand-built config", () => {
    const config = { count: 3, sides: 6, keep: { total: 4, count: 2, mode: "highest" as const } };
    expect(() => RollBuilder.fromConfig(config).toPMF()).toThrow(AmbiguousKeepError);
  });
});
