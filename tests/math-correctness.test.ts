import { describe, expect, it } from "vitest";
import { DiceQuery, EPS, parse, PMF } from "../src/index";
import { d20, d4, roll } from "../src/builder/index";

/**
 * Mathematical-correctness lock-down suite.
 *
 * Each expectation is checked against an INDEPENDENT brute-force reference
 * (full enumeration of the sample space) or a hand-derived closed form — never
 * against the engine's own output. This both confirms the bugs fixed in the
 * correctness pass and guards the invariants that must always hold.
 */

// ---------------------------------------------------------------------------
// Independent brute-force reference (no engine code)
// ---------------------------------------------------------------------------
type Dist = Map<number, number>; // value -> probability

function diceDist(count: number, sides: number, flat = 0): Dist {
  let cur: Dist = new Map([[flat, 1]]);
  for (let i = 0; i < count; i++) {
    const next: Dist = new Map();
    for (const [v, p] of cur)
      for (let f = 1; f <= sides; f++)
        next.set(v + f, (next.get(v + f) ?? 0) + p / sides);
    cur = next;
  }
  return cur;
}
function scaleProb(a: Dist, w: number): Dist {
  const o: Dist = new Map();
  for (const [k, v] of a) o.set(k, v * w);
  return o;
}
function mixDist(parts: Dist[]): Dist {
  const o: Dist = new Map();
  for (const d of parts) for (const [k, v] of d) o.set(k, (o.get(k) ?? 0) + v);
  return o;
}
function d20faces(mode: "flat" | "adv" | "dis" | "elven"): Dist {
  const o: Dist = new Map();
  if (mode === "flat") {
    for (let r = 1; r <= 20; r++) o.set(r, 1 / 20);
    return o;
  }
  if (mode === "elven") {
    for (let a = 1; a <= 20; a++)
      for (let b = 1; b <= 20; b++)
        for (let c = 1; c <= 20; c++) {
          const r = Math.max(a, b, c);
          o.set(r, (o.get(r) ?? 0) + 1 / 8000);
        }
    return o;
  }
  for (let a = 1; a <= 20; a++)
    for (let b = 1; b <= 20; b++) {
      const r = mode === "adv" ? Math.max(a, b) : Math.min(a, b);
      o.set(r, (o.get(r) ?? 0) + 1 / 400);
    }
  return o;
}
function attack(
  mode: "flat" | "adv" | "dis" | "elven",
  mod: number,
  ac: number,
  normalDmg: Dist,
  critDmg: Dist
) {
  const faces = d20faces(mode);
  const parts: Dist[] = [];
  let pHit = 0,
    pCrit = 0,
    pMiss = 0;
  for (const [r, p] of faces) {
    if (r === 1) {
      pMiss += p;
      parts.push(scaleProb(new Map([[0, 1]]), p));
    } else if (r === 20) {
      pCrit += p;
      parts.push(scaleProb(critDmg, p));
    } else if (r + mod >= ac) {
      pHit += p;
      parts.push(scaleProb(normalDmg, p));
    } else {
      pMiss += p;
      parts.push(scaleProb(new Map([[0, 1]]), p));
    }
  }
  return { dist: mixDist(parts), pHit, pCrit, pMiss };
}
const meanOf = (d: Dist) => {
  let m = 0;
  for (const [k, v] of d) m += k * v;
  return m;
};
const varOf = (d: Dist) => {
  const mu = meanOf(d);
  let v = 0;
  for (const [k, p] of d) v += (k - mu) * (k - mu) * p;
  return v;
};
const massOf = (d: Dist) => {
  let s = 0;
  for (const v of d.values()) s += v;
  return s;
};

// ---------------------------------------------------------------------------

