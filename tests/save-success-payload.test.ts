import { beforeEach, describe, expect, it } from "vitest";
import { d, d20, d4, d6, roll, SaveBuilder, turn } from "../src/builder";
import { clearDCCache } from "../src/builder/dc";
import type { DCBuilder } from "../src/builder/dc";
import { clearRollCache, type RollBuilder } from "../src/builder/roll";
import { clearSaveCache } from "../src/builder/save";
import { parse } from "../src/parser/parser";
import type { PMF } from "../src/pmf/pmf";

/**
 * `onSaveSuccess(payload)`: a success deals a payload of its own, where `saveHalf()` fixes it at
 * `floor(failure / 2)`. The check is d20 + 5 against DC 15: a target saves on a 10 or better, 11/20, and fails
 * 9/20. A failure deals 2d6; the weights of a 2d6 sum s are `ways(s) / 36`.
 */
const P_SUCCESS = 11 / 20;
const P_FAIL = 9 / 20;
const WAYS_2D6 = [0, 0, 1, 2, 3, 4, 5, 6, 5, 4, 3, 2, 1];

const check = () => d20.plus(5).dc(15);
const failure = () => roll(2, d6);

/** A PMF's bins as plain data in support order, so `toEqual` sees every mass and label. */
function bins(pmf: PMF): Array<[number, number, Record<string, number | undefined>]> {
  return [...pmf].sort(([a], [b]) => a - b).map(([value, bin]) => [value, bin.p, { ...bin.count }]);
}

describe("a success that deals its own payload", () => {
  const save = check().onSaveFailure(failure()).onSaveSuccess(d4);

  it("mixes the payload at P(success) and the failure at P(fail), bin by bin and label by label", () => {
    const { pmf } = save.resolve();
    for (let value = 0; value <= 12; value++) {
      const half = value >= 1 && value <= 4 ? P_SUCCESS / 4 : 0;
      const fail = (P_FAIL * WAYS_2D6[value]) / 36 || 0;
      const bin = pmf.binAt(value);
      expect(bin?.p ?? 0, `p@${value}`).toBeCloseTo(half + fail, 12);
      expect(bin?.count.saveHalf ?? 0, `saveHalf@${value}`).toBeCloseTo(half, 12);
      expect(bin?.count.saveFail ?? 0, `saveFail@${value}`).toBeCloseTo(fail, 12);
      expect(bin?.count.missNone ?? 0, `missNone@${value}`).toBe(0);
    }
    expect(pmf.mean()).toBeCloseTo(P_SUCCESS * 2.5 + P_FAIL * 7, 12);
  });

  it("reports the resolution the way a saveHalf() save does: check, weights, both payloads", () => {
    const res = save.resolve();
    expect(res.weights.success).toBeCloseTo(P_SUCCESS, 12);
    expect(res.weights.fail).toBeCloseTo(P_FAIL, 12);
    expect(res.saveFail.mean()).toBeCloseTo(7, 12);
    expect(res.saveSuccess.mean()).toBeCloseTo(2.5, 12);
    expect(bins(res.saveSuccess)).toEqual(bins(d4.toPMF()));
    const control = check().onSaveFailure(failure()).saveHalf().resolve();
    expect(bins(res.check)).toEqual(bins(control.check));
    expect(bins(res.saveFail)).toEqual(bins(control.saveFail));
    expect(res.pmf.outcomes().sort()).toEqual(["saveFail", "saveHalf"]);
  });

  it("labels the success saveHalf whatever it deals, a flat 0 included (not the plain save's missNone)", () => {
    const zero = check().onSaveFailure(failure()).onSaveSuccess(0).resolve().pmf;
    expect(zero.outcomeProbability("saveHalf")).toBeCloseTo(P_SUCCESS, 12);
    expect(zero.outcomeProbability("missNone")).toBe(0);
    expect(zero.binAt(0)?.count.saveHalf).toBeCloseTo(P_SUCCESS, 12);
    const plain = check().onSaveFailure(failure()).resolve().pmf;
    expect(plain.outcomeProbability("missNone")).toBeCloseTo(P_SUCCESS, 12);
    expect(plain.outcomeProbability("saveHalf")).toBe(0);
    // Same damage either way: only the label differs.
    expect(zero.mean()).toBeCloseTo(plain.mean(), 12);
  });

  it("takes a number as a flat payload, negative included", () => {
    const three = check().onSaveFailure(failure()).onSaveSuccess(3).resolve();
    expect(three.saveSuccess.pAt(3)).toBe(1);
    expect(three.pmf.pAt(3)).toBeCloseTo(P_SUCCESS + (P_FAIL * WAYS_2D6[3]) / 36, 12);
    const negative = check().onSaveFailure(failure()).onSaveSuccess(-2).resolve();
    expect(negative.saveSuccess.pAt(-2)).toBe(1);
    expect(negative.pmf.pAt(-2)).toBeCloseTo(P_SUCCESS, 12);
  });

  it("reads a parsed string payload the way onSaveFailure reads one", () => {
    const parsed = check().onSaveFailure(failure()).onSaveSuccess(d("1d4")).resolve();
    expect(bins(parsed.pmf)).toEqual(bins(save.resolve().pmf));
    // A parsed payload keeps its own `hit` labels in `saveSuccess`; the save's mixture relabels them.
    expect([...parsed.saveSuccess].map(([value, bin]) => [value, bin.p])).toEqual(
      [...d4.toPMF()].map(([value, bin]) => [value, bin.p])
    );
  });
});

