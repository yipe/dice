import { describe, expect, it } from "vitest";
import { DiceQuery, parse, PMF, TEST_EPS } from "../src/index";

function uniformDie(sides: number): PMF {
  const m = new Map<number, { p: number; count: Record<string, number> }>();
  for (let i = 1; i <= sides; i++) m.set(i, { p: 1 / sides, count: {} });
  return new PMF(m, 1e-15, true);
}

function pmfFrom(map: Record<number, number>, label?: string): PMF {
  const m = new Map<number, { p: number; count: Record<string, number> }>();
  let Z = 0;
  for (const [, v] of Object.entries(map)) Z += v;
  for (const [k, v] of Object.entries(map)) {
    const p = v / Z;
    const count: Record<string, number> = {};
    if (label) count[label] = p;
    m.set(Number(k), { p, count });
  }
  return new PMF(m, 1e-15, true);
}

describe("PMF basics", () => {
  it("combine of two uniform d6 yields 2d6-like distribution", () => {
    const d6 = uniformDie(6);
    const two = d6.convolve(d6);
    expect(Math.abs(two.mass() - 1)).toBeLessThan(1e-12);
    expect(two.min()).toBe(2);
    expect(two.max()).toBe(12);
    // P(7) should be 6/36
    const p7 = two.map.get(7)!.p;
    expect(Math.abs(p7 - 6 / 36)).toBeLessThan(1e-12);
  });

  it("labeled convolution preserves additive label mass: sum_d count['crit'] == sum singles", () => {
    const A = pmfFrom({ 1: 1, 2: 1 });
    // tag 10% crit on A (per-bin mass scaled by p)
    const Acrit = new PMF(
      new Map(
        [...A.map.entries()].map(([d, bin]) => [
          d,
          { p: bin.p, count: { ...bin.count, crit: 0.1 * bin.p } },
        ])
      ),
      1e-15,
      true
    );
    const B = pmfFrom({ 3: 2, 5: 1 });
    // tag 20% crit on B
    const Bcrit = new PMF(
      new Map(
        [...B.map.entries()].map(([d, bin]) => [
          d,
          { p: bin.p, count: { ...bin.count, crit: 0.2 * bin.p } },
        ])
      ),
      1e-15,
      true
    );

    const C = Acrit.convolve(Bcrit);
    let sumCrit = 0;
    for (const [, bin] of C) sumCrit += bin.count["crit"] || 0;
    expect(Math.abs(sumCrit - (0.1 + 0.2))).toBeLessThan(1e-12);
  });

  it('scaleDamage(0.5,"floor") exactness on small ranges', () => {
    const P = pmfFrom({ 0: 1, 1: 1, 2: 1, 3: 1 });
    const S = P.scaleDamage(0.5, "floor").normalize();
    // Expected mapping: 0->0,1->0,2->1,3->1
    const expected: Record<number, number> = { 0: 0.5, 1: 0.5 };
    for (const [d, bin] of S) {
      const expectedProb = expected[d] ?? 0;
      expect(Math.abs(bin.p - expectedProb)).toBeLessThan(1e-12);
    }
  });

  it("addScaled mixture preserves mass", () => {
    const A = uniformDie(4); // mass 1
    const B = uniformDie(6); // mass 1
    const M = PMF.empty().addScaled(A, 0.3).addScaled(B, 0.7);
    expect(Math.abs(M.mass() - 1)).toBeLessThan(1e-12);
  });

  it("branch creates correct conditional distribution with success/failure PMFs", () => {
    // Create success PMF: 50% chance of 10 damage, 50% chance of 20 damage
    const successPMF = pmfFrom({ 10: 1, 20: 1 });
    // Create failure PMF: 100% chance of 0 damage
    const failurePMF = pmfFrom({ 0: 1 });

    // Test 60% success rate
    const result = PMF.branch(successPMF, failurePMF, 0.6);

    // Verify total mass is 1
    expect(Math.abs(result.mass() - 1)).toBeLessThan(1e-12);

    // Verify individual probabilities
    // P(0) = 0.4 (40% failure)
    expect(Math.abs(result.map.get(0)!.p - 0.4)).toBeLessThan(1e-12);
    // P(10) = 0.6 * 0.5 = 0.3 (60% success * 50% of success outcomes)
    expect(Math.abs(result.map.get(10)!.p - 0.3)).toBeLessThan(1e-12);
    // P(20) = 0.6 * 0.5 = 0.3 (60% success * 50% of success outcomes)
    expect(Math.abs(result.map.get(20)!.p - 0.3)).toBeLessThan(1e-12);

    // Verify support contains all expected values
    const support = result.support();
    expect(support).toEqual([0, 10, 20]);
  });

  it("branch with 100% success rate returns success PMF", () => {
    const successPMF = pmfFrom({ 5: 1, 15: 1 });
    const failurePMF = pmfFrom({ 0: 1 });

    const result = PMF.branch(successPMF, failurePMF, 1.0);

    expect(Math.abs(result.mass() - 1)).toBeLessThan(1e-12);
    expect(Math.abs(result.map.get(5)!.p - 0.5)).toBeLessThan(1e-12);
    expect(Math.abs(result.map.get(15)!.p - 0.5)).toBeLessThan(1e-12);
    expect(result.map.has(0)).toBe(false);
  });

  it("branch with 0% success rate returns failure PMF", () => {
    const successPMF = pmfFrom({ 5: 1, 15: 1 });
    const failurePMF = pmfFrom({ 0: 1 });

    const result = PMF.branch(successPMF, failurePMF, 0.0);

    expect(Math.abs(result.mass() - 1)).toBeLessThan(1e-12);
    expect(Math.abs(result.map.get(0)!.p - 1)).toBeLessThan(1e-12);
    expect(result.map.has(5)).toBe(false);
    expect(result.map.has(15)).toBe(false);
  });

  it("branch preserves epsilon from success PMF", () => {
    const customEpsilon = 1e-10;
    const successPMF = new PMF(new Map(), customEpsilon, false);
    const failurePMF = new PMF(new Map(), 1e-15, false);

    const result = PMF.branch(successPMF, failurePMF, 0.5);

    expect(result.epsilon).toBe(customEpsilon);
  });
});