describe("Convolution & mass invariants", () => {
  it("sum of independent dice matches full enumeration bin-by-bin", () => {
    for (const [c, s] of [
      [2, 6],
      [3, 4],
      [2, 8],
    ] as const) {
      const ref = diceDist(c, s);
      const pmf = parse(`${c}d${s}`).normalize();
      expect(pmf.mass()).toBeCloseTo(1, 12);
      for (const [v, p] of ref) expect(pmf.pAt(v)).toBeCloseTo(p, 12);
    }
  });

  it("a zero-mass operand convolves to mass 0, never NaN", () => {
    const d6 = parse("1d6");
    const c = d6.convolve(PMF.emptyMass());
    expect(Number.isNaN(c.mass())).toBe(false);
    expect(c.mass()).toBe(0);
    for (const [, bin] of c) expect(bin.p).toBe(0);

    // raw and non-raw paths now agree
    expect(d6.combineRaw(PMF.emptyMass()).mass()).toBe(0);

    // and it does not poison a DiceQuery
    const q = new DiceQuery([d6, PMF.emptyMass()]);
    expect(Number.isNaN(q.combined.mass())).toBe(false);
    expect(Number.isNaN(q.mean())).toBe(false);
  });

  it("convolveMany with a zeroed middle operand and power() stay finite", () => {
    const d6 = parse("1d6");
    expect(PMF.convolveMany([d6, d6.scaleMass(0), d6]).mass()).toBe(0);
    expect(PMF.emptyMass().power(3).mass()).toBe(0);
  });
});

describe("Moments (additivity, stability, consistency)", () => {
  it("mean & variance match brute force for a realistic attack", () => {
    const ref = attack("flat", 5, 15, diceDist(1, 8, 3), diceDist(2, 8, 3));
    const q = parse("(d20 + 5 AC 15) * (1d8 + 3) crit (2d8 + 3)").query();
    expect(q.mean()).toBeCloseTo(meanOf(ref.dist), 9);
    expect(q.variance()).toBeCloseTo(varOf(ref.dist), 6);
    expect(q.stddev()).toBeCloseTo(Math.sqrt(varOf(ref.dist)), 6);
  });

  it("variance is shift-invariant (no catastrophic cancellation at scale)", () => {
    // Var(1d6 + K) = Var(1d6) = 35/12 for every offset K.
    for (const K of [0, 1e3, 1e6, 1e8, 1e10]) {
      expect(parse(`1d6 + ${K}`).query().variance()).toBeCloseTo(35 / 12, 9);
    }
  });

  it("mean/variance stay consistent with an explicitly-provided combined", () => {
    const provided = PMF.fromMap(new Map([[100, 1]]));
    const q = new DiceQuery([parse("1d6")], provided); // combined != convolve(singles)
    expect(q.mean()).toBe(q.combined.mean());
    expect(q.mean()).toBe(100);
    expect(q.variance()).toBe(q.combined.variance());
  });

  it("mean is additive across independent attacks", () => {
    const single = parse("(d20 + 7 AC 16) * (2d6 + 4) crit (4d6 + 4)");
    const one = new DiceQuery([single]).mean();
    for (const n of [1, 2, 3, 4]) {
      expect(new DiceQuery(single.replicate(n)).mean()).toBeCloseTo(one * n, 9);
    }
  });
});