describe("a check that cannot land on one side", () => {
  it("a certain success is the payload alone, and a certain failure is the failure payload alone", () => {
    const success = d20.plus(30).dc(10).onSaveFailure(failure()).onSaveSuccess(d4).resolve();
    expect(success.pmf.outcomeProbability("saveFail")).toBe(0);
    expect(bins(success.pmf).map(([value, p]) => [value, p])).toEqual(bins(d4.toPMF()).map(([value, p]) => [value, p]));
    const fail = d20.dc(30).onSaveFailure(failure()).onSaveSuccess(d4).resolve();
    expect(fail.pmf.outcomeProbability("saveHalf")).toBe(0);
    expect(fail.pmf.mean()).toBeCloseTo(7, 12);
  });
});

describe("a save with no failure effect", () => {
  it("deals nothing on a failure and the payload on a success", () => {
    const res = new SaveBuilder(check()).onSaveSuccess(3).resolve();
    expect(res.pmf.pAt(3)).toBeCloseTo(P_SUCCESS, 12);
    expect(res.pmf.pAt(0)).toBeCloseTo(P_FAIL, 12);
    expect(res.pmf.outcomeProbability("saveFail")).toBeCloseTo(P_FAIL, 12);
    expect(res.pmf.outcomeProbability("saveHalf")).toBeCloseTo(P_SUCCESS, 12);
  });
});

describe("chaining", () => {
  it("leaves the save it was called on unchanged", () => {
    const plain = check().onSaveFailure(failure());
    const before = bins(plain.toPMF());
    const withSuccess = plain.onSaveSuccess(d4);
    expect(withSuccess).not.toBe(plain);
    expect(bins(plain.toPMF())).toEqual(before);
    expect(plain.toPMF().outcomeProbability("saveHalf")).toBe(0);
  });

  it("saveHalf() after onSaveSuccess() throws, and so does onSaveSuccess() after saveHalf(): one or the other", () => {
    const half = check().onSaveFailure(failure()).saveHalf();
    const payload = check().onSaveFailure(failure()).onSaveSuccess(d4);
    expect(() => payload.saveHalf()).toThrow(
      "saveHalf() cannot be combined with onSaveSuccess(): the success branch can only be one or the other."
    );
    expect(() => half.onSaveSuccess(d4)).toThrow(
      "onSaveSuccess() cannot be combined with saveHalf(): the success branch can only be one or the other."
    );
    expect(() => half.onSaveSuccess(3)).toThrow("the success branch can only be one or the other");
    expect(() => half.onSaveSuccess("1d4")).toThrow("the success branch can only be one or the other");
    // The throw leaves the receiver as it was.
    expect(bins(half.toPMF())).toEqual(bins(check().onSaveFailure(failure()).saveHalf().toPMF()));
  });

  it("repeats are fine: saveHalf() twice is one half, a second onSaveSuccess() replaces the first", () => {
    const half = check().onSaveFailure(failure()).saveHalf();
    expect(bins(half.saveHalf().toPMF())).toEqual(bins(half.toPMF()));
    const payload = check().onSaveFailure(failure()).onSaveSuccess(d4);
    expect(bins(payload.onSaveSuccess(d6).toPMF())).toEqual(
      bins(check().onSaveFailure(failure()).onSaveSuccess(d6).toPMF())
    );
  });
});

