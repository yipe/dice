import { describe, expect, it } from "vitest";
import { d20, d6, d8, roll } from "../src/builder/factory";
import { expectDist, max, min, repeat, shift, uniform } from "./enumerate-dice";

const u6 = uniform(6);
const advantageD6 = max(u6, u6);

describe("a roll type on a group of several dice rolls each die that way", () => {
  it("roll(2,d6).withAdvantage() is two d6, each rolled with advantage", () => {
    const pmf = roll(2, d6).withAdvantage().toPMF();
    expectDist(pmf, repeat(advantageD6, 2));
    expect(pmf.mean()).toBeCloseTo(161 / 18, 12);
  });

  it("matches repeating a single advantaged die", () => {
    expectDist(roll(2, d6.withAdvantage()).toPMF(), repeat(advantageD6, 2));
    expectDist(roll(3, d6).withAdvantage().plus(2).toPMF(), shift(repeat(advantageD6, 3), 2));
  });

  it("applies disadvantage and elven accuracy per die too", () => {
    expectDist(roll(2, d8).withDisadvantage().toPMF(), repeat(min(uniform(8), uniform(8)), 2));
    expectDist(roll(2, d6).withElvenAccuracy().toPMF(), repeat(max(u6, u6, u6), 2));
  });

  it("rolls each d20 of a group with advantage", () => {
    const u20 = uniform(20);
    expectDist(roll(2, d20).withAdvantage().toPMF(), repeat(max(u20, u20), 2));
  });

  it("leaves a single die unchanged", () => {
    expectDist(d6.withAdvantage().toPMF(), advantageD6);
    expectDist(d20.withAdvantage().toPMF(), max(uniform(20), uniform(20)));
  });
});
