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

describe("attribution splits for non-convolved PMFs are unchanged", () => {
  it("single builder PMF keeps its per-value hit/crit/missNone splits", () => {
    const model = sword.toPMF().damageAttributionChartModel();

    expect(model.outcomes).toEqual(["missNone", "hit", "crit"]);

    // Miss at 0 is the full miss mass.
    expect(model.series.get("missNone")![0]).toBeCloseTo(0.35, 12);

    // At 6, only a plain hit lands (0.1), so the whole bin is hit.
    expect(model.series.get("hit")![6]).toBeCloseTo(0.1, 12);
    // At 7, a hit (0.1) and the start of the crit range coexist; the split is by
    // the bin's own count weights, so hit keeps its full 0.1.
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