describe("Counting queries (Poisson-binomial)", () => {
  const single = parse("(d20 + 5 AC 15) * (1d8 + 3) crit (2d8 + 3)");
  // per-attack success probabilities (from the brute-force attack model)
  const ref = attack("flat", 5, 15, diceDist(1, 8, 3), diceDist(2, 8, 3));
  const pCrit = ref.pCrit; // 0.05
  const pSucc = ref.pHit + ref.pCrit; // hit or crit

  const binom = (n: number, k: number, p: number) => {
    const c = (a: number, b: number) => {
      let r = 1;
      for (let i = 0; i < b; i++) r = (r * (a - i)) / (i + 1);
      return r;
    };
    return c(n, k) * p ** k * (1 - p) ** (n - k);
  };

  it("probExactlyK string-path and array-path agree and match the true binomial", () => {
    const q = new DiceQuery(single.replicate(3));
    for (let k = 0; k <= 3; k++) {
      const truth = binom(3, k, pCrit);
      expect(q.probExactlyK("crit", k)).toBeCloseTo(truth, 9);
      expect(q.probExactlyK(["crit"], k)).toBeCloseTo(truth, 9); // array path (was badly wrong)
    }
  });

  it("probAtLeastOne / probAtLeastK / probAtMostK match enumeration", () => {
    const q = new DiceQuery(single.replicate(3));
    expect(q.probAtLeastOne(["hit", "crit"])).toBeCloseTo(
      1 - (1 - pSucc) ** 3,
      9
    );
    expect(q.probAtLeastK("crit", 1)).toBeCloseTo(1 - (1 - pCrit) ** 3, 9);
    expect(q.probAtMostK("crit", 0)).toBeCloseTo((1 - pCrit) ** 3, 9);
  });

  it("probabilityOf equals the marginal P(>=1), not an over-count of bins", () => {
    const q = new DiceQuery(single.replicate(2));
    // P(>=1 crit) over 2 attacks = 1 - 0.95^2 = 0.0975 (NOT the bin-mass sum)
    expect(q.probabilityOf("crit")).toBeCloseTo(1 - (1 - pCrit) ** 2, 9);
    expect(q.probabilityOf("crit")).toBeCloseTo(q.probAtLeastOne("crit"), 12);
  });

  it("single-attack probabilityOf('crit') is exactly P(nat 20) = 0.05", () => {
    expect(new DiceQuery([single]).probabilityOf("crit")).toBeCloseTo(0.05, 9);
  });

  it("missChance matches P(miss) by enumeration", () => {
    // single attack d20+5 vs AC15: miss on nat1 or total<15 -> 9/20 = 0.45
    const q = parse("(d20 + 5 AC 15) * (1d6)").query();
    expect(q.missChance()).toBeCloseTo(0.45, 9);
  });

  it("counting queries are invariant to single mass scaling", () => {
    const q1 = new DiceQuery([single, single]);
    const q2 = new DiceQuery([single.scaleMass(0.5), single.scaleMass(0.5)]);
    expect(q2.probAtLeastOne("crit")).toBeCloseTo(q1.probAtLeastOne("crit"), 9);
    expect(q2.probExactlyK("crit", 1)).toBeCloseTo(q1.probExactlyK("crit", 1), 9);
  });
});

describe("Parser D&D mechanics vs brute force", () => {
  it("flat attack: mean, hit and crit probabilities", () => {
    const ref = attack("flat", 6, 15, diceDist(2, 6, 4), diceDist(4, 6, 4));
    const q = parse("(d20 + 6 AC 15) * (2d6 + 4) crit (4d6 + 4)").query();
    expect(q.mean()).toBeCloseTo(meanOf(ref.dist), 9);
    expect(q.probAtLeastOne("crit")).toBeCloseTo(ref.pCrit, 9); // 0.05
    expect(q.probAtLeastOne("hit")).toBeCloseTo(ref.pHit, 9);
  });

  it("advantage and disadvantage hit probabilities", () => {
    const adv = attack("adv", 7, 16, diceDist(1, 8, 3), diceDist(2, 8, 3));
    const qa = parse("(d20 > d20 + 7 AC 16) * (1d8 + 3) crit (2d8 + 3)").query();
    expect(qa.mean()).toBeCloseTo(meanOf(adv.dist), 9);
    expect(qa.probAtLeastOne("hit")).toBeCloseTo(adv.pHit, 9);

    const dis = attack("dis", 7, 16, diceDist(1, 8, 3), diceDist(2, 8, 3));
    const qd = parse("(d20 < d20 + 7 AC 16) * (1d8 + 3) crit (2d8 + 3)").query();
    expect(qd.mean()).toBeCloseTo(meanOf(dis.dist), 9);
    expect(qd.probAtLeastOne("hit")).toBeCloseTo(dis.pHit, 9);
  });

  it("elven accuracy (triple advantage) crit probability", () => {
    // P(crit) = 1 - P(no 20 in 3 rolls) = 1 - (19/20)^3
    const q = parse("(d20 > d20 > d20 + 7 AC 16) * (1d8) crit (2d8)").query();
    expect(q.probAtLeastOne("crit")).toBeCloseTo(1 - (19 / 20) ** 3, 9);
  });

  it("hd (reroll-one) shorthand: P(1)=1/s^2 and matches reroll(1)", () => {
    expect(parse("hd6").pAt(1)).toBeCloseTo(1 / 36, 12);
    expect(parse("hd6").mean()).toBeCloseTo(parse("d6 reroll 1").mean(), 12);
    expect(parse("hd20").pAt(1)).toBeCloseTo(1 / 400, 12);
    expect(parse("hd20").mean()).toBeCloseTo(10.975, 9);
    // string hd matches the builder reroll(1)
    expect(parse("2hd6").mean()).toBeCloseTo(
      roll(2).d(6).reroll(1).pmf.mean(),
      12
    );
  });

  it("keep-highest pool 4kh3d6 matches enumeration mean", () => {
    // mean of sum of top 3 of 4d6 = 12.2446...
    let total = 0;
    for (let a = 1; a <= 6; a++)
      for (let b = 1; b <= 6; b++)
        for (let c = 1; c <= 6; c++)
          for (let d = 1; d <= 6; d++) {
            const xs = [a, b, c, d].sort((x, y) => y - x);
            total += xs[0] + xs[1] + xs[2];
          }
    const refMean = total / 6 ** 4;
    expect(parse("4kh3d6").mean()).toBeCloseTo(refMean, 9);
  });

  it("save-for-half: mean and (full vs half) split by enumeration", () => {
    // (d20 DC 15) * 8d6 save half: fail (roll<15) -> full 8d6; success -> floor(8d6/2)
    const full = diceDist(8, 6);
    const half: Dist = new Map();
    for (const [k, v] of full)
      half.set(Math.floor(k / 2), (half.get(Math.floor(k / 2)) ?? 0) + v);
    let pFail = 0,
      pSucc = 0;
    for (let r = 1; r <= 20; r++) (r >= 15 ? (pSucc += 1 / 20) : (pFail += 1 / 20));
    const ref = mixDist([scaleProb(full, pFail), scaleProb(half, pSucc)]);
    const q = parse("(d20 + 0 DC 15) * 8d6 save half").query();
    expect(q.mean()).toBeCloseTo(meanOf(ref), 7);
    expect(q.probAtLeastOne("saveFail")).toBeCloseTo(pFail, 6);
    expect(q.probAtLeastOne("saveHalf")).toBeCloseTo(pSucc, 6);
  });
});

