import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { DiceQuery, EPS, parse, PMF } from "../src/index";
import { d6, d8, d10, d20 } from "../src/builder/index";

/**
 * Characterization / lock-down suite for the optimization + correctness pass.
 *
 * Each scenario's output was captured from the pre-change branch and frozen in
 * tests/fixtures/refactor-characterization.json. The behavior-preserving
 * refactors (integer DP keys, O(N) max-of CDF, single-pass branch mixture,
 * Set-based reroll, hoisted binaryOp keys, re-derived count queries) must leave
 * these outputs unchanged. compact()'s captured RESULT must also be unchanged;
 * its separate test below additionally asserts the source is no longer mutated.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const baseline = JSON.parse(
  readFileSync(join(__dirname, "fixtures/refactor-characterization.json"), "utf8")
) as Record<string, any>;

type BinObj = { p: number; count: Record<string, number>; attr?: Record<string, number> };

function pmfToObj(p: PMF): Record<string, BinObj> {
  const out: Record<string, BinObj> = {};
  for (const [k, bin] of [...p.map.entries()].sort((a, b) => a[0] - b[0])) {
    out[k] = {
      p: bin.p,
      count: { ...bin.count } as Record<string, number>,
      attr: bin.attr ? ({ ...bin.attr } as Record<string, number>) : undefined,
    };
  }
  return out;
}

// Deep float comparison with tight tolerance. The refactors are intended to be
// bit-identical; the tolerance only absorbs sub-ULP re-association.
function expectClose(actual: number, expected: number, label: string) {
  const tol = 1e-12 + 1e-9 * Math.abs(expected);
  expect(
    Math.abs(actual - expected) <= tol,
    `${label}: got ${actual}, expected ${expected}`
  ).toBe(true);
}

function expectPMFMatches(actual: Record<string, BinObj>, key: string) {
  const expected = baseline[key] as Record<string, BinObj>;
  expect(Object.keys(actual).sort(), `${key}: support`).toEqual(
    Object.keys(expected).sort()
  );
  for (const dmg of Object.keys(expected)) {
    const a = actual[dmg];
    const e = expected[dmg];
    expect(a, `${key}: bin ${dmg} present`).toBeDefined();
    expectClose(a.p, e.p, `${key} bin ${dmg} p`);
    const ckeys = new Set([
      ...Object.keys(a.count ?? {}),
      ...Object.keys(e.count ?? {}),
    ]);
    for (const c of ckeys) {
      expectClose(a.count?.[c] ?? 0, e.count?.[c] ?? 0, `${key} bin ${dmg} count.${c}`);
    }
    const akeys = new Set([
      ...Object.keys(a.attr ?? {}),
      ...Object.keys(e.attr ?? {}),
    ]);
    for (const c of akeys) {
      expectClose(a.attr?.[c] ?? 0, e.attr?.[c] ?? 0, `${key} bin ${dmg} attr.${c}`);
    }
  }
}

describe("refactor characterization: keepSumPMF DP (item 2)", () => {
  it("keepHighest(4,3) of d6", () =>
    expectPMFMatches(pmfToObj(d6.keepHighest(4, 3).toPMF()), "kh3of4d6"));
  it("keepLowest(5,2) of d8", () =>
    expectPMFMatches(pmfToObj(d8.keepLowest(5, 2).toPMF()), "kl2of5d8"));
  it("keepHighest(6,2) of d6", () =>
    expectPMFMatches(pmfToObj(d6.keepHighest(6, 2).toPMF()), "kh2of6d6"));
});

describe("refactor characterization: computeMaxOfPMF (item 3)", () => {
  it("keepHighest(6,1) of d10 (small enumerate)", () =>
    expectPMFMatches(pmfToObj(d10.keepHighest(6, 1).toPMF()), "kh1of6d10"));
  it("keepHighest(10,1) of d20 (large-count CDF path)", () =>
    expectPMFMatches(pmfToObj(d20.keepHighest(10, 1).toPMF()), "kh1of10d20"));
  it("keepLowest(5,1) of d8 (min via negated max)", () =>
    expectPMFMatches(pmfToObj(d8.keepLowest(5, 1).toPMF()), "kl1of5d8"));
  it("maxOf(8) of d8 (large-count CDF path)", () =>
    expectPMFMatches(pmfToObj(d8.maxOf(8).toPMF()), "maxOf8_d8"));
  it("maxOf(3) of d6 (small enumerate)", () =>
    expectPMFMatches(pmfToObj(d6.maxOf(3).toPMF()), "maxOf3_d6"));
});

describe("refactor characterization: PMF.branch (item 4)", () => {
  it("branch(2d6+3, 1d8+1, 0.3)", () => {
    const out = PMF.branch(parse("2d6+3"), parse("1d8+1"), 0.3);
    expectPMFMatches(pmfToObj(out), "branch_0.3");
  });
  it("withProbability(2d6+3, 0.25)", () =>
    expectPMFMatches(
      pmfToObj(PMF.withProbability(parse("2d6+3"), 0.25)),
      "branch_withProbability_0.25"
    ));
  it("gate(0.5)", () =>
    expectPMFMatches(pmfToObj(parse("2d6+3").gate(0.5, parse("1d8+1"))), "gate_0.5"));
  it("preserves identifier (feeds convolve cache key)", () => {
    const a = parse("2d6+3");
    const b = parse("1d8+1");
    const out = PMF.branch(a, b, 0.3);
    expect(out.identifier).toBe(
      `branch(${b.identifier}*${(0.7).toFixed(6)} + ${a.identifier}*${(0.3).toFixed(6)})`
    );
  });
});

describe("refactor characterization: reroll (item 5)", () => {
  it("d6 reroll 1", () => expectPMFMatches(pmfToObj(parse("d6 reroll 1")), "reroll_d6_1"));
  it("d8 reroll 2", () => expectPMFMatches(pmfToObj(parse("d8 reroll 2")), "reroll_d8_2"));
  it("hd6 (halfling luck)", () => expectPMFMatches(pmfToObj(parse("hd6")), "hd6"));
});

describe("refactor characterization: binaryOp non-scalar (item 6)", () => {
  it("d6 + d4", () => expectPMFMatches(pmfToObj(parse("d6 + d4")), "d6_plus_d4"));
  it("d8 > d6 (max)", () => expectPMFMatches(pmfToObj(parse("d8 > d6")), "d8_max_d6"));
});

describe("refactor characterization: count queries (item 9)", () => {
  const buildQuery = () =>
    new DiceQuery([
      parse("(d20 + 5 ac 15) * (2d6 + 3)"),
      parse("(d20 + 3 ac 15) * (1d8 + 2)"),
      parse("(d20 + 7 ac 15) * (1d10 + 4)"),
    ]);
  const arr = ["hit", "crit"] as any;

  it("probExactlyK array path matches baseline", () => {
    const q = buildQuery();
    for (let k = 0; k <= 3; k++) {
      expectClose(q.probExactlyK(arr, k), baseline.countquery_exactly[k], `exactly ${k}`);
    }
  });
  it("probAtLeastK array path matches baseline", () => {
    const q = buildQuery();
    for (let k = 0; k <= 3; k++) {
      expectClose(q.probAtLeastK(arr, k), baseline.countquery_atLeast[k], `atLeast ${k}`);
    }
  });
  it("probAtMostK array path matches baseline", () => {
    const q = buildQuery();
    for (let k = 0; k <= 3; k++) {
      expectClose(q.probAtMostK(arr, k), baseline.countquery_atMost[k], `atMost ${k}`);
    }
  });
  it("single-label path unchanged", () => {
    const q = buildQuery();
    for (let k = 0; k <= 3; k++) {
      expectClose(
        q.probExactlyK("hit" as any, k),
        baseline.countquery_exactly_single[k],
        `exactly-single ${k}`
      );
    }
  });

  it("single-attack (n=1) array path collapses to the per-event marginal", () => {
    // n=1 is the most common real call and collapses the binomial DP. For a
    // single attack, P(exactly 1) must equal the per-event marginal P(>=1), and
    // the array path must agree with the single-label string path.
    const q = new DiceQuery([parse("(d20 + 5 ac 15) * (2d6 + 3)")]);
    const arr = ["hit"] as any;
    const marginal = q.probAtLeastOne("hit" as any);
    expect(marginal).toBeGreaterThan(0); // sanity: the label exists
    expect(q.probExactlyK(arr, 1)).toBeCloseTo(marginal, 10);
    expect(q.probExactlyK(arr, 0)).toBeCloseTo(1 - marginal, 10);
    expect(q.probExactlyK(arr, 2)).toBe(0); // k > n
    expect(q.probExactlyK(arr, 1)).toBeCloseTo(q.probExactlyK("hit" as any, 1), 12);
    expect(q.probAtLeastK(arr, 1)).toBeCloseTo(marginal, 10);
    expect(q.probAtMostK(arr, 0)).toBeCloseTo(1 - marginal, 10);
  });

  it("array count distribution is internally consistent", () => {
    const q = buildQuery();
    let sum = 0;
    for (let k = 0; k <= 3; k++) sum += q.probExactlyK(arr, k);
    expect(sum).toBeCloseTo(1, 10);
    // atLeastK and atMostK are complementary slices of the same distribution
    for (let k = 0; k <= 3; k++) {
      const atMostKMinus1 = k === 0 ? 0 : q.probAtMostK(arr, k - 1);
      expect(q.probAtLeastK(arr, k)).toBeCloseTo(1 - atMostKMinus1, 10);
    }
  });
});

describe("combinedWithAttribution slow path (builder PMFs without attribution)", () => {
  it("runs the withAttribution()+convolve fallback and stays consistent with combined", () => {
    // Builder-generated PMFs carry only `count` (no `attr`), so this takes the
    // slow path rather than the fast hasAttribution() identity reuse.
    const singles = [d6.plus(3).toPMF(), d8.toPMF()];
    expect(singles.every((p) => !p.hasAttribution())).toBe(true);

    const q = new DiceQuery(singles);
    const attributed = q.combinedWithAttribution();

    expect(attributed.mass()).toBeCloseTo(1, 9);
    expect(attributed.support()).toEqual(q.combined.support());
    // Per-bin probabilities match the plain combined distribution.
    for (const v of q.combined.support()) {
      expectClose(
        attributed.map.get(v)!.p,
        q.combined.map.get(v)!.p,
        `combinedWithAttribution bin ${v} p`
      );
    }
  });
});

describe("compact() (item 1)", () => {
  it("drops sub-eps count/attr entries in the RESULT (unchanged)", () => {
    const m = new Map<number, any>();
    m.set(5, { p: 0.5, count: { hit: 0.5, tiny: 1e-20 }, attr: { hit: 2.5, tiny: 1e-20 } });
    m.set(7, { p: 0.5, count: { hit: 0.5 } });
    m.set(9, { p: 1e-20, count: { hit: 1e-20 } });
    const pmf = new PMF(m, EPS);
    expectPMFMatches(pmfToObj(pmf.compact()), "compact_result");
  });

  it("does not mutate the receiver's own bins", () => {
    const m = new Map<number, any>();
    m.set(5, { p: 0.5, count: { hit: 0.5, tiny: 1e-20 }, attr: { hit: 2.5, tiny: 1e-20 } });
    m.set(7, { p: 0.5, count: { hit: 0.5 } });
    const pmf = new PMF(m, EPS);
    pmf.compact();
    expect(pmf.map.get(5)!.count.tiny).toBe(1e-20);
    expect(pmf.map.get(5)!.attr!.tiny).toBe(1e-20);
  });

  it("does not corrupt another PMF that shares the same bin objects by reference", () => {
    // Bins are shared by reference across PMFs (branch()/addScaled()/scaleMass()
    // fast paths can carry another PMF's bin objects). Compacting one PMF must
    // not delete sub-eps entries out of a bin a different PMF still holds.
    const sharedBin = {
      p: 0.5,
      count: { hit: 0.5, tiny: 1e-20 },
      attr: { hit: 2.5, tiny: 1e-20 },
    };
    const a = new PMF(
      new Map<number, any>([
        [5, sharedBin],
        [7, { p: 0.5, count: { hit: 0.5 } }],
      ]),
      EPS
    );
    const b = new PMF(new Map<number, any>([[5, sharedBin]]), EPS);

    b.compact();

    expect(a.map.get(5)!.count.tiny).toBe(1e-20);
    expect(a.map.get(5)!.attr!.tiny).toBe(1e-20);
  });

  it("branch(p=0) fast path returns a PMF whose compact() does not corrupt the failure branch", () => {
    const failure = parse("2d6+1");
    const before = JSON.stringify(failure.toJSON());
    const branched = PMF.branch(parse("1d8"), failure, 0);
    branched.compact(1e-9); // aggressive eps to force count pruning
    expect(JSON.stringify(failure.toJSON())).toBe(before);
  });
});