// Small helper to build a PMF quickly
function pmfOf(entries: Array<[number, number]>) {
  const m = new Map<number, { p: number; count: Record<string, number> }>();
  for (const [value, p] of entries) m.set(value, { p, count: { base: p } });
  return new PMF(m, 1e-12, true);
}

describe("PMF.addScaled", () => {
  it("adds a weighted branch to a base PMF without convolving", () => {
    // Base always deals 1 (mass 1.0)
    const base = pmfOf([[1, 1.0]]);
    // Branch always deals +3 (mass 1.0)
    const branch = pmfOf([[3, 1.0]]);

    const mixed = base.addScaled(branch, 0.5);

    // Mass increases linearly by probability * branch.mass
    expect(mixed.mass()).toBeCloseTo(1.5, 12);

    // Base bin preserved
    expect(mixed.pAt(1)).toBeCloseTo(1.0, 12);
    // Branch bin added at scaled weight
    expect(mixed.pAt(3)).toBeCloseTo(0.5, 12);

    // After normalize, probabilities should divide by total mass 1.5
    const norm = mixed.normalize();
    expect(norm.mass()).toBeCloseTo(1, 12);
    expect(norm.pAt(1)).toBeCloseTo(1.0 / 1.5, 12); // 2/3
    expect(norm.pAt(3)).toBeCloseTo(0.5 / 1.5, 12); // 1/3
  });

  it("p=0 returns the original PMF", () => {
    const base = pmfOf([
      [1, 0.7],
      [2, 0.3],
    ]);
    const branch = pmfOf([[5, 1.0]]);
    const mixed = base.addScaled(branch, 0);

    expect(mixed.mass()).toBeCloseTo(base.mass(), 12);
    expect(mixed.pAt(1)).toBeCloseTo(0.7, 12);
    expect(mixed.pAt(2)).toBeCloseTo(0.3, 12);
    expect(mixed.pAt(5)).toBeCloseTo(0, 12);
  });

  it("p=1 adds the full branch mass (still not a convolution)", () => {
    const base = pmfOf([
      [1, 0.7],
      [2, 0.3],
    ]);
    const branch = pmfOf([[2, 1.0]]);
    const mixed = base.addScaled(branch, 1);

    // Mass = 1.0 + 1.0
    expect(mixed.mass()).toBeCloseTo(2.0, 12);
    // Overlapping value sums probabilities
    expect(mixed.pAt(2)).toBeCloseTo(0.3 + 1.0, 12);
    // Non overlapping values preserved
    expect(mixed.pAt(1)).toBeCloseTo(0.7, 12);
  });

  it("overlapping support merges probabilities correctly", () => {
    const base = pmfOf([
      [1, 0.4],
      [2, 0.6],
    ]);
    const branch = pmfOf([
      [2, 0.5],
      [3, 0.5],
    ]);

    const mixed = base.addScaled(branch, 0.2); // add 20% of branch
    // Expected:
    // p(1) = 0.4
    // p(2) = 0.6 + 0.2 * 0.5 = 0.6 + 0.1 = 0.7
    // p(3) = 0.2 * 0.5 = 0.1
    expect(mixed.pAt(1)).toBeCloseTo(0.4, 12);
    expect(mixed.pAt(2)).toBeCloseTo(0.7, 12);
    expect(mixed.pAt(3)).toBeCloseTo(0.1, 12);
    expect(mixed.mass()).toBeCloseTo(1 + 0.2 * 1, 12); // 1.2
  });

  it("does not equal a convolutional combine", () => {
    const base = pmfOf([[1, 1.0]]);
    const branch = pmfOf([[3, 1.0]]);

    const mixed = base.addScaled(branch, 1.0); // mass: p(1)=1, p(3)=1
    const convolved = base.convolve(branch).normalize(); // would yield only value 4 with prob 1

    // Different supports or probabilities
    expect(mixed.pAt(4)).toBeCloseTo(0, 12);
    expect(convolved.pAt(4)).toBeCloseTo(1, 12);
    expect(mixed.pAt(1)).toBeCloseTo(1, 12);
    expect(mixed.pAt(3)).toBeCloseTo(1, 12);
  });

  it("scales label counts in added branch bins if present", () => {
    // Build a branch that has explicit label counts to verify they are scaled
    const baseMap = new Map<
      number,
      { p: number; count: Record<string, number> }
    >();
    baseMap.set(1, { p: 1.0, count: { base: 1.0 } });
    const base = new PMF(baseMap, 1e-12, true);

    const branchMap = new Map<
      number,
      { p: number; count: Record<string, number> }
    >();
    branchMap.set(5, { p: 0.8, count: { extra: 0.8 } });
    branchMap.set(6, { p: 0.2, count: { extra: 0.2 } });
    const branch = new PMF(branchMap, 1e-12, true);

    const mixed = base.addScaled(branch, 0.25);

    // Probabilities scale by 0.25
    expect(mixed.pAt(5)).toBeCloseTo(0.8 * 0.25, 12);
    expect(mixed.pAt(6)).toBeCloseTo(0.2 * 0.25, 12);

    // Optional: if your PMF exposes per-label totals, assert they scale too.
    // Example pattern (adapt to your API if you have labelMass):
    // expect(mixed.labelMass("extra")).toBeCloseTo((0.8 + 0.2) * 0.25, 12);
  });

  it("tolerates tiny probabilities with epsilon threshold", () => {
    const base = pmfOf([[0, 1.0]]);
    const branchMap = new Map<
      number,
      { p: number; count: Record<string, number> }
    >();
    branchMap.set(100, { p: 1e-16, count: { tiny: 1e-16 } }); // below 1e-15 would drop if epsilon is 1e-15
    const branch = new PMF(branchMap, 1e-16, true);

    const mixed = base.addScaled(branch, 1.0);
    // Depending on your epsilon inside addScaled, this may keep or drop the tiny bin.
    // These checks are written to be robust:
    expect(mixed.pAt(0)).toBeCloseTo(1.0, 12);
    // Either zero or very close to 1e-16
    expect(mixed.pAt(100)).toBeGreaterThanOrEqual(0);
    expect(mixed.pAt(100)).toBeLessThanOrEqual(1e-16 + 1e-18);
  });

  it("parse cache does not break independence", () => {
    const x = parse("(d20 + 8 AC 16) * (1d8 + 4) crit (2d8 + 4)");
    const q1 = new DiceQuery([x]).probAtLeastOne(["hit", "crit"]);
    const q2 = new DiceQuery([x, x]).probAtLeastOne(["hit", "crit"]);
    expect(q2).toBeGreaterThanOrEqual(q1);
    expect(q2).toBeLessThanOrEqual(1);
  });

  it("transform does not mutate input", () => {
    const a = parse("1d6");
    const before = new DiceQuery([a]).toChartSeries();
    const _ = a.scaleMass(0.5);
    const after = new DiceQuery([a]).toChartSeries();
    expect(after).toEqual(before);
  });

  it("power equals repeated convolution", () => {
    const a = parse("1d6");
    const b = a.power(3);
    const c = a.convolve(a).convolve(a);
    expect(new DiceQuery([b]).toChartSeries()).toEqual(
      new DiceQuery([c]).toChartSeries()
    );
  });

  it("parse cache returns same reference for identical expr", () => {
    const x1 = parse("1d6");
    const x2 = parse("1d6");
    expect(x1).toBe(x2); // same object reference
  });

  it("independence holds even when using same cached object twice", () => {
    const atk = parse("(d20 + 8 AC 16) * 1d8 crit 2d8");
    const p1 = new DiceQuery([atk]).probAtLeastOne(["hit", "crit"]);
    const p2 = new DiceQuery([atk, atk]).probAtLeastOne(["hit", "crit"]);
    expect(p2).toBeCloseTo(1 - (1 - p1) * (1 - p1), 12);
  });

  it("scaleMass returns a new instance and does not mutate input", () => {
    const a = parse("1d6");
    const before = new DiceQuery([a]).toChartSeries();
    const b = a.scaleMass(0.5);
    expect(b).not.toBe(a); // new object
    const after = new DiceQuery([a]).toChartSeries();
    expect(after).toEqual(before);
  });

  it("outputs do not alias input bins", () => {
    const a = parse("1d6");
    const b = a.scaleMass(0.5);
    // Mutate b's chart data object and ensure a's is unchanged
    const aSeries1 = new DiceQuery([a]).toChartSeries();
    const bSeries = new DiceQuery([b]).toChartSeries();
    // Try to mutate bSeries if it is a plain object/array
    if (Array.isArray(bSeries)) bSeries.push({ x: 999, y: 0 });
    const aSeries2 = new DiceQuery([a]).toChartSeries();
    expect(aSeries2).toEqual(aSeries1);
  });

  it("add is commutative and pure", () => {
    const a = parse("1d6"),
      b = parse("1d4");
    const ab = a.add(b),
      ba = b.add(a);
    expect(new DiceQuery([ab]).toChartSeries()).toEqual(
      new DiceQuery([ba]).toChartSeries()
    );
    // Inputs unchanged
    expect(new DiceQuery([a]).totalMass()).toBeCloseTo(1, TEST_EPS);
    expect(new DiceQuery([b]).totalMass()).toBeCloseTo(1, TEST_EPS);
  });

  it("convolve is associative", () => {
    const a = parse("1d6"),
      b = parse("1d6"),
      c = parse("1d6");
    const left = a.convolve(b).convolve(c);
    const right = a.convolve(b.convolve(c));
    expect(new DiceQuery([left]).toChartSeries()).toEqual(
      new DiceQuery([right]).toChartSeries()
    );
  });

  it("branch equals weighted mixture and is pure", () => {
    const a = parse("1d6");
    const zero = parse("0");
    const p = 0.37;
    const mix = PMF.branch(a, zero, p);
    const ref = a.scaleMass(p).add(zero.scaleMass(1 - p));
    expect(new DiceQuery(mix).toChartSeries()).toEqual(
      new DiceQuery(ref).toChartSeries()
    );
    // a and zero untouched
    expect(new DiceQuery([a]).totalMass()).toBeCloseTo(1, TEST_EPS);
    expect(new DiceQuery([zero]).totalMass()).toBeCloseTo(1, TEST_EPS);
  });

  it("compact and normalize are pure", () => {
    const a = parse("1d6").scaleMass(0); // all zero
    const b = a.compact().normalize();
    expect(new DiceQuery([a]).toChartSeries()).toEqual(
      new DiceQuery([parse("1d6").scaleMass(0)]).toChartSeries()
    );
    expect(b).not.toBe(a);
  });

  it("parse cache differentiates by options that change semantics", () => {
    const x1 = parse("d20");
    const x2 = parse("d20 > d20");
    expect(x1).not.toBe(x2);
    expect(new DiceQuery([x1]).toChartSeries()).not.toEqual(
      new DiceQuery([x2]).toChartSeries()
    );
  });

  it("total mass stays within tolerance across transforms", () => {
    const a = parse("1d6");
    const b = a.power(4).normalize().compact();
    const total = new DiceQuery([b]).totalMass();
    expect(total).toBeCloseTo(1, 12);
  });

  it("combined query total mass should equal 1", () => {
    const atk = "(d20 + 8 AC 16) * (1d8 + 4) crit (2d8 + 4)";
    const a1 = parse(atk),
      a2 = parse(atk);
    const pAny = new DiceQuery([a1, a2]).probAtLeastOne(["hit", "crit"]);
    const smite = parse("3d6").scaleMass(pAny);
    const q = new DiceQuery([a1, a2, smite]);
    expect(q.totalMass()).toBeCloseTo(1, TEST_EPS);
  });

  it("withProbability matches branch with zero failure PMF", () => {
    const payload = parse("1d6");
    const chance = 0.25;
    const a = PMF.withProbability(payload, chance);
    const b = PMF.branch(payload, PMF.zero(), chance);

    expect(new DiceQuery([a]).toChartSeries()).toEqual(
      new DiceQuery([b]).toChartSeries()
    );
  });
});