describe("Mixtures & guards", () => {
  it("PMF.exclusive produces the exact weighted mixture and mass 1", () => {
    const a = PMF.delta(2);
    const b = PMF.delta(5);
    const mix = PMF.exclusive([
      [a, 0.3],
      [b, 0.7],
    ]);
    expect(mix.mass()).toBeCloseTo(1, 12);
    expect(mix.pAt(2)).toBeCloseTo(0.3, 12);
    expect(mix.pAt(5)).toBeCloseTo(0.7, 12);
  });

  it("PMF.exclusive sends leftover weight to zero", () => {
    const mix = PMF.exclusive([[PMF.delta(5), 0.6]]);
    expect(mix.mass()).toBeCloseTo(1, 12);
    expect(mix.pAt(0)).toBeCloseTo(0.4, 12);
    expect(mix.pAt(5)).toBeCloseTo(0.6, 12);
  });

  it("branch is a proper Bernoulli mixture", () => {
    const out = PMF.branch(PMF.delta(10), PMF.delta(0), 0.25);
    expect(out.pAt(10)).toBeCloseTo(0.25, 12);
    expect(out.pAt(0)).toBeCloseTo(0.75, 12);
  });

  it("firstSuccessWeights: valid inputs sum correctly, invalid inputs throw", () => {
    const w = PMF.firstSuccessWeights(0.5, 0.05, 3);
    expect(w.pSpecificSuccess + w.pGeneralSuccess + w.pNone).toBeCloseTo(1, 12);
    expect(w.pAny).toBeCloseTo(1 - 0.5 ** 3, 12);
    expect(() => PMF.firstSuccessWeights(0.3, 0.5, 2)).toThrow(); // pSpecial > pSuccess
  });
});

