import { describe, expect, it } from "vitest";
import { d4, d6, d8, roll } from "../src/builder/factory";
import { sumRolls } from "../src/builder/roll";
import { add, expectDist, map, max, negate, repeat, shift, uniform } from "./enumerate-dice";

const u4 = uniform(4);
const u6 = uniform(6);
const u8 = uniform(8);
const twoD6 = repeat(u6, 2);
const halfOf2d6 = map(twoD6, (v) => Math.floor(v / 2));
/** A d6 that rerolls a 1 or 2 once and keeps the second roll: each face gains (2/6)(1/6). */
const d6Reroll2 = new Map([1, 2, 3, 4, 5, 6].map((v): [number, number] => [v, (v <= 2 ? 0 : 1 / 6) + 1 / 18]));

describe("arithmetic after half() and scaleResult() keeps the transform", () => {
  it("roll(2,d6).half().plus(1) is floor(2d6 / 2) + 1", () => {
    const pmf = roll(2, d6).half().plus(1).toPMF();
    expectDist(pmf, shift(halfOf2d6, 1));
    expect(pmf.mean()).toBeCloseTo(17 / 4, 12);
  });

  it("roll(2,d6).scaleResult(2).plus(1) is 2 * 2d6 + 1", () => {
    const pmf = roll(2, d6).scaleResult(2).plus(1).toPMF();
    expectDist(pmf, shift(map(twoD6, (v) => 2 * v), 1));
    expect(pmf.mean()).toBeCloseTo(15, 12);
  });

  it("minus, dice and chained arithmetic compose too", () => {
    expectDist(roll(2, d6).half().minus(1).toPMF(), shift(halfOf2d6, -1));
    expectDist(roll(2, d6).half().plus(d4).plus(2).toPMF(), shift(add(halfOf2d6, u4), 2));
    expectDist(roll(2, d6).half().minus(2, d4).toPMF(), add(halfOf2d6, negate(repeat(u4, 2))));
    expectDist(roll(2, d6).half().plus(roll(1, d8).scaleResult(2)).toPMF(), add(halfOf2d6, map(u8, (v) => 2 * v)));
  });

  it("a transformed roll added to a plain roll keeps its transform", () => {
    expectDist(d6.plus(roll(2, d6).half()).toPMF(), add(u6, halfOf2d6));
    expectDist(d6.minus(roll(2, d6).half()).toPMF(), add(u6, negate(halfOf2d6)));
    expectDist(roll(2, d8.half()).toPMF(), repeat(map(u8, (v) => Math.floor(v / 2)), 2));
    expectDist(roll(-1, d8.half()).toPMF(), negate(map(u8, (v) => Math.floor(v / 2))));
    expectDist(sumRolls([d6.half(), d8]).plus(1).toPMF(), shift(add(map(u6, (v) => Math.floor(v / 2)), u8), 1));
  });

  it("refuses die verbs that would silently drop the transform", () => {
    expect(() => roll(2, d6).half().reroll(1)).toThrow(/half\(\)/);
    expect(() => roll(2, d6).scaleResult(2).minimum(2)).toThrow(/scaleResult\(\)/);
    expect(() => roll(2, d6).maxOf(2).keepHighest(2, 1)).toThrow(/maxOf\(\)/);
  });
});

describe("maxOf() takes the highest of whole rolls", () => {
  it("keeps the inner roll's flat: roll(2,d6).plus(3).maxOf(2)", () => {
    const pmf = roll(2, d6).plus(3).maxOf(2).toPMF();
    expectDist(pmf, shift(max(twoD6, twoD6), 3));
    expect(pmf.mean()).toBeCloseTo(7369 / 648, 12);
  });

  it("keeps the inner roll's reroll: roll(2,d6).reroll(2).maxOf(2)", () => {
    const pmf = roll(2, d6).reroll(2).maxOf(2).toPMF();
    const inner = repeat(d6Reroll2, 2);
    expectDist(pmf, max(inner, inner));
    expect(pmf.mean()).toBeCloseTo(496795 / 52488, 12);
  });

  it("takes several dice groups as one roll: roll(1,d8).plus(roll(1,d6)).maxOf(2)", () => {
    const pmf = roll(1, d8).plus(roll(1, d6)).maxOf(2).toPMF();
    const inner = add(u8, u6);
    expectDist(pmf, max(inner, inner));
    expect(pmf.mean()).toBeCloseTo(2773 / 288, 12);
  });

  it("takes the highest of this roll and another roll", () => {
    const threeD8 = repeat(u8, 3);
    expectDist(roll(3, d8).maxOf(roll(3, d8)).toPMF(), max(threeD8, threeD8));
    expectDist(roll(2, d6).maxOf(d8.plus(2)).toPMF(), max(twoD6, shift(u8, 2)));
  });

  it("composes with arithmetic after it", () => {
    expectDist(roll(2, d6).maxOf(2).plus(3).toPMF(), shift(max(twoD6, twoD6), 3));
  });
});
