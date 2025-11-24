import { beforeEach } from "node:test";
import { describe, expect, it } from "vitest";
import { EPS } from "../src/common/types";
import { DiceQuery, parse, PMF } from "../src/index";

const attackExpr = "(d20 + 8 AC 16) * (1d8 + 4) crit (2d8 + 4)";

// --- tolerant comparison helper (use instead of strict .toEqual on floats) ---
function expectSeriesClose(a: any[], b: any[], eps = EPS) {
  const sa = [...a].sort((u, v) => u.x - v.x);
  const sb = [...b].sort((u, v) => u.x - v.x);
  expect(sa.length).toBe(sb.length);
  for (let i = 0; i < sa.length; i++) {
    expect(sa[i].x).toBe(sb[i].x);
    expect(Math.abs(sa[i].y - sb[i].y)).toBeLessThanOrEqual(eps);
  }
}
const seriesOf = (pmf: PMF) => new DiceQuery([pmf]).toChartSeries();

// Optional cache resets if you have them
beforeEach(() => {
  (PMF as any)._clearParseCache?.();
  (PMF as any)._clearInternals?.();
  (DiceQuery as any)._clearInternals?.();
});

/* -------------------------------------------------------------------------- */
/*                             PMF.withProbability                             */
/* -------------------------------------------------------------------------- */

describe("PMF.withProbability", () => {
  it("builds a proper Bernoulli mixture: payload with p, zero with 1-p", () => {
    const payload = parse("3d6"); // mean 10.5
    const p = 0.37;

    const gated = PMF.withProbability(payload, p);
    const q = new DiceQuery([gated]);

    // Mass is 1 (proper mixture)
    expect(q.totalMass()).toBeCloseTo(1, 12);

    // Mean scales linearly by p
    expect(q.mean()).toBeCloseTo(10.5 * p, 12);

    // Label probabilities scale linearly too
    const atk = parse(attackExpr);
    const pAny = new DiceQuery([atk]).probAtLeastOne(["hit", "crit"]);
    const gatedAtk = PMF.withProbability(atk, p);
    expect(
      new DiceQuery([gatedAtk]).probAtLeastOne(["hit", "crit"])
    ).toBeCloseTo(p * pAny, 12);
  });

  it("is equivalent to gate(p, PMF.zero()) and branch(payload, zero, p)", () => {
    const payload = parse("2d8");
    const p = 0.6;

    const a = PMF.withProbability(payload, p);
    const b = (payload as any).gate
      ? (payload as any).gate(p, PMF.zero())
      : PMF.branch(payload, PMF.zero(), p);
    const qa = new DiceQuery([a]);
    const qb = new DiceQuery([b]);

    expect(qa.mean()).toBeCloseTo(qb.mean(), 12);
    expectSeriesClose(qa.toChartSeries(), qb.toChartSeries(), EPS);
  });

  it("p=0 returns zero PMF; p=1 returns the payload distribution", () => {
    const payload = parse("1d6");
    const z = PMF.withProbability(payload, 0);
    const o = PMF.withProbability(payload, 1);

    expectSeriesClose(seriesOf(z), seriesOf(PMF.zero()), EPS);
    expectSeriesClose(seriesOf(o), seriesOf(payload), EPS);
  });

  it("does not mutate the payload PMF", () => {
    const payload = parse("3d6");
    const snap = seriesOf(payload);
    PMF.withProbability(payload, 0.25);
    expect(seriesOf(payload)).toEqual(snap);
  });

  it("composes correctly in a DiceQuery with independent contributors", () => {
    const atk = parse(attackExpr);
    const pOA = 0.25;
    const oa = PMF.withProbability(atk, pOA);
    const q = new DiceQuery([atk, atk, oa]);

    // sanity: mass 1
    expect(q.totalMass()).toBeCloseTo(1, 12);

    // OA mean contributes linearly
    const singleMean = new DiceQuery([atk]).mean(); // 5.75 with the example attack
    expect(new DiceQuery([oa]).mean()).toBeCloseTo(pOA * singleMean, 12);
  });
});

/* -------------------------------------------------------------------------- */
/*                               PMF.exclusive                                */
/* -------------------------------------------------------------------------- */

