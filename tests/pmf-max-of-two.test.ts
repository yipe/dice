import { describe, expect, it } from "vitest";
import { d6, roll } from "../src/builder";
import { EPS, PMF } from "../src/index";
import type { Bin } from "../src/common/types";

describe("PMF.maxOfTwo", () => {
  it("O8: matches roll(2,d6).plus(3).keepHighestAll(2,1) bin for bin, not just in the mean", () => {
    const base = roll(2, d6).plus(3);
    const viaMaxOfTwo = base.toPMF().maxOfTwo();
    const viaKeepHighestAll = base.keepHighestAll(2, 1).toPMF();

    // Full-PMF equality, per bin, to the stated tolerance.
    const support = new Set<number>([
      ...viaMaxOfTwo.support(),
      ...viaKeepHighestAll.support(),
    ]);
    for (const damage of support) {
      expect(viaMaxOfTwo.pAt(damage)).toBeCloseTo(
        viaKeepHighestAll.pAt(damage),
        12
      );
    }

    // The pinned mean.
    expect(viaMaxOfTwo.mean()).toBeCloseTo(11.3719135802469, 12);
    expect(viaKeepHighestAll.mean()).toBeCloseTo(11.3719135802469, 12);
  });

  it("preserves outcome labels and attribution, not just mass and mean", () => {
    // Two-outcome PMF with distinct `hit`/`crit` provenance at each damage
    // value, mass already normalized to 1.
    const m = new Map<number, Bin>();
    m.set(1, { p: 0.5, count: { hit: 0.3, crit: 0.2 }, attr: { hit: 0.3, crit: 0.4 } });
    m.set(2, { p: 0.5, count: { hit: 0.5 }, attr: { hit: 1.0 } });
    const pmf = new PMF(m, EPS, true);

    const result = pmf.maxOfTwo();

    // mass(): total mass is preserved exactly (1 in, 1 out).
    expect(result.mass()).toBeCloseTo(1, 12);

    // outcomes(): both labels the original PMF carried must still be present
    // — a naive PMF.fromMap rebuild would drop them entirely (count: {}).
    expect(result.outcomes().sort()).toEqual(["crit", "hit"]);

    // mean(): P(max=1) = 0.25 (both draws land on 1), P(max=2) = 0.75.
    // E[max] = 1*0.25 + 2*0.75 = 1.75.
    expect(result.mean()).toBeCloseTo(1.75, 12);

    // Per-bin provenance: the winning value's original count/attr PROPORTIONS
    // survive, only the bin's mass is rescaled.
    // Bin 1: original count {hit:0.3, crit:0.2} summed to p=0.5; new p=0.25,
    // so the factor is 0.5 and every label scales by the same factor.
    expect(result.pAt(1)).toBeCloseTo(0.25, 12);
    expect(result.outcomeAt(1, "hit")).toBeCloseTo(0.15, 12);
    expect(result.outcomeAt(1, "crit")).toBeCloseTo(0.1, 12);
    expect(result.outcomeAttributionAt(1, "hit")).toBeCloseTo(0.15, 12);
    expect(result.outcomeAttributionAt(1, "crit")).toBeCloseTo(0.2, 12);

    // Bin 2: original count {hit:0.5} summed to p=0.5; new p=0.75, factor 1.5.
    expect(result.pAt(2)).toBeCloseTo(0.75, 12);
    expect(result.outcomeAt(2, "hit")).toBeCloseTo(0.75, 12);
    expect(result.outcomeAttributionAt(2, "hit")).toBeCloseTo(1.5, 12);

    // Per bin, count sums to that bin's p exactly (the invariant every real
    // production PMF — e.g. the parser's toPMF — maintains), confirming the
    // labels were rescaled consistently rather than orphaned from `p`.
    expect(
      Object.values(result.binAt(1)!.count).reduce((a, b) => a + b, 0)
    ).toBeCloseTo(result.pAt(1), 12);
    expect(
      Object.values(result.binAt(2)!.count).reduce((a, b) => a + b, 0)
    ).toBeCloseTo(result.pAt(2), 12);
  });

  it("restores the ORIGINAL (possibly non-unit) mass, not 1 — e.g. a filterOutcome-style slice", () => {
    // Same shape as above but scaled to a fractional total mass of 0.4, the
    // way a conditional hit/crit slice carries less than unit mass.
    const m = new Map<number, Bin>();
    m.set(1, { p: 0.2, count: { hit: 0.12, crit: 0.08 } });
    m.set(2, { p: 0.2, count: { hit: 0.2 } });
    const slice = new PMF(m, EPS, false);
    expect(slice.mass()).toBeCloseTo(0.4, 12);

    const result = slice.maxOfTwo();

    // Total mass is the ORIGINAL 0.4, not renormalized to 1.
    expect(result.mass()).toBeCloseTo(0.4, 12);

    // The underlying (normalized) shape is identical to the unit-mass case,
    // just uniformly scaled by 0.4: P(max=1) = 0.25*0.4, P(max=2) = 0.75*0.4.
    expect(result.pAt(1)).toBeCloseTo(0.1, 12);
    expect(result.pAt(2)).toBeCloseTo(0.3, 12);
    expect(result.outcomes().sort()).toEqual(["crit", "hit"]);
  });
});
