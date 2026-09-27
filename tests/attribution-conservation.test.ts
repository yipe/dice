import { describe, expect, it } from "vitest";
import "../src/builder/ac";
import { d20, roll } from "../src/builder/factory";
import { parse } from "../src/parser/parser";
import { PMF } from "../src/pmf/pmf";
import { DiceQuery } from "../src/pmf/query";
import { Turn } from "../src/turn";

/** d20+8 vs AC 16, 1d6+5 — the attack the review measured the bug with. */
const sword = d20.plus(8).ac(16).onHit(roll(1, 6).plus(5));

/** Σ of a chart model's bucket totals, which must equal the PMF's mass. */
const chartMass = (pmf: PMF): number =>
  pmf.damageAttributionChartModel().totals.reduce((a, b) => a + b, 0);

describe("attribution chart conserves mass for convolved PMFs", () => {
  it("convolveMany: Σ bucket totals = mass", () => {
    const conv = PMF.convolveMany([sword.toPMF(), sword.toPMF()]);
    expect(conv.mass()).toBeCloseTo(1, 12);
    expect(chartMass(conv)).toBeCloseTo(1, 12);
  });

  it("Turn.pmf: Σ bucket totals = mass", () => {
    const t = Turn.from({ attacks: [sword, sword] });
    expect(t.pmf.mass()).toBeCloseTo(1, 12);
    expect(chartMass(t.pmf)).toBeCloseTo(1, 12);
  });

  it("provided combined: Σ bucket totals = mass", () => {
    const singles = [sword.toPMF(), sword.toPMF()];
    const q = new DiceQuery(singles, PMF.convolveMany(singles));
    expect(chartMass(q.combinedWithAttribution())).toBeCloseTo(1, 12);
  });

  it("frequency-gated row: Σ bucket totals = mass", () => {
    const gated = sword.toPMF().applyHitFrequency(0.5);
    const singles = [gated, sword.toPMF()];
    const q = new DiceQuery(singles, PMF.convolveMany(singles));
    expect(chartMass(q.combinedWithAttribution())).toBeCloseTo(1, 12);
  });
});

describe("attribution splits damage-bearing bins by damage share", () => {
  it("a guaranteed miss convolved with an always-10 hit attributes the bin entirely to hit", () => {
    // The miss deals 0, so the 10-damage bin is 100% hit and 0% missNone —
    // not the 50/50 count split 0.14.0 produced.
    const miss = PMF.missNone();
    const always10 = d20.alwaysHits().onHit(roll.flat(10)).noCrit();
    const model = new DiceQuery([miss, always10.toPMF()]).damageAttributionChartModel();

    const bin = model.labels.indexOf(10);
    expect(bin).toBeGreaterThanOrEqual(0);
    expect(model.shares.get("hit")![bin]).toBeCloseTo(1, 12);
    expect(model.shares.get("missNone")![bin]).toBe(0);
  });

  it("a crit 11 and a hit 6 that share a 17-damage bin split 11/17 and 6/17", () => {
    // Damage share, not outcome-count share: the crit dealt 11 of the 17 total,
    // the hit 6, so their chart shares are 11/17 and 6/17 (not 50/50).
    const crit11 = d20.alwaysHits().alwaysCrits().onHit(roll.flat(11));
    const hit6 = d20.alwaysHits().onHit(roll.flat(6)).noCrit();
    const model = new DiceQuery([crit11.toPMF(), hit6.toPMF()]).damageAttributionChartModel();

    const bin = model.labels.indexOf(17);
    expect(bin).toBeGreaterThanOrEqual(0);
    expect(model.shares.get("crit")![bin]).toBeCloseTo(11 / 17, 12);
    expect(model.shares.get("hit")![bin]).toBeCloseTo(6 / 17, 12);
  });
});

describe("attribution splits for non-convolved PMFs are unchanged", () => {
  it("single builder PMF keeps its per-value hit/crit/missNone splits", () => {
    const model = sword.toPMF().damageAttributionChartModel();

    expect(model.outcomes).toEqual(["missNone", "hit", "crit"]);

    // Miss at 0 is the full miss mass.
    expect(model.series.get("missNone")![0]).toBeCloseTo(0.35, 12);

    // At 6, only a plain hit lands (0.1), so the whole bin is hit.
    expect(model.series.get("hit")![6]).toBeCloseTo(0.1, 12);
    // At 7, a hit (0.1) and the start of the crit range coexist; a single source
    // splits by damage share, which equals its count weights, so hit keeps its
    // full 0.1.
    expect(model.series.get("hit")![7]).toBeCloseTo(0.1, 12);
    expect(model.series.get("crit")![7]).toBeCloseTo(0.0013888888888888885, 12);
    expect(model.totals[7]).toBeCloseTo(0.1 + 0.0013888888888888885, 12);
  });

  it("single parsed PMF keeps its per-value splits", () => {
    const model = parse("d20+8 AC 16 * (1d6+5)").damageAttributionChartModel();
    expect(model.series.get("hit")![6]).toBeCloseTo(0.1, 12);
    expect(model.series.get("missNone")![0]).toBeCloseTo(0.35, 12);
  });

  it("DiceQuery singles path keeps its per-value splits", () => {
    const model = new DiceQuery([sword.toPMF()]).damageAttributionChartModel();
    expect(model.series.get("hit")![6]).toBeCloseTo(0.1, 12);
    expect(model.series.get("missNone")![0]).toBeCloseTo(0.35, 12);
  });
});
