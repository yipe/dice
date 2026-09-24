import { describe, expect, it } from "vitest";
import type { Bin } from "../src/index";
import { PMF } from "../src/index";

function pmfOf(bins: Array<[number, Bin]>): PMF {
  return new PMF(new Map(bins), 0);
}

describe("applyHitFrequency is Bernoulli thinning f·X + (1 − f)·δ0", () => {
  it("keeps the mass of a sub-unit slice", () => {
    const slice = pmfOf([
      [5, { p: 1 / 4, count: { hit: 1 / 4 } }],
      [9, { p: 1 / 4, count: { hit: 1 / 4 } }],
    ]);
    const out = slice.applyHitFrequency(1 / 2);
    expect(out.mass()).toBeCloseTo(1 / 2, 15);
    expect(out.pAt(0)).toBeCloseTo(1 / 4, 15);
    expect(out.pAt(5)).toBeCloseTo(1 / 8, 15);
    expect(out.pAt(9)).toBeCloseTo(1 / 8, 15);
    expect(out.outcomeAt(0, "missNone")).toBeCloseTo(1 / 4, 15);
  });

  it("thins negative-damage bins instead of dropping them", () => {
    const x = pmfOf([
      [-4, { p: 1 / 5, count: {} }],
      [0, { p: 3 / 10, count: {} }],
      [6, { p: 1 / 2, count: {} }],
    ]);
    const out = x.applyHitFrequency(1 / 2);
    expect(out.pAt(-4)).toBeCloseTo(1 / 10, 15);
    expect(out.pAt(0)).toBeCloseTo(13 / 20, 15);
    expect(out.pAt(6)).toBeCloseTo(1 / 4, 15);
    expect(out.mass()).toBeCloseTo(1, 15);
    expect(out.mean()).toBeCloseTo(11 / 10, 15);
  });

  it("keeps the f-share of a zero-damage hit under its own label", () => {
    const x = pmfOf([
      [0, { p: 1 / 4, count: { hit: 1 / 8, missNone: 1 / 8 } }],
      [3, { p: 3 / 4, count: { hit: 3 / 4 } }],
    ]);
    const out = x.applyHitFrequency(1 / 2);
    expect(out.pAt(0)).toBeCloseTo(5 / 8, 15);
    expect(out.outcomeAt(0, "hit")).toBeCloseTo(1 / 16, 15);
    expect(out.outcomeAt(0, "missNone")).toBeCloseTo(9 / 16, 15);
    expect(out.outcomeAt(3, "hit")).toBeCloseTo(3 / 8, 15);
    expect(out.outcomeProbability("hit")).toBeCloseTo((1 / 2) * (7 / 8), 15);
  });

  it("frequency 0 leaves only the zero bin", () => {
    const x = pmfOf([
      [0, { p: 1 / 2, count: { missNone: 1 / 2 } }],
      [5, { p: 1 / 2, count: { hit: 1 / 2 } }],
    ]);
    const out = x.applyHitFrequency(0);
    expect(out.support()).toEqual([0]);
    expect(out.max()).toBe(0);
    expect(out.pAt(0)).toBe(1);
    expect(out.outcomeAt(0, "missNone")).toBe(1);
    expect(out.outcomeAt(0, "hit")).toBe(0);
  });

  it("equals the explicit mixture on a labelled, non-unit, signed distribution", () => {
    const x = pmfOf([
      [-2, { p: 1 / 10, count: { missDamage: 1 / 10 } }],
      [0, { p: 1 / 5, count: { missNone: 1 / 5 } }],
      [4, { p: 3 / 10, count: { hit: 1 / 5, crit: 1 / 10 } }],
    ]);
    const f = 2 / 3;
    const out = x.applyHitFrequency(f);
    const mass = 3 / 5;
    expect(out.mass()).toBeCloseTo(mass, 15);
    expect(out.pAt(-2)).toBeCloseTo(f / 10, 15);
    expect(out.pAt(4)).toBeCloseTo((f * 3) / 10, 15);
    expect(out.pAt(0)).toBeCloseTo(f / 5 + (1 - f) * mass, 15);
    expect(out.outcomeAt(0, "missNone")).toBeCloseTo(f / 5 + (1 - f) * mass, 15);
    expect(out.outcomeAt(4, "crit")).toBeCloseTo(f / 10, 15);
    expect(out.outcomeAt(-2, "missDamage")).toBeCloseTo(f / 10, 15);
  });
});
