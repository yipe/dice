import { describe, expect, it } from "vitest";
import { d20, d4, d6, hd20, roll } from "../src/builder";

/**
 * A save check's PMF puts a success at 0 and a failure at 1, on `DCBuilder.toPMF()` and on
 * `SaveBuilder.resolve().check` alike. A certain success or failure has no mass on the other side.
 */

describe("a save's check PMF marks a failure at 1", () => {
  it("resolve().check matches the DC check's own PMF", () => {
    // d20 + 3 >= 15 on 12..20: success 9/20, failure 11/20.
    const check = d20.plus(3).dc(15);
    const res = check.onSaveFailure(roll(2, d6)).saveHalf().resolve(0);
    expect(res.check.pAt(0)).toBeCloseTo(9 / 20, 15);
    expect(res.check.pAt(1)).toBeCloseTo(11 / 20, 15);
    expect(check.toPMF().pAt(0)).toBeCloseTo(9 / 20, 15);
    expect(check.toPMF().pAt(1)).toBeCloseTo(11 / 20, 15);
    expect(res.check.hitProbability()).toBeCloseTo(check.toPMF().hitProbability(), 15);
  });
});

describe("a certain save outcome leaves no mass on the other side", () => {
  // Every face of the natural roll, with and without bonus dice and rerolls, clears or misses the DC.
  const certainSuccess = [
    d20.plus(15).dc(10),
    hd20.plus(20).dc(12),
    d20.withAdvantage().plus(d4).plus(9).dc(10),
    d20.withDisadvantage().plus(12).dc(13),
  ];
  const certainFailure = [d20.minus(5).dc(16), hd20.withAdvantage().plus(d4).minus(10).dc(15)];

  it("a certain success has exactly one bin", () => {
    for (const check of certainSuccess) {
      expect([...check.toPMF().support()]).toEqual([0]);
      const res = check.onSaveFailure(roll(2, d6)).saveHalf().resolve(0);
      expect(res.weights.fail).toBe(0);
      expect(res.pmf.outcomeProbability("saveFail")).toBe(0);
      expect([...res.check.support()]).toEqual([0]);
    }
  });

  it("a certain failure has exactly one bin", () => {
    for (const check of certainFailure) {
      expect([...check.toPMF().support()]).toEqual([1]);
      const res = check.onSaveFailure(roll(2, d6)).saveHalf().resolve(0);
      expect(res.weights.success).toBe(0);
      expect(res.pmf.outcomeProbability("saveHalf")).toBe(0);
    }
  });
});