describe("onSaveSuccess takes onSaveFailure's arguments", () => {
  const reference = (build: (dc: DCBuilder) => SaveBuilder) => bins(build(check()).toPMF());

  it("a number, a string, a RollBuilder, (count, die), (count, sides), and either with a modifier", () => {
    const cases: Array<[string, SaveBuilder, SaveBuilder]> = [
      ["number", check().onSaveFailure(failure()).onSaveSuccess(3), check().onSaveFailure(failure()).onSaveSuccess(roll.flat(3))],
      ["string", check().onSaveFailure(failure()).onSaveSuccess("1d4"), check().onSaveFailure(failure()).onSaveSuccess(d("1d4"))],
      ["RollBuilder", check().onSaveFailure(failure()).onSaveSuccess(d4), check().onSaveFailure(failure()).onSaveSuccess(roll(1, d4))],
      ["(count, die)", check().onSaveFailure(failure()).onSaveSuccess(2, d6), check().onSaveFailure(failure()).onSaveSuccess(roll(2, d6))],
      ["(count, sides)", check().onSaveFailure(failure()).onSaveSuccess(2, 6), check().onSaveFailure(failure()).onSaveSuccess(roll(2, d6))],
      ["(count, die, modifier)", check().onSaveFailure(failure()).onSaveSuccess(2, d6, 1), check().onSaveFailure(failure()).onSaveSuccess(roll(2, d6).plus(1))],
      ["(count, sides, modifier)", check().onSaveFailure(failure()).onSaveSuccess(2, 6, 1), check().onSaveFailure(failure()).onSaveSuccess(roll(2, d6).plus(1))],
    ];
    for (const [name, actual, expected] of cases) {
      expect(bins(actual.toPMF()), name).toEqual(bins(expected.toPMF()));
    }
    // The same arguments as onSaveFailure reads: (2, 6, 1) is 2d6 + 1, mean 8.
    expect(check().onSaveFailure(failure()).onSaveSuccess(2, 6, 1).resolve().saveSuccess.mean()).toBeCloseTo(8, 12);
    expect(reference((dc) => dc.onSaveFailure(2, 6, 1))).toEqual(reference((dc) => dc.onSaveFailure(roll(2, d6).plus(1))));
  });

  it("refuses the arguments onSaveFailure refuses", () => {
    const base = check().onSaveFailure(failure());
    expect(() => base.onSaveSuccess(Number.NaN)).toThrow();
    expect(() => base.onSaveSuccess(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => (base.onSaveSuccess as (...args: unknown[]) => SaveBuilder)("x", 6)).toThrow();
    expect(() => (base.onSaveSuccess as (...args: unknown[]) => SaveBuilder)(1, 2, 3, 4)).toThrow();
  });
});

describe("the plain half as a success payload", () => {
  // `failure.half()` is `floor(failure / 2)` as a builder, which is what `saveHalf()` computes on the PMF.
  it("is saveHalf(), bit for bit, at every eps a consumer passes", () => {
    for (const payload of [failure(), roll(3, d6).plus(2), roll(8, d6), roll(1, d6).minus(1)]) {
      const half = check().onSaveFailure(payload).saveHalf();
      const explicit = check().onSaveFailure(payload).onSaveSuccess(payload.half());
      for (const eps of [undefined, 0, 1e-12, 1e-6]) {
        const a = half.resolve(eps);
        const b = explicit.resolve(eps);
        expect(bins(b.pmf), `pmf eps ${eps}`).toEqual(bins(a.pmf));
        expect(bins(b.saveSuccess)).toEqual(bins(a.saveSuccess));
        expect(bins(b.saveFail)).toEqual(bins(a.saveFail));
        expect(b.weights).toEqual(a.weights);
      }
    }
  });
});

describe("a success halved BEFORE its scale (what dpr's saveHalfBeforeScale builds)", () => {
  // Whole-roll vulnerability on 2d4 (sums 2..8, weights 1,2,3,4,3,2,1 of 16): a failure deals 2 x s; a success
  // deals 2 x floor(s / 2), the halving before the doubling. d20 against DC 12: a save on 12 or better, 9/20.
  const base = roll(2, d4);
  const failureScaled = base.scaleResult(2);
  const successScaled = base.half().scaleResult(2);
  const save = d20.dc(12).onSaveFailure(failureScaled).onSaveSuccess(successScaled);
  const F: Record<number, number> = { 4: 1, 6: 2, 8: 3, 10: 4, 12: 3, 14: 2, 16: 1 };
  const S: Record<number, number> = { 2: 3, 4: 7, 6: 5, 8: 1 };
  const pSuccess = 9 / 20;
  const pFail = 11 / 20;

  it("deals the hand-computed mixture, each bin and each label", () => {
    const { pmf } = save.resolve();
    const values = new Set([...Object.keys(F), ...Object.keys(S)].map(Number));
    expect(new Set(pmf.support())).toEqual(values);
    for (const value of values) {
      const half = (pSuccess * (S[value] ?? 0)) / 16;
      const fail = (pFail * (F[value] ?? 0)) / 16;
      expect(pmf.pAt(value), `p@${value}`).toBeCloseTo(half + fail, 12);
      expect(pmf.binAt(value)?.count.saveHalf ?? 0, `saveHalf@${value}`).toBeCloseTo(half, 12);
      expect(pmf.binAt(value)?.count.saveFail ?? 0, `saveFail@${value}`).toBeCloseTo(fail, 12);
    }
  });

  it("means 0.45 x 4.5 + 0.55 x 10, below the 7.75 of halving after the doubling", () => {
    expect(save.resolve().pmf.mean()).toBeCloseTo(0.45 * 4.5 + 0.55 * 10, 12);
    const after = d20.dc(12).onSaveFailure(failureScaled).saveHalf().pmf.mean();
    expect(after).toBeCloseTo(0.45 * 5 + 0.55 * 10, 12);
    expect(save.pmf.mean()).toBeLessThan(after);
  });

  it("reaches a Turn as a source: the turn mean and the labelled outcomes", () => {
    const t = turn([save]);
    expect(t.mean()).toBeCloseTo(7.525, 12);
    expect(t.pmf.outcomeProbability("saveHalf")).toBeCloseTo(pSuccess, 12);
    expect(t.pmf.outcomeProbability("saveFail")).toBeCloseTo(pFail, 12);
  });

  it("is a rider payload an attack gates (Poisoner): the attack plus 0.6 x the save", () => {
    // d20 + 5 against AC 14 lands on 9 or better: 11/20 hits and 1/20 crits, so the rider fires 12/20 of the
    // time, and a save payload does not double on the crit. The attack's own mean is 11/20 x 4.5 + 1/20 x 9.
    const attack = d20.plus(5).ac(14).onHit(roll(1, d(8)));
    const t = turn([{ id: "atk", source: attack }]).onFirstHit(save, { id: "poison", of: ["atk"] });
    const attackMean = (11 / 20) * 4.5 + (1 / 20) * 9;
    expect(t.mean()).toBeCloseTo(attackMean + 0.6 * save.pmf.mean(), 12);
    expect(t.fireProbability("poison")).toBeCloseTo(0.6, 12);
  });
});

describe("resolved-save cache", () => {
  beforeEach(() => {
    clearSaveCache();
    clearDCCache();
    clearRollCache();
  });

  const withSuccess = (payload: RollBuilder | number) =>
    typeof payload === "number"
      ? check().onSaveFailure(failure()).onSaveSuccess(payload)
      : check().onSaveFailure(failure()).onSaveSuccess(payload);

  it("returns the SAME cached PMF for a freshly rebuilt identical save", () => {
    expect(withSuccess(d4).toPMF()).toBe(withSuccess(d4).toPMF());
    expect(withSuccess(3).toPMF()).toBe(withSuccess(3).toPMF());
  });

  it("forks the key on the success payload: two saves that differ only there never share a PMF", () => {
    const d4Save = withSuccess(d4).toPMF();
    const d6Save = withSuccess(d6).toPMF();
    expect(d6Save).not.toBe(d4Save);
    expect(d4Save.mean()).toBeCloseTo(P_SUCCESS * 2.5 + P_FAIL * 7, 12);
    expect(d6Save.mean()).toBeCloseTo(P_SUCCESS * 3.5 + P_FAIL * 7, 12);
    expect(withSuccess(3).toPMF().mean()).toBeCloseTo(P_SUCCESS * 3 + P_FAIL * 7, 12);
    expect(withSuccess(4).toPMF().mean()).toBeCloseTo(P_SUCCESS * 4 + P_FAIL * 7, 12);
    // ...and the same again after the others were cached.
    expect(withSuccess(d4).toPMF()).toBe(d4Save);
  });

  it("forks the key against the plain save and saveHalf()", () => {
    const plain = check().onSaveFailure(failure()).toPMF();
    const half = check().onSaveFailure(failure()).saveHalf().toPMF();
    const payload = withSuccess(failure().half()).toPMF();
    expect(payload).not.toBe(plain);
    expect(payload).not.toBe(half);
    expect(bins(payload)).toEqual(bins(half));
    expect(withSuccess(0).toPMF()).not.toBe(plain);
    expect(withSuccess(0).toPMF().outcomeProbability("saveHalf")).toBeCloseTo(P_SUCCESS, 12);
    expect(plain.outcomeProbability("saveHalf")).toBe(0);
  });

  it("does NOT cache when the success payload opts out (parsed / half), and still resolves it right", () => {
    for (const payload of [d("1d4"), d4.half()]) {
      expect(payload.cacheKey()).toBeNull();
      const a = withSuccess(payload).toPMF();
      const b = withSuccess(payload).toPMF();
      expect(b).not.toBe(a);
      expect(bins(b)).toEqual(bins(a));
    }
    expect(withSuccess(d("1d4")).toPMF().mean()).toBeCloseTo(P_SUCCESS * 2.5 + P_FAIL * 7, 12);
    expect(withSuccess(d4.half()).toPMF().mean()).toBeCloseTo(P_SUCCESS * 1 + P_FAIL * 7, 12);
  });
});

describe("expression", () => {
  const cases: Array<[string, SaveBuilder, string]> = [
    ["a builder payload", check().onSaveFailure(failure()).onSaveSuccess(d4), "(d20 + 5 DC 15) * (2d6) save (1d4)"],
    ["a flat payload", check().onSaveFailure(failure()).onSaveSuccess(3), "(d20 + 5 DC 15) * (2d6) save (3)"],
    ["a flat 0", check().onSaveFailure(failure()).onSaveSuccess(0), "(d20 + 5 DC 15) * (2d6) save (0)"],
    ["a negative flat", check().onSaveFailure(failure()).onSaveSuccess(-2), "(d20 + 5 DC 15) * (2d6) save (0 - 2)"],
    ["a parsed payload", check().onSaveFailure(failure()).onSaveSuccess(d("3d6")), "(d20 + 5 DC 15) * (2d6) save (3d6)"],
    [
      "a half payload",
      check().onSaveFailure(failure()).onSaveSuccess(failure().half()),
      "(d20 + 5 DC 15) * (2d6) save ((2d6) // 2)",
    ],
    [
      "halved before doubled",
      check()
        .onSaveFailure(roll(2, d4).scaleResult(2))
        .onSaveSuccess(roll(2, d4).half().scaleResult(2)),
      "(d20 + 5 DC 15) * (2 ** (2d4)) save (2 ** ((2d4) // 2))",
    ],
    ["no failure effect", new SaveBuilder(check()).onSaveSuccess(3), "(d20 + 5 DC 15) * (0) save (3)"],
  ];

  it.each(cases)("prints %s", (_name, save, expected) => {
    expect(save.toExpression()).toBe(expected);
  });

  it.each(cases)("reads back to the save's own distribution, bin by bin and label by label: %s", (_name, save) => {
    const parsed = parse(save.toExpression());
    const built = save.toPMF();
    expect(new Set(parsed.support())).toEqual(new Set(built.support()));
    for (const value of built.support()) {
      expect(Math.abs(parsed.pAt(value) - built.pAt(value)), `p@${value}`).toBeLessThanOrEqual(1e-12);
      for (const label of ["saveHalf", "saveFail", "missNone"] as const) {
        const a = parsed.binAt(value)?.count[label] ?? 0;
        const b = built.binAt(value)?.count[label] ?? 0;
        expect(Math.abs(a - b), `${label}@${value}`).toBeLessThanOrEqual(1e-12);
      }
    }
  });

  it("keeps the strings of a plain save, a saveHalf() save and a save with no failure effect", () => {
    expect(check().onSaveFailure(failure()).toExpression()).toBe("(d20 + 5 DC 15) * (2d6)");
    expect(check().onSaveFailure(failure()).saveHalf().toExpression()).toBe("(d20 + 5 DC 15) * (2d6) save half");
    expect(new SaveBuilder(check()).toExpression()).toBe("(d20 + 5 DC 15)");
    expect(new SaveBuilder(check()).saveHalf().toExpression()).toBe("(d20 + 5 DC 15)");
  });
});
