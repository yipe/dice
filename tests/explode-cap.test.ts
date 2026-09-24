import { describe, expect, it } from "vitest";
import { d6, d8, roll } from "../src/builder/factory";
import { RollBuilder } from "../src/builder/roll";
import { expectDist, point } from "./enumerate-dice";

describe("explode() needs a finite cap", () => {
  it("refuses a call with no cap", () => {
    // @ts-expect-error -- the cap is required; a JavaScript caller that omits it gets a clear error
    expect(() => d6.explode()).toThrow(/explicit cap/);
  });

  it.each([Infinity, -Infinity])("refuses explode(%s)", (cap) => {
    expect(() => d8.explode(cap)).toThrow(/finite/);
  });

  it("refuses a hand-built config carrying a non-finite explode", () => {
    expect(() => RollBuilder.fromConfig({ sides: 6, explode: Infinity }).toPMF()).toThrow(/finite/);
  });
});

describe("an exploding die whose every face is its highest", () => {
  it("d6.minimum(6).explode(k) always explodes k times", () => {
    expectDist(d6.minimum(6).explode(1).toPMF(), point(12));
    expectDist(d6.minimum(6).explode(2).toPMF(), point(18));
    expectDist(roll(2, d6).minimum(6).explode(3).toPMF(), point(48));
  });

  it("a one-sided die explodes every time", () => {
    expectDist(roll(1, 1).explode(3).toPMF(), point(4));
  });

  it("a floor above the highest face never explodes", () => {
    expectDist(d6.minimum(7).explode(2).toPMF(), point(7));
  });
});
