import { describe, expect, it } from "vitest";
import type { Bin } from "../src/index";
import { DiceQuery, PMF } from "../src/index";

/** Attributed attack: clean miss at 0, plain hit at 5, hit+crit mix at 8. */
const attributedAttack = (): PMF =>
  new PMF(
    new Map<number, Bin>([
      [0, { p: 0.3, count: { missNone: 0.3 } }],
      [5, { p: 0.5, count: { hit: 0.5 } }],
      [8, { p: 0.2, count: { hit: 0.15, crit: 0.05 } }],
    ]),
    1e-15,
    true
  ).withAttribution();

describe("PMF.damageAttributionChartModel", () => {
  it("splits an attributed distribution into dense per-outcome series", () => {
    const model = attributedAttack().damageAttributionChartModel();

    // Dense support 0..8, no binning.
    expect(model.labels).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(model.binRanges).toBeUndefined();

    // Discovered outcomes in canonical stack order.
    expect(model.outcomes).toEqual(["missNone", "hit", "crit"]);

    // Bar-height masses land at the right damage values.
    expect(model.series.get("missNone")![0]).toBeCloseTo(0.3, 12);
    expect(model.series.get("hit")![5]).toBeCloseTo(0.5, 12);
    // At 8: attr hit = 8*0.15 = 1.2, crit = 8*0.05 = 0.4 → share 0.75 / 0.25 of p=0.2.
    expect(model.series.get("hit")![8]).toBeCloseTo(0.15, 12);
    expect(model.series.get("crit")![8]).toBeCloseTo(0.05, 12);

    // Totals recover p per value.
    expect(model.totals[0]).toBeCloseTo(0.3, 12);
    expect(model.totals[5]).toBeCloseTo(0.5, 12);
    expect(model.totals[8]).toBeCloseTo(0.2, 12);

    // Conditional shares sum to ~1 within a non-empty bucket.
    expect(model.shares.get("hit")![8]).toBeCloseTo(0.75, 12);
    expect(model.shares.get("crit")![8]).toBeCloseTo(0.25, 12);
    expect(model.shares.get("missNone")![0]).toBeCloseTo(1, 12);

    expect(model.mean).toBeCloseTo(4.1, 12);
    // Reversed-convention CCDF markers (p80 is the low-damage end).
    expect(model.percentiles).toEqual({ p80: 0, p50: 5, p20: 5 });
  });

  it("returns totals only for a pure (unattributed) distribution", () => {
    const m = new Map<number, Bin>();
    for (let d = 1; d <= 6; d++) m.set(d, { p: 1 / 6, count: {} });
    const pure = new PMF(m, 1e-15, true);

    const model = pure.damageAttributionChartModel();

    expect(model.outcomes).toEqual([]);
    expect(model.series.size).toBe(0);
    expect(model.shares.size).toBe(0);
    expect(model.labels).toEqual([1, 2, 3, 4, 5, 6]);
    for (const t of model.totals) expect(t).toBeCloseTo(1 / 6, 12);
    expect(model.mean).toBeCloseTo(3.5, 12);
  });

  it("coarsens a wide distribution and preserves mass, keeping sub-binSize hits out of the miss credit", () => {
    // Miss at 0; hit mass spread thinly across 1..1000.
    const m = new Map<number, Bin>([[0, { p: 0.2, count: { missNone: 0.2 } }]]);
    for (let d = 1; d <= 1000; d++) m.set(d, { p: 0.8 / 1000, count: { hit: 0.8 / 1000 } });
    const wide = new PMF(m, 1e-15, true).withAttribution();

    const model = wide.damageAttributionChartModel({ maxBuckets: 100 });

    // range 1000 > 100 ⇒ binned. binSize = ceil(1001/100) = 11.
    expect(model.binRanges).toBeDefined();
    expect(model.binRanges!.length).toBe(model.labels.length);
    expect(model.binRanges![0]).toEqual({ start: 0, end: 10 });
    expect(model.labels[1]).toBe(11);

    // Total mass is preserved end to end.
    const totalMass = model.totals.reduce((a, b) => a + b, 0);
    expect(totalMass).toBeCloseTo(1, 10);

    // Bucket 0 = [0..10] carries BOTH the miss and the sub-binSize hits (the
    // split-first ordering; rebin-first would have dropped the hit credit here).
    expect(model.series.get("missNone")![0]).toBeCloseTo(0.2, 12);
    expect(model.series.get("hit")![0]).toBeGreaterThan(0);
    expect(model.series.get("hit")![0]).toBeCloseTo((0.8 / 1000) * 10, 10);

    // No hit mass is lost across binning.
    const hitMass = model.series.get("hit")!.reduce((a, b) => a + b, 0);
    expect(hitMass).toBeCloseTo(0.8, 10);
  });

  it("respects a custom stack order", () => {
    const model = attributedAttack().damageAttributionChartModel({
      stackOrder: ["crit", "hit", "missNone"],
    });
    expect(model.outcomes).toEqual(["crit", "hit", "missNone"]);
  });

  it("zeroes shares for buckets under the epsilon floor but keeps series intact", () => {
    // A large epsilon forces every bucket total below the floor.
    const model = attributedAttack().damageAttributionChartModel({ epsilon: 1 });
    for (const arr of model.shares.values())
      for (const s of arr) expect(s).toBe(0);
    // Series (bar heights) are unaffected by the shares guard.
    expect(model.series.get("hit")![5]).toBeCloseTo(0.5, 12);
  });

  it("returns an empty model for an empty PMF", () => {
    const model = PMF.empty().damageAttributionChartModel();
    expect(model.labels).toEqual([]);
    expect(model.outcomes).toEqual([]);
    expect(model.totals).toEqual([]);
    expect(model.series.size).toBe(0);
    expect(model.shares.size).toBe(0);
    expect(model.mean).toBe(0);
    expect(model.percentiles).toEqual({ p80: 0, p50: 0, p20: 0 });
  });
});

describe("DiceQuery.damageAttributionChartModel", () => {
  it("delegates to the combined attributed PMF", () => {
    const q = new DiceQuery([attributedAttack()]);
    const model = q.damageAttributionChartModel();
    expect(model.outcomes).toEqual(["missNone", "hit", "crit"]);
    expect(model.series.get("hit")![5]).toBeCloseTo(0.5, 12);
  });
});
