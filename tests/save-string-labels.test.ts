import { describe, expect, it } from "vitest";
import "../src/builder/dc";
import { d20, d6, roll } from "../src/builder/factory";
import { parse } from "../src/parser/parser";
import type { PMF } from "../src/pmf/pmf";

/**
 * A parsed saving throw labels its outcomes like the builder's: a failed save is `saveFail`
 * whatever the payload rolls (0 included), a save with `save half` is `saveHalf`, and a save
 * with no clause takes no damage (`missNone`).
 */

function expectSameLabels(parsed: PMF, built: PMF): void {
  for (const label of ["saveFail", "saveHalf", "missNone", "hit"] as const) {
    expect(parsed.outcomeProbability(label), label).toBeCloseTo(built.outcomeProbability(label), 12);
    const a = parsed.filterOutcome(label);
    const b = built.filterOutcome(label);
    for (const value of new Set([...a.support(), ...b.support()])) {
      expect(Math.abs(a.pAt(value) - b.pAt(value)), `${label} bin ${value}`).toBeLessThanOrEqual(1e-12);
    }
  }
}

describe("a parsed save labels a failure saveFail", () => {
  it("(d20 + 5 DC 15) * (3d6): fail 9/20 as saveFail, success 11/20 as missNone, no hit", () => {
    const pmf = parse("(d20 + 5 DC 15) * (3d6)");
    expect(pmf.outcomeProbability("saveFail")).toBeCloseTo(9 / 20, 12);
    expect(pmf.outcomeProbability("missNone")).toBeCloseTo(11 / 20, 12);
    expect(pmf.outcomeProbability("hit")).toBe(0);
    expectSameLabels(pmf, d20.plus(5).dc(15).onSaveFailure(roll(3, d6)).toPMF());
  });

  it("a failed save whose payload rolls 0 is still saveFail: (d20 DC 15) * (1d6 - 1)", () => {
    const pmf = parse("(d20 DC 15) * (1d6 - 1)");
    const zero = pmf.binAt(0)!;
    expect(zero.count.saveFail).toBeCloseTo((14 / 20) * (1 / 6), 12);
    expect(zero.count.missNone).toBeCloseTo(6 / 20, 12);
    expectSameLabels(pmf, d20.dc(15).onSaveFailure(roll(1, d6).minus(1)).toPMF());
  });

  it("with save half the 0 bin carries its saveFail share: (d20 - 1 DC 9) * (3d12 - 4) save half", () => {
    const zero = parse("(d20 - 1 DC 9) * (3d12 - 4) save half").binAt(0)!;
    // Fail (natural <= 9, 9/20) and 3d12 = 4 (3/1728): 1/1280.
    expect(zero.count.saveFail).toBeCloseTo(1 / 1280, 15);
    const labelled = Object.values(zero.count).reduce((total, share) => total + (share ?? 0), 0);
    expect(labelled).toBeCloseTo(zero.p, 15);
  });

  it("save half with a zero-able payload matches the builder label by label", () => {
    expectSameLabels(
      parse("(d20 DC 15) * (1d6 - 1) save half"),
      d20.dc(15).onSaveFailure(roll(1, d6).minus(1)).saveHalf().toPMF()
    );
  });

  it("a trailing term keeps the save's labels", () => {
    const pmf = parse("(d20 + 5 DC 15) * (3d6) + 2");
    expect(pmf.outcomeProbability("saveFail")).toBeCloseTo(9 / 20, 12);
    expect(pmf.filterOutcome("saveFail").min()).toBe(5);
  });
});
