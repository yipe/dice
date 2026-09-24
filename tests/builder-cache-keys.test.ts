import { describe, expect, it } from "vitest";
import "../src/builder/ac";
import "../src/builder/dc";
import { d, d20, d6, roll } from "../src/builder/factory";
import { RollBuilder } from "../src/builder/roll";
import { expectDist, keep, point, repeat, uniform } from "./enumerate-dice";

describe("non-finite builder arguments", () => {
  it.each([Infinity, -Infinity])("refuses %s wherever a number is taken", (value) => {
    expect(() => roll(1, d6).plus(value)).toThrow(/finite/);
    expect(() => roll(1, d6).minus(value)).toThrow(/finite/);
    expect(() => roll(2, d6).keepHighest(2, value)).toThrow(/finite/);
    expect(() => roll(2, d6).keepHighest(value, 1)).toThrow(/finite/);
    expect(() => roll(2, d6).keepLowest(2, value)).toThrow(/finite/);
    expect(() => roll(2, d6).minimum(value)).toThrow(/finite/);
    expect(() => roll(2, d6).reroll(value)).toThrow(/finite/);
    expect(() => d20.plus(value).dc(15)).toThrow(/finite/);
    expect(() => new RollBuilder(value)).toThrow(/finite/);
    expect(() => roll(1).d(value)).toThrow(/finite/);
  });

  it("gives configs differing only in the sign of an infinite field different cache keys", () => {
    const keepAll = () =>
      RollBuilder.fromConfig({ count: 2, sides: 6, keep: { total: 2, count: Infinity, mode: "highest" } });
    const keepNone = () =>
      RollBuilder.fromConfig({ count: 2, sides: 6, keep: { total: 2, count: -Infinity, mode: "highest" } });
    expect(keepAll().cacheKey()).not.toBe(keepNone().cacheKey());

    expectDist(keepAll().toPMF(), repeat(uniform(6), 2));
    expectDist(keepNone().toPMF(), point(0));
    expectDist(keepAll().toPMF(), repeat(uniform(6), 2));

    const nanKey = RollBuilder.fromConfig({ sides: 6, minimum: NaN }).cacheKey();
    expect(nanKey).not.toBe(RollBuilder.fromConfig({ sides: 6, minimum: Infinity }).cacheKey());
    expect(nanKey).not.toBe(RollBuilder.fromConfig({ sides: 6, minimum: -Infinity }).cacheKey());
  });
});

describe("keep over trials whose distributions agree to six digits", () => {
  // Both trials are 0/1 variables; their chances of a 1 agree to six significant digits.
  const p1 = 1654021 / 3960100;
  const p2 = 75181 / 180000;
  const x1 = () => roll(1, d(200)).plus(roll(2, d(199))).scaleResult(1, 323, "floor");
  const x2 = () => roll(2, d(200)).plus(roll(1, d(198))).scaleResult(1, 323, "floor");
  const trial = (p: number) =>
    new Map([
      [0, 1 - p],
      [1, p],
    ]);

  it("keeps the two per-trial distributions apart for a keep-2-of-3 pool", () => {
    expectDist(x1().keepHighestAll(3, 2).toPMF(), keep(trial(p1), 3, 2, true));
    expectDist(x2().keepHighestAll(3, 2).toPMF(), keep(trial(p2), 3, 2, true));
    expect(x2().keepHighestAll(3, 2).toPMF().mean()).toBeCloseTo(6882656447845259 / 5832000000000000, 14);
  });

  it("keeps the two per-trial distributions apart for a keep-lowest-1-of-3 pool", () => {
    expectDist(x1().keepLowestAll(3, 1).toPMF(), keep(trial(p1), 3, 1, false));
    expect(x2().keepLowestAll(3, 1).toPMF().pAt(1)).toBeCloseTo(424936752154741 / 5832000000000000, 14);
  });
});
