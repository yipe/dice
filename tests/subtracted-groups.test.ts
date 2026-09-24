import { describe, expect, it } from "vitest";
import "../src/builder/ac";
import { d20, d4, d6, roll } from "../src/builder/factory";
import { add, expectDist, negate, repeat, shift, uniform } from "./enumerate-dice";

const u4 = uniform(4);
const u6 = uniform(6);
const twoD6 = repeat(u6, 2);

describe("a subtracted roll subtracts its own flat modifier too", () => {
  it("roll(2,d6).minus(roll(1,d4).plus(2)) is 2d6 - (d4 + 2)", () => {
    const pmf = roll(2, d6).minus(roll(1, d4).plus(2)).toPMF();
    expectDist(pmf, shift(add(twoD6, negate(u4)), -2));
    expect(pmf.mean()).toBeCloseTo(5 / 2, 12);
  });

  it("subtracting several copies subtracts each copy's flat", () => {
    const expected = shift(add(twoD6, negate(repeat(u4, 2))), -2);
    expectDist(roll(2, d6).minus(2, d4.plus(1)).toPMF(), expected);
    expectDist(roll(2, d6).plus(-2, d4.plus(1)).toPMF(), expected);
  });

  it("a negative repeat count negates the flat: roll(-1, d6.plus(2)) is -(d6 + 2)", () => {
    const pmf = roll(-1, d6.plus(2)).toPMF();
    expectDist(pmf, shift(negate(u6), -2));
    expect(pmf.mean()).toBeCloseTo(-11 / 2, 12);
  });

  it("a flat added after the subtraction is still added", () => {
    const pmf = roll(2, d6).minus(roll(1, d4).plus(1)).plus(3).toPMF();
    expect(pmf.mean()).toBeCloseTo(13 / 2, 12);
  });

  it("a check that subtracts a die with its own flat lands at the exact rate", () => {
    const check = d20.plus(5).minus(roll(1, d4).plus(1));
    expect(check.modifier).toBe(4);
    // d20 + 5 - (d4 + 1) >= 15, natural 20 always hits (as a crit), natural 1 always misses.
    const weights = check.ac(15).onHit(d6).resolve().weights;
    expect(weights.hit).toBeCloseTo(13 / 40, 12);
    expect(weights.crit).toBeCloseTo(1 / 20, 12);
  });
});

describe("subtracting a negative roll adds it", () => {
  it("roll(2,d6).minus(roll(-1, 4)) is 2d6 + d4", () => {
    const pmf = roll(2, d6).minus(roll(-1, 4)).toPMF();
    expectDist(pmf, add(twoD6, u4));
    expect(pmf.mean()).toBeCloseTo(19 / 2, 12);
  });

  it("roll(2,d6).minus(roll(-1, d4)) is 2d6 + d4", () => {
    expectDist(roll(2, d6).minus(roll(-1, d4)).toPMF(), add(twoD6, u4));
  });

  it("roll(-2, roll(-1, 4)) is 2d4", () => {
    expectDist(roll(-2, roll(-1, 4)).toPMF(), repeat(u4, 2));
  });
});
