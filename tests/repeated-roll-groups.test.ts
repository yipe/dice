import { describe, expect, it } from "vitest";
import { d6, d8, roll } from "../src/builder/factory";
import { add, expectDist, keep, max, min, negate, repeat, shift, uniform } from "./enumerate-dice";

const u6 = uniform(6);
const bestOfTwoD6 = max(u6, u6);
/** A d6 that may explode once: a 6 adds one more d6. */
const d6ExplodeOnce = new Map<number, number>([
  ...[1, 2, 3, 4, 5].map((v): [number, number] => [v, 1 / 6]),
  ...[1, 2, 3, 4, 5, 6].map((v): [number, number] => [6 + v, 1 / 36]),
]);

describe("roll(N, X) is N independent copies of X", () => {
  it("copies a best-of-two die", () => {
    const two = roll(2, d6.keepHighest(2, 1)).toPMF();
    expectDist(two, repeat(bestOfTwoD6, 2));
    expect(two.mean()).toBeCloseTo(161 / 18, 12);
    const three = roll(3, d6.keepHighest(2, 1)).toPMF();
    expectDist(three, repeat(bestOfTwoD6, 3));
    expect(three.mean()).toBeCloseTo(161 / 12, 12);
  });

  it("copies keep-2-of-3 and worst-of-two dice", () => {
    expectDist(roll(2, d6.keepHighest(3, 2)).toPMF(), repeat(keep(u6, 3, 2, true), 2));
    const worst = roll(2, d8.keepLowest(2, 1)).toPMF();
    expectDist(worst, repeat(min(uniform(8), uniform(8)), 2));
    expect(worst.mean()).toBeCloseTo(51 / 8, 12);
  });

  it("copies bestOf(1) of one die, which is just that die", () => {
    expectDist(roll(3, d6.bestOf(1)).toPMF(), repeat(u6, 3));
  });

  it("gives each copy its own pool-wide explosion budget", () => {
    const pmf = roll(2, d6.explodePool(1)).toPMF();
    expectDist(pmf, repeat(d6ExplodeOnce, 2));
    expect(pmf.mean()).toBeCloseTo(49 / 6, 12);
  });

  it("copies the flat modifier of each copy", () => {
    expectDist(roll(2, d6.keepHighest(2, 1).plus(1)).toPMF(), shift(repeat(bestOfTwoD6, 2), 2));
  });

  it("adds and subtracts copies with plus(n, X) and minus(n, X)", () => {
    expectDist(d8.plus(2, d6.keepHighest(2, 1)).toPMF(), add(uniform(8), repeat(bestOfTwoD6, 2)));
    expectDist(d8.minus(2, d6.keepHighest(2, 1)).toPMF(), add(uniform(8), negate(repeat(bestOfTwoD6, 2))));
    expectDist(roll(-2, d6.keepHighest(2, 1)).toPMF(), negate(repeat(bestOfTwoD6, 2)));
  });
});

describe("a fractional repeat count", () => {
  it("rolls its whole copies, like a fractional die count rolls its whole dice", () => {
    expectDist(roll(2.5, d6.keepHighest(2, 1)).toPMF(), repeat(bestOfTwoD6, 2));
    expectDist(roll(2.5, d6).toPMF(), repeat(u6, 2));
  });
});
