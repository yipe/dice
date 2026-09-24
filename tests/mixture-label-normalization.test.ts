import { describe, expect, it } from "vitest";
import { d, roll } from "../src/builder";
import { Mixture, PMF } from "../src/index";

const d8 = () => roll(1, d(8)).toPMF();
const d6 = () => roll(1, d(6)).toPMF();

describe("Mixture labels with arbitrary positive weights", () => {
  it("normalizes label counts by the grand total when weights sum to 4", () => {
    const pmf = Mixture.mix([
      ["hit", d8(), 2],
      ["missNone", PMF.delta(0), 2],
    ]);
    expect(pmf.outcomeProbability("hit")).toBeCloseTo(1 / 2, 15);
    expect(pmf.outcomeProbability("missNone")).toBeCloseTo(1 / 2, 15);
    expect(pmf.query().probAtLeastOne("hit")).toBeCloseTo(1 / 2, 15);
    expect(pmf.query().expectedDamageFrom("hit")).toBeCloseTo(9 / 4, 14);
    // Every bin's labels sum to its probability.
    for (const [, bin] of pmf) {
      const labelled = Object.values(bin.count).reduce((a, b) => (a ?? 0) + (b ?? 0), 0) ?? 0;
      expect(labelled).toBeCloseTo(bin.p, 15);
    }
  });

  it("weights 1/2 and 1/4 give P(hit) 2/3 and P(crit) 1/3", () => {
    const pmf = Mixture.mix([
      ["hit", d8(), 1 / 2],
      ["crit", d6(), 1 / 4],
    ]);
    expect(pmf.outcomeProbability("hit")).toBeCloseTo(2 / 3, 15);
    expect(pmf.outcomeProbability("crit")).toBeCloseTo(1 / 3, 15);
    expect(pmf.pAt(3)).toBeCloseTo((2 / 3) * (1 / 8) + (1 / 3) * (1 / 6), 15);
  });

  it("tiny equal weights still describe a 50/50 mixture", () => {
    const pmf = Mixture.mix([
      ["hit", d8(), 1e-13],
      ["missNone", PMF.delta(0), 1e-13],
    ]);
    expect(pmf.pAt(0)).toBeCloseTo(1 / 2, 15);
    expect(pmf.pAt(8)).toBeCloseTo(1 / 16, 15);
    expect(pmf.outcomeProbability("hit")).toBeCloseTo(1 / 2, 15);
  });

  it("a built PMF does not change when the mixture is added to afterwards", () => {
    const mix = new Mixture<string>()
      .add("hit", d8(), 2)
      .add("crit", d6(), 1)
      .add("missNone", PMF.delta(0), 1);
    const built = mix.buildPMF();
    const before = built.outcomeAt(3, "hit");
    expect(before).toBeCloseTo((2 / 4) * (1 / 8), 15);
    mix.add("hit", d8(), 100);
    expect(built.outcomeAt(3, "hit")).toBe(before);
    expect(built.pAt(3)).toBeCloseTo(5 / 48, 15);
  });

  it("keeps extreme bins of a wide sum instead of pruning them", () => {
    const pmf = Mixture.mix([["hit", roll(20, d(6)).toPMF(), 1]], 0);
    expect(pmf.min()).toBe(20);
    expect(pmf.max()).toBe(120);
    expect(pmf.pAt(120)).toBeCloseTo(6 ** -20, 30);
  });

  it("prunes relative to the normalized mass, independent of the weight scale", () => {
    const small = Mixture.mix([["hit", roll(20, d(6)).toPMF(), 1e-6]]);
    const unit = Mixture.mix([["hit", roll(20, d(6)).toPMF(), 1]]);
    expect(small.support()).toEqual(unit.support());
  });
});

describe("Mixture pruning that leaves nothing", () => {
  it("throws instead of building an empty PMF", () => {
    const m = new Mixture<"hit">(0.5);
    m.add("hit", d6());
    expect(() => m.buildPMF()).toThrow(/removed every outcome/);
  });
});
