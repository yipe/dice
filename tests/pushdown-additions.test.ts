import { describe, expect, it } from "vitest";
import type { Bin } from "../src/index";
import {
  ALL_OUTCOME_TYPES,
  DiceQuery,
  OUTCOME_DISPLAY_ORDER,
  PMF,
  critProbability,
  sortOutcomes,
} from "../src/index";

describe("critProbability", () => {
  it("scales the crit window by roll type", () => {
    expect(critProbability(1, "flat")).toBeCloseTo(0.05, 12);
    expect(critProbability(1, "advantage")).toBeCloseTo(1 - 0.95 ** 2, 12);
    expect(critProbability(1, "elven accuracy")).toBeCloseTo(1 - 0.95 ** 3, 12);
    expect(critProbability(1, "disadvantage")).toBeCloseTo(0.05 ** 2, 12);
    expect(critProbability(2, "flat")).toBeCloseTo(0.1, 12);
    expect(critProbability(1)).toBeCloseTo(0.05, 12); // defaults to flat
  });
});

describe("canonical outcome constants", () => {
  it("enumerate every outcome type once", () => {
    expect([...ALL_OUTCOME_TYPES].sort()).toEqual(
      ["crit", "hit", "missDamage", "missNone", "pc", "saveFail", "saveHalf"].sort()
    );
    expect([...OUTCOME_DISPLAY_ORDER].sort()).toEqual([...ALL_OUTCOME_TYPES].sort());
  });

  it("sortOutcomes ranks known outcomes by order, unknown ones last alphabetically", () => {
    expect(sortOutcomes(["crit", "missNone", "hit"])).toEqual(["missNone", "hit", "crit"]);
    expect(sortOutcomes(["zeta", "hit", "alpha"])).toEqual(["hit", "alpha", "zeta"]);
    expect(sortOutcomes(["crit", "hit"], OUTCOME_DISPLAY_ORDER)).toEqual(["crit", "hit"]);
  });
});

describe("PMF.hitProbability / missProbability", () => {
  it("split around the damage-0 miss bin", () => {
    const pmf = new PMF(
      new Map<number, Bin>([
        [0, { p: 0.3, count: { missNone: 0.3 } }],
        [5, { p: 0.7, count: { hit: 0.7 } }],
      ]),
      1e-15,
      true
    );
    expect(pmf.missProbability()).toBeCloseTo(0.3, 12);
    expect(pmf.hitProbability()).toBeCloseTo(0.7, 12);
  });
});

describe("PMF.rebin", () => {
  it("returns the same PMF when support already fits", () => {
    const pmf = PMF.delta(5);
    expect(pmf.rebin(500)).toBe(pmf);
  });

  it("coarsens a wide distribution, preserving total mass", () => {
    const m = new Map<number, Bin>();
    for (let d = 0; d <= 1000; d++) m.set(d, { p: 1 / 1001, count: { hit: 1 / 1001 } });
    const wide = new PMF(m, 1e-15, true);
    const rebinned = wide.rebin(100);
    expect(rebinned.map.size).toBeLessThanOrEqual(100);
    expect(rebinned.mass()).toBeCloseTo(1, 10);
    // count provenance is aggregated, not dropped.
    let totalHit = 0;
    for (const [, bin] of rebinned) totalHit += (bin.count.hit as number) ?? 0;
    expect(totalHit).toBeCloseTo(1, 10);
  });
});

describe("PMF.attributionByValue", () => {
  it("splits each value's mass by attribution; sums recover p", () => {
    const pmf = new PMF(
      new Map<number, Bin>([
        [0, { p: 0.3, count: { missNone: 0.3 } }],
        [5, { p: 0.5, count: { hit: 0.5 } }],
        [8, { p: 0.2, count: { hit: 0.15, crit: 0.05 } }],
      ]),
      1e-15,
      true
    ).withAttribution();

    const series = pmf.attributionByValue();
    expect(series.get("missNone")?.get(0)).toBeCloseTo(0.3, 12);
    expect(series.get("hit")?.get(5)).toBeCloseTo(0.5, 12);
    // At 8: attr hit = 8*0.15 = 1.2, crit = 8*0.05 = 0.4, total 1.6.
    expect(series.get("hit")?.get(8)).toBeCloseTo((1.2 / 1.6) * 0.2, 12);
    expect(series.get("crit")?.get(8)).toBeCloseTo((0.4 / 1.6) * 0.2, 12);

    // Per-value sums across labels recover p.
    for (const value of [0, 5, 8]) {
      let sum = 0;
      for (const [, byValue] of series) sum += byValue.get(value) ?? 0;
      expect(sum).toBeCloseTo(pmf.pAt(value), 12);
    }
  });

  it("works on builder PMFs (count only) via on-demand attribution", () => {
    const pmf = new PMF(
      new Map<number, Bin>([
        [0, { p: 0.4, count: { missNone: 0.4 } }],
        [6, { p: 0.6, count: { hit: 0.6 } }],
      ]),
      1e-15,
      true
    );
    const series = pmf.attributionByValue();
    expect(series.get("missNone")?.get(0)).toBeCloseTo(0.4, 12);
    expect(series.get("hit")?.get(6)).toBeCloseTo(0.6, 12);
  });
});

describe("DiceQuery.countSinglesWith / attributionByValue", () => {
  const withOutcome = (value: number, label: string): PMF =>
    new PMF(
      new Map<number, Bin>([
        [0, { p: 0.5, count: { missNone: 0.5 } }],
        [value, { p: 0.5, count: { [label]: 0.5 } }],
      ]),
      1e-15,
      true
    );

  it("counts how many singles can produce a label", () => {
    const q = new DiceQuery([withOutcome(5, "hit"), withOutcome(10, "crit"), withOutcome(6, "hit")]);
    expect(q.countSinglesWith("hit")).toBe(2);
    expect(q.countSinglesWith("crit")).toBe(1);
    expect(q.countSinglesWith("saveFail")).toBe(0);
  });

  it("attributionByValue delegates to the combined attributed PMF", () => {
    const q = new DiceQuery([withOutcome(5, "hit")]);
    const series = q.attributionByValue();
    expect(series.has("hit")).toBe(true);
    expect(series.has("missNone")).toBe(true);
  });
});