describe("PMF.exclusive", () => {
  it("builds an exclusive mixture and auto-adds the zero branch", () => {
    const a = parse("3d6"); // mean 10.5
    const b = parse("6d6"); // mean 21

    // sum 0.5 → zero gets 0.5
    const wA = 0.3;
    const wB = 0.2;

    const ex = PMF.exclusive([
      [a, wA],
      [b, wB],
    ]);

    const q = new DiceQuery([ex]);

    // Mass is 1, and mean is weighted mean
    const expectedMean = 10.5 * wA + 21 * wB + 0 * (1 - (wA + wB));
    expect(q.mean()).toBeCloseTo(expectedMean, 12);
    expect(q.totalMass()).toBeCloseTo(1, 12);
  });

  it("throws if weights sum to > 1", () => {
    const a = parse("1d6");
    const b = parse("1d8");
    expect(() =>
      PMF.exclusive([
        [a, 0.6],
        [b, 0.5],
      ])
    ).toThrow();
  });

  it("is identical to withProbability when only one option provided", () => {
    const payload = parse("3d6");
    const p = 0.37;
    const ex = PMF.exclusive([[payload, p]]);
    const wp = PMF.withProbability(payload, p);

    const qe = new DiceQuery([ex]);
    const qw = new DiceQuery([wp]);
    expect(qe.mean()).toBeCloseTo(qw.mean(), 12);
    expectSeriesClose(qe.toChartSeries(), qw.toChartSeries(), EPS);
  });

  it("does not mutate the input PMFs", () => {
    const a = parse("1d6");
    const b = parse("1d4");
    const snapA = seriesOf(a);
    const snapB = seriesOf(b);

    PMF.exclusive([
      { pmf: a, weight: 0.4 },
      { pmf: b, weight: 0.6 },
    ]);

    expect(seriesOf(a)).toEqual(snapA);
    expect(seriesOf(b)).toEqual(snapB);
  });

  it("order-independent: reordering options yields the same distribution", () => {
    const three = parse("3d6");
    const six = parse("6d6");

    const e1 = PMF.exclusive([
      { pmf: three, weight: 0.8 },
      { pmf: six, weight: 0.1 },
    ]);
    const e2 = PMF.exclusive([
      { pmf: six, weight: 0.1 },
      { pmf: three, weight: 0.8 },
    ]);

    const q1 = new DiceQuery([e1]);
    const q2 = new DiceQuery([e2]);

    expect(q1.mean()).toBeCloseTo(q2.mean(), 12);
    expectSeriesClose(q1.toChartSeries(), q2.toChartSeries(), EPS);
  });

  it("collapses correctly when two branches share the same payload", () => {
    const payload = parse("3d6");
    const w1 = 0.2,
      w2 = 0.5;
    const ex = PMF.exclusive([
      { pmf: payload, weight: w1 },
      { pmf: payload, weight: w2 },
    ]);
    const simple = PMF.withProbability(payload, w1 + w2);

    expectSeriesClose(seriesOf(ex), seriesOf(simple), EPS);
    expect(new DiceQuery([ex]).mean()).toBeCloseTo(
      new DiceQuery([simple]).mean(),
      12
    );
  });

  it("works seamlessly in a full round with independent base attacks", () => {
    const atk = parse(attackExpr);
    const per = new DiceQuery([atk]);
    const pH = per.probAtLeastOne(["hit", "crit"]);
    const pC = per.probAtLeastOne(["crit"]);
    const pFirstCrit = pC * (2 - pH);
    const pFirstNonCrit = (pH - pC) * (2 - pH);

    const sneak = PMF.exclusive([
      [parse("6d6"), pFirstCrit],
      [parse("3d6"), pFirstNonCrit],
    ]);

    const turn = new DiceQuery([atk, atk, sneak]);
    expect(turn.totalMass()).toBeCloseTo(1, 12);
    expect(turn.mean()).toBeGreaterThan(0); // sanity
  });
});

/* -------------------------------------------------------------------------- */
/*                        Property / fuzz (optional, fast)                    */
/* -------------------------------------------------------------------------- */

describe("Property tests", () => {
  it("withProbability and exclusive conserve bounds & mass over random weights", () => {
    const payload = parse("2d6");
    for (let i = 0; i < 100; i++) {
      const p = Math.random();
      const a = PMF.withProbability(payload, p);
      const qa = new DiceQuery([a]);
      expect(qa.totalMass()).toBeCloseTo(1, 12);
      expect(qa.mean()).toBeGreaterThanOrEqual(0);

      const w1 = Math.random();
      const w2 = Math.random() * (1 - w1);
      const ex = PMF.exclusive([
        { pmf: payload, weight: w1 },
        { pmf: parse("1d4"), weight: w2 },
      ]);
      const qe = new DiceQuery([ex]);
      expect(qe.totalMass()).toBeCloseTo(1, 12);
    }
  });

  it("exclusive returns non-zero mean when weights > 0", () => {
    const a = parse("3d6"); // 10.5
    const ex = PMF.exclusive([[a, 0.5]]);
    expect(new DiceQuery([ex]).mean()).toBeGreaterThan(0); // would've been 0 if not reassigned
  });
});
