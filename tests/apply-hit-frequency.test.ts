import { describe, expect, it } from "vitest";
import type { Bin } from "../src/index";
import { PMF } from "../src/index";

/** A two-outcome hit distribution with count provenance but no attr yet. */
function hitPMF(): PMF {
  const m = new Map<number, Bin>();
  m.set(5, { p: 0.6, count: { hit: 0.6 } });
  m.set(10, { p: 0.4, count: { crit: 0.4 } });
  return new PMF(m, 1e-15, true);
}

/** A distribution that already carries a miss bin at 0. */
function hitWithMissPMF(): PMF {
  const m = new Map<number, Bin>();
  m.set(0, { p: 0.25, count: { missNone: 0.25 }, attr: {} });
  m.set(8, { p: 0.75, count: { hit: 0.75 } });
  return new PMF(m, 1e-15, true);
}

describe("PMF.missNone", () => {
  it("is a point mass at 0 tagged with the missNone outcome", () => {
    const miss = PMF.missNone();
    expect(miss.mass()).toBeCloseTo(1, 12);
    expect(miss.pAt(0)).toBeCloseTo(1, 12);
    expect(miss.max()).toBe(0);
    expect(miss.outcomeAt(0, "missNone")).toBeCloseTo(1, 12);
  });

  it("uses the missNone label, distinct from PMF.zero's 'miss' label", () => {
    expect(PMF.missNone().outcomeAt(0, "missNone")).toBeCloseTo(1, 12);
    expect(PMF.missNone().outcomeAt(0, "miss")).toBe(0);
    // PMF.zero keeps the builder's 'miss' vocabulary — the two must not collide.
    expect(PMF.zero().outcomeAt(0, "miss")).toBeCloseTo(1, 12);
    expect(PMF.zero().outcomeAt(0, "missNone")).toBe(0);
  });
});

describe("PMF.applyHitFrequency", () => {
  it("preserves total probability mass", () => {
    expect(hitPMF().applyHitFrequency(0.5).mass()).toBeCloseTo(1, 12);
    expect(hitWithMissPMF().applyHitFrequency(0.3).mass()).toBeCloseTo(1, 12);
  });

  it("scales hit bins and moves the freed mass into a missNone bin", () => {
    const out = hitPMF().applyHitFrequency(0.5);
    expect(out.pAt(5)).toBeCloseTo(0.3, 12);
    expect(out.pAt(10)).toBeCloseTo(0.2, 12);
    // pHit was 1, so freed mass is (1 - 0.5) * 1 = 0.5.
    expect(out.pAt(0)).toBeCloseTo(0.5, 12);
    expect(out.outcomeAt(0, "missNone")).toBeCloseTo(0.5, 12);
    // Per-label count on hit bins scales too.
    expect(out.outcomeAt(5, "hit")).toBeCloseTo(0.3, 12);
    expect(out.outcomeAt(10, "crit")).toBeCloseTo(0.2, 12);
  });

  it("adds the freed mass on top of a pre-existing miss bin", () => {
    // pMiss = 0.25, pHit = 0.75, freq 0.4 → newMiss = 0.25 + 0.6 * 0.75 = 0.70
    const out = hitWithMissPMF().applyHitFrequency(0.4);
    expect(out.pAt(0)).toBeCloseTo(0.7, 12);
    expect(out.pAt(8)).toBeCloseTo(0.75 * 0.4, 12);
    expect(out.mass()).toBeCloseTo(1, 12);
  });

  it("scales the mean of a pure-hit PMF by the frequency", () => {
    const base = hitPMF();
    const baseMean = base.mean(); // 0.6*5 + 0.4*10 = 7
    expect(base.applyHitFrequency(0.5).mean()).toBeCloseTo(baseMean * 0.5, 12);
    expect(base.applyHitFrequency(0.25).mean()).toBeCloseTo(baseMean * 0.25, 12);
  });

  it("preserves and scales damage attribution (attr) on hit bins", () => {
    // Regression guard: the app's original applyFrequencyToPMF dropped attr,
    // silently breaking attribution charts for frequency-scaled actions.
    const attributed = hitPMF().withAttribution();
    expect(attributed.outcomeAttributionAt(5, "hit")).toBeCloseTo(5 * 0.6, 12);

    const out = attributed.applyHitFrequency(0.5);
    expect(out.hasAttribution()).toBe(true);
    expect(out.outcomeAttributionAt(5, "hit")).toBeCloseTo(5 * 0.6 * 0.5, 12);
    expect(out.outcomeAttributionAt(10, "crit")).toBeCloseTo(10 * 0.4 * 0.5, 12);
  });

  it("returns the PMF unchanged when frequency >= 1 or non-finite", () => {
    const base = hitPMF();
    expect(base.applyHitFrequency(1)).toBe(base);
    expect(base.applyHitFrequency(1.5)).toBe(base);
    expect(base.applyHitFrequency(Number.NaN)).toBe(base);
  });

  it("collapses all mass into the miss bin when frequency <= 0", () => {
    const out = hitPMF().applyHitFrequency(0);
    expect(out.pAt(0)).toBeCloseTo(1, 12);
    expect(out.mean()).toBeCloseTo(0, 12);
    expect(out.outcomeAt(0, "missNone")).toBeCloseTo(1, 12);
  });
});