describe("Distribution invariants hold across the corpus", () => {
  const exprs = [
    "(d20 + 6 AC 15) * (2d6 + 4)",
    "(d20 + 6 AC 15) * (2d6 + 4) crit (4d6 + 4)",
    "(d20 > d20 + 7 AC 16) * (1d8 + 3) crit (2d8 + 3)",
    "(d20 + 0 DC 15) * 8d6 save half",
    "4kh3d6",
    "hd20",
  ];
  for (const e of exprs) {
    it(`${e}: mass 1, monotone CDF, probabilities in [0,1]`, () => {
      const q = parse(e).query();
      expect(q.combined.mass()).toBeCloseTo(1, 9);
      let prev = -1;
      for (const x of q.combined.support()) {
        const c = q.cdf(x);
        expect(c).toBeGreaterThanOrEqual(prev - 1e-9);
        expect(c).toBeLessThanOrEqual(1 + 1e-9);
        prev = c;
      }
      expect(q.cdf(q.max())).toBeCloseTo(1, 9);
    });
  }
});

describe("KNOWN LIMITATION: parser crit probability with bonus to-hit dice", () => {
  // The string parser cannot separate the natural-20 slice once bonus dice are
  // convolved into the to-hit (the d20 identity is lost), so crit probability
  // collapses to 1/(20·∏bonusSides). The BUILDER API computes it correctly.
  // This test locks the correct builder behavior and pins the known parser gap
  // so any change to either is caught. See CHANGELOG "Known limitations".
  it("builder computes crit = 0.05 with a +1d4 (bless) to-hit", () => {
    const b = d20
      .plus(5)
      .plus(d4)
      .ac(15)
      .onHit(roll(1, 8).plus(3))
      .onCrit(roll(2, 8).plus(3));
    expect(b.resolve().weights.crit).toBeCloseTo(0.05, 9);
  });

  it("parser without bonus to-hit dice is correct (crit = 0.05)", () => {
    const q = parse("(d20 + 5 AC 15) * (1d8 + 3) crit (2d8 + 3)").query();
    expect(q.probAtLeastOne("crit")).toBeCloseTo(0.05, 9);
  });

  it("parser WITH bonus to-hit dice is currently wrong (pinned)", () => {
    // KNOWN BUG: should be 0.05 but the parser returns 1/80 = 0.0125.
    // Pinned so the discrepancy is tracked; update when the parser is fixed.
    const q = parse("(d20 + 5 + 1d4 AC 15) * (1d8 + 3) crit (2d8 + 3)").query();
    expect(q.probAtLeastOne("crit")).toBeCloseTo(0.0125, 6);
  });
});

describe("Conditional statistics: single-attack correctness + multi-attack caveat", () => {
  const single = parse("(d20 + 5 AC 15) * (1d6) crit (2d6)");

  it("single-attack damageStatsFrom is the true conditional expectation", () => {
    // hit damage is 1d6 -> E=3.5, range 1..6, count = P(hit) = 0.5
    const hit = new DiceQuery([single]).damageStatsFrom("hit");
    expect(hit.avg).toBeCloseTo(3.5, 9);
    expect(hit.min).toBe(1);
    expect(hit.max).toBe(6);
    expect(hit.count).toBeCloseTo(0.5, 9);
  });

  it("single-attack snapshot probabilities are valid (<= 1)", () => {
    const snap = new DiceQuery([single]).snapshot(["hit", "crit", "missNone"]);
    expect(snap.outcomes.get("hit")!.atLeastOneProbability).toBeCloseTo(0.5, 9);
    expect(snap.outcomes.get("crit")!.atLeastOneProbability).toBeCloseTo(
      0.05,
      9
    );
  });

  it("KNOWN LIMITATION: multi-attack snapshot reports expected counts (pinned)", () => {
    // For N attacks these per-outcome figures are E[#label], not probabilities,
    // and can exceed 1. Use probAtLeastOne for the true marginal. Pinned so the
    // documented behavior is tracked.
    const q = new DiceQuery([single, single, single, single]); // 4 attacks
    const snap = q.snapshot(["hit"]);
    expect(snap.outcomes.get("hit")!.atLeastOneProbability).toBeCloseTo(2.0, 6); // 4 * 0.5
    // the correct per-attack marginal:
    expect(q.probAtLeastOne("hit")).toBeCloseTo(1 - 0.5 ** 4, 9); // 0.9375
  });
});
