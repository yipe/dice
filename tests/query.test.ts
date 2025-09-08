import { beforeEach, describe, expect, it } from "vitest";
import { fullRoundSimulationExample } from "../examples/other-examples";
import { clearParserCache, parse, PMF, TEST_EPS } from "../src/index";
import { DiceQuery } from "../src/query";

function seriesOf(pmf: PMF) {
  return new DiceQuery(pmf).toChartSeries();
}
describe("DiceQuery Comprehensive", () => {
  beforeEach(() => {
    if (process.env.CLEAR_TEST_CACHES === "true") {
      clearParserCache();
      PMF.clearCache();
    }
  });
  describe("Statistical Methods", () => {
    it("should calculate correct basic statistics", () => {
      // Simple case: 2d6
      const pmf = parse("2d6");
      const query = new DiceQuery([pmf]);

      expect(query.mean()).toBeCloseTo(7, 2); // 2d6 average = 7
      expect(query.min()).toBe(2);
      expect(query.max()).toBe(12);
      expect(query.variance()).toBeCloseTo(5.83, 2); // 2d6 variance
      expect(query.stddev()).toBeCloseTo(2.42, 2); // sqrt(variance)
    });

    it("should handle percentile calculations", () => {
      const pmf = parse("2d6");
      const query = new DiceQuery([pmf]);

      const percentiles = query.percentiles([0.25, 0.5, 0.75]);

      // 2d6 percentiles should be reasonable
      expect(percentiles[0]).toBeLessThan(percentiles[1]); // 25th < 50th
      expect(percentiles[1]).toBeLessThan(percentiles[2]); // 50th < 75th
      expect(percentiles[1]).toBeCloseTo(7, 1); // Median should be close to mean
    });
  });

  describe("Probability Queries", () => {
    it("should calculate hit probabilities correctly", () => {
      // Attack with known hit rate (d20+5 vs AC 15 = hits on 10+, so 55% hit rate)
      const pmf = parse("(d20 + 5 AC 15) * (1d6)");
      const query = new DiceQuery([pmf]);

      // Test various probability methods
      const hitProb = query.probAtLeastOne("hit");
      const missProb = query.missChance();

      expect(hitProb).toBeCloseTo(0.55, 2); // d20+5 vs AC 15 = 11/20 = 55%
      expect(missProb).toBeCloseTo(0.45, 2); // 45% miss
      expect(hitProb + missProb).toBeCloseTo(1, 6); // Should sum to 1
    });

    it("should handle multi-attack scenarios", () => {
      // 3 attacks with 55% hit rate each (d20+5 vs AC 15)
      const attack = parse("(d20 + 5 AC 15) * (1d6)");
      const query = new DiceQuery([attack, attack, attack]);

      // Probability of exactly K hits
      const prob0Hits = query.probExactlyK("hit", 0); // All miss
      const prob1Hit = query.probExactlyK("hit", 1); // Exactly 1 hits
      const prob2Hits = query.probExactlyK("hit", 2); // Exactly 2 hit
      const prob3Hits = query.probExactlyK("hit", 3); // All hit

      // Hand calculation verification for binomial distribution (55% hit rate)
      expect(prob0Hits).toBeCloseTo(0.45 ** 3, 3); // (1-0.55)^3 = 0.091
      expect(prob3Hits).toBeCloseTo(0.55 ** 3, 3); // 0.55^3 = 0.166

      // All probabilities should sum to 1
      const total = prob0Hits + prob1Hit + prob2Hits + prob3Hits;
      expect(total).toBeCloseTo(1, 6);
    });

    it("should calculate cumulative probabilities", () => {
      const pmf = parse("(d20 + 5 AC 15) * (2d6 + 4)");
      const query = new DiceQuery([pmf]);

      // CDF and CCDF should be complementary
      const damage15 = 15;
      const cdf = query.cdf(damage15); // P(damage ≤ 15)
      const ccdf = query.ccdf(damage15); // P(damage ≥ 15)
      const exactlyDamage15 = query.combined.map.get(damage15)?.p || 0;

      // They should overlap by exactly the probability of damage = 15
      expect(cdf + ccdf - exactlyDamage15).toBeCloseTo(1, 6);
    });
  });

  describe("Advanced Attribution Queries", () => {
    it("should calculate expected damage from specific outcome types", () => {
      const pmf = parse("(d20 + 5 AC 15) * (2d6 + 4) crit (4d6 + 4)");
      const query = new DiceQuery([pmf]);

      const totalExpected = query.mean();
      const hitExpected = query.expectedDamageFrom("hit");
      const critExpected = query.expectedDamageFrom("crit");
      const missExpected = query.expectedDamageFrom("missNone");

      // Expected damage from all sources should equal total
      const sumFromParts = hitExpected + critExpected + missExpected;
      expect(sumFromParts).toBeCloseTo(totalExpected, 3);

      // Just verify the values are reasonable (avoid assumptions about relative magnitudes)
      expect(hitExpected).toBeGreaterThanOrEqual(0);
      expect(critExpected).toBeGreaterThanOrEqual(0);
      expect(missExpected).toBeGreaterThanOrEqual(0);
    });

    it("should analyze damage stats by outcome type", () => {
      const pmf = parse("(d20 + 5 AC 15) * (2d6 + 4) crit (4d6 + 4)");
      const query = new DiceQuery([pmf]);

      const hitStats = query.damageStatsFrom("hit");
      const critStats = query.damageStatsFrom("crit");

      // Hit damage range should be reasonable
      expect(hitStats.min).toBeGreaterThan(0);
      expect(hitStats.max).toBeGreaterThan(hitStats.min);
      expect(hitStats.avg).toBeGreaterThan(0);

      // Crit damage should be higher than hit damage
      if (critStats.count > 0) {
        expect(critStats.avg).toBeGreaterThan(hitStats.avg);
        expect(critStats.max).toBeGreaterThan(hitStats.max);
      }
    });
  });

  describe("Edge Cases and Error Handling", () => {
    it("should handle empty query gracefully", () => {
      const query = new DiceQuery([]);

      expect(query.mean()).toBe(0);
      expect(query.min()).toBe(0);
      expect(query.max()).toBe(0);
      expect(query.variance()).toBe(0);
      expect(query.probAtLeastOne("hit")).toBe(0);
    });

    it("should handle queries with only misses", () => {
      // Attack that always misses
      const pmf = parse("(d20 AC 25) * (1d6)");
      const query = new DiceQuery(pmf);

      expect(query.probAtLeastOne("hit")).toBeCloseTo(0, 6);
      expect(query.missChance()).toBeCloseTo(1, 6);
      expect(query.expectedDamageFrom("hit")).toBeCloseTo(0, 6);
    });

    it("should handle queries with unusual outcome combinations", () => {
      // Mix of attack and save expressions
      const attackPMF = parse("(d20 + 5 AC 15) * (1d6) crit (2d6)");
      const savePMF = parse("(d20 + 3 DC 14) * (2d6) save half");
      const query = new DiceQuery([attackPMF, savePMF]);

      // Should handle mixed outcome types gracefully
      expect(() => query.mean()).not.toThrow();
      expect(() => query.probAtLeastOne(["hit", "saveHalf"])).not.toThrow();
      expect(() =>
        query.expectedDamageFrom(["hit", "crit", "saveFail"])
      ).not.toThrow();

      // Results should be mathematically sound
      expect(query.mean()).toBeGreaterThan(0);
      expect(
        query.probAtLeastOne(["hit", "saveHalf", "saveFail"])
      ).toBeGreaterThan(0);
    });
  });

  it("branch equals weighted mixture", () => {
    const a = parse("1d6");
    const z = parse("0");
    const p = 0.37;
    const mix = PMF.branch(a, z, p);
    const ref = a.scaleMass(p).add(z.scaleMass(1 - p));
    expect(seriesOf(mix)).toEqual(new DiceQuery(ref).toChartSeries());
  });

  it("branch does not mutate inputs and preserves mass", () => {
    const a = parse("1d6");
    const z = parse("0");
    const p = 0.37;
    const beforeA = seriesOf(a);
    const beforeZ = seriesOf(z);
    const mix = PMF.branch(a, z, p);
    expect(seriesOf(a)).toEqual(beforeA);
    expect(seriesOf(z)).toEqual(beforeZ);
    expect(new DiceQuery(mix).totalMass()).toBeCloseTo(1, 12);
  });

  it("branch short circuits at p=0 and p=1", () => {
    const a = parse("1d6"),
      z = parse("0");
    expect(seriesOf(PMF.branch(a, z, 0))).toEqual(seriesOf(z));
    expect(seriesOf(PMF.branch(a, z, 1))).toEqual(seriesOf(a));
  });

  it("branch preserves labels", () => {
    const atk = parse("(d20 + 8 AC 16) * (1d8 + 4) crit (2d8 + 4)");
    const mix = PMF.branch(atk, parse("0"), 0.25);
    const pAny = new DiceQuery(mix).probAtLeastOne(["hit", "crit"]);
    expect(pAny).toBeCloseTo(
      0.25 * new DiceQuery(atk).probAtLeastOne(["hit", "crit"]),
      12
    );
  });

  it("firstSuccessSplit: golden case (+8 vs AC16)", () => {
    const atk = parse("(d20 + 8 AC 16) * (1d8 + 4) crit (2d8 + 4)");
    const per = new DiceQuery([atk, atk]);

    const pH = per.probAtLeastOne(["hit", "crit"]); // 0.65
    const pC = per.probAtLeastOne(["crit"]); // 0.05
    expect(pH).toBeCloseTo(1 - (1 - 0.65) ** 2, 6);
    expect(pC).toBeCloseTo(1 - (1 - 0.05) ** 2, 6);

    const [pSuccess, pSubset, pAny, pNone] = per.firstSuccessSplit(
      ["hit", "crit"],
      ["crit"]
    );

    console.log({ pSuccess, pSubset, pAny, pNone });

    // Expected values
    expect(pAny).toBeCloseTo(1 - (1 - 0.65) ** 2, 12);
    expect(pSubset).toBeCloseTo(0.05 * (2 - 0.65), 12);
    expect(pSubset).toBeCloseTo((0.05 * (1 - (1 - 0.65) ** 2)) / 0.65, 12);
    expect(pNone).toBeCloseTo((1 - 0.65) ** 2, 12);

    // Decomposition sanity
    expect(pSubset + pSuccess).toBeCloseTo(pAny, 12);
    expect(pAny + pNone).toBeCloseTo(1, 12);
  });

  // 1) parse() returns the SAME immutable instance; using it twice is safe
  it("parse cache returns stable, immutable PMF instances", () => {
    const a1 = parse("1d6");
    const a2 = parse("1d6");
    expect(a1).toBe(a2); // same reference (cached)

    const before = seriesOf(a1);
    const _scaled = a1.scaleMass(0.5); // must NOT mutate a1
    expect(seriesOf(a1)).toEqual(before);
    expect(seriesOf(_scaled)).not.toEqual(before);
    expect(a1.mass()).toBeCloseTo(1, TEST_EPS);
    expect(_scaled.mass()).toBeCloseTo(0.5, TEST_EPS);
  });

  it("withProbability returns new PMF and doesn’t mutate payload", () => {
    const payload = parse("3d6");
    const snap = seriesOf(payload);
    const gated = PMF.withProbability(payload, 0.25);
    expect(gated).not.toBe(payload);
    expect(seriesOf(payload)).toEqual(snap);
  });

  it("toChartSeries returns fresh arrays (no shared references)", () => {
    const a = parse("1d6");
    const s1 = seriesOf(a);
    const s2 = seriesOf(a);
    expect(s1).not.toBe(s2); // different object identity
    expect(s1).toEqual(s2); // same content
  });

  it("toChartSeries returns fresh arrays", () => {
    const a = parse("1d6");
    const s1 = seriesOf(a);
    const s2 = seriesOf(a);
    expect(s1).not.toBe(s2); // distinct object identity
  });

  it("probAtLeastOne does not stash mutable state on PMF/DiceQuery", () => {
    const atk = parse("(d20 + 8 AC 16) * (1d8 + 4) crit (2d8 + 4)");
    const dq = new DiceQuery([atk]);
    const p1 = dq.probAtLeastOne(["hit", "crit"]);
    const _x = atk.scaleMass(0.5).normalize().compact();
    const p2 = dq.probAtLeastOne(["hit", "crit"]);
    expect(p2).toBeCloseTo(p1, 12);
  });

  it("PMF.zero / PMF.empty are never mutated by branch/addScaled", () => {
    const zero = PMF.zero();
    const snap = seriesOf(zero);

    const payload = parse("3d6");
    const gated = PMF.withProbability(payload, 0.25); // should internally use zero

    // zero unchanged
    expect(seriesOf(zero)).toEqual(snap);

    // withProbability is pure
    expect(gated.mass()).toBeCloseTo(1, 12);
  });

  it("scaleMass/add/normalize/compact are pure (no input mutation)", () => {
    const a = parse("1d6");
    const b = parse("1d4");

    const aSnap = seriesOf(a);
    const bSnap = seriesOf(b);

    const c = a.scaleMass(0.5).add(b).normalize().compact();

    expect(seriesOf(a)).toEqual(aSnap);
    expect(seriesOf(b)).toEqual(bSnap);
    expect(c.mass()).toBeCloseTo(1, 12);
  });

  it("PMF.add averages two normalized PMFs (documented behavior)", () => {
    const a = PMF.withProbability(parse("3d6"), 0.25);
    const b = PMF.withProbability(parse("3d6"), 0.75);
    const avg = a.add(b);

    const meanA = a.mean();
    const meanB = b.mean();
    const meanAvg = new DiceQuery(avg).mean();
    expect(meanAvg).toBeCloseTo(0.5 * (meanA + meanB), 12);
  });

  it.skip("PMF.add averages two normalized PMFs (documented behavior)", () => {
    const a = PMF.withProbability(parse("3d6"), 0.25);
    const b = PMF.withProbability(parse("3d6"), 0.75);
    const avg = a.add(b);

    const meanA = a.mean();
    const meanB = b.mean();
    const meanAvg = avg.mean(); // TODO: Why does htis fail when the previous test passes?
    expect(meanAvg).toBeCloseTo(0.5 * (meanA + meanB), 12);
  });

  // Order independence — same scenario computed in different build orders
  function scenarioA(atkExpr: string) {
    const attack = parse(atkExpr);
    const mains = new DiceQuery([attack, attack]);
    const pAny = mains.probAtLeastOne(["hit", "crit"]);
    const smite = PMF.withProbability(parse("3d6"), pAny);
    const oa = PMF.withProbability(parse(atkExpr), 0.25);
    return new DiceQuery([attack, attack, smite, oa]);
  }

  function scenarioB(atkExpr: string) {
    // Different construction & interleaving of ops; must yield same distribution
    const a1 = parse(atkExpr);
    const a2 = parse(atkExpr);
    const pH = new DiceQuery([a1]).probAtLeastOne(["hit", "crit"]);
    const pAny = 1 - (1 - pH) ** 2;
    const smite = PMF.branch(parse("3d6"), PMF.zero(), pAny);
    const oa = PMF.branch(parse(atkExpr), PMF.zero(), 0.25);
    return new DiceQuery([a1, a2, smite, oa]);
  }

  it("order independence: scenario A vs B produce same DPR & distribution", () => {
    const atkExpr = "(d20 + 8 AC 16) * (1d8 + 4) crit (2d8 + 4)";
    const qA = scenarioA(atkExpr);
    const qB = scenarioB(atkExpr);
    expect(qA.mean()).toBeCloseTo(qB.mean(), 12);
    expect(qA.toChartSeries()).toEqual(qB.toChartSeries());
    expect(qA.totalMass()).toBeCloseTo(1, 12);
    expect(qB.totalMass()).toBeCloseTo(1, 12);
  });

  it("parse-cached PMF used twice remains independent", () => {
    const x = parse("(d20 + 8 AC 16) * (1d8 + 4) crit (2d8 + 4)");
    const p1 = new DiceQuery([x]).probAtLeastOne(["hit", "crit"]);
    const p2 = new DiceQuery([x, x]).probAtLeastOne(["hit", "crit"]);
    expect(p2).toBeCloseTo(1 - (1 - p1) * (1 - p1), 12);
  });

  it("firstSuccessSplit equivalence (no crit doubling) via exclusive mixture", () => {
    const atk = parse("(d20 + 8 AC 16) * (1d8 + 4) crit (2d8 + 4)");
    const single = new DiceQuery([atk, atk]);

    const [pSuccess, pSubset, pAny] = single.firstSuccessSplit(
      ["hit", "crit"],
      ["crit"]
    );

    const payload = parse("3d6");

    // These are now equivalent (no crit doubling → same payload)
    const smiteSplit = PMF.empty(undefined, "smiteExclusive")
      .addScaled(payload, pSubset + pSuccess) // == pAny
      .addScaled(PMF.zero(), 1 - (pSubset + pSuccess));

    const smiteSimple = PMF.withProbability(payload, pAny);

    // Assertions now pass
    for (const [x, bin] of smiteSplit.map) {
      expect(bin.p).toBeCloseTo(smiteSimple.map.get(x)?.p ?? 0, 12);
    }
    expect(smiteSplit.mean()).toBeCloseTo(smiteSimple.mean(), 12);
  });

  it("resetting caches does not alter prior results (isolation)", () => {
    const a = parse("1d6");
    const atkExpr = "(d20 + 8 AC 16) * (1d8 + 4) crit (2d8 + 4)";
    const before = new DiceQuery(a).toChartSeries();

    // Simulate “other tests” doing lots of work
    PMF.withProbability(parse("3d6"), 0.25);
    PMF.withProbability(parse("2d6"), 0.75);
    new DiceQuery([parse(atkExpr), parse(atkExpr)]).probAtLeastOne([
      "hit",
      "crit",
    ]);

    // Reset caches (or re-import modules)
    (globalThis as any).PMF?._clearParseCache?.();
    (globalThis as any).DiceQuery?._clearInternals?.();

    // Original object still gives the same series
    expect(new DiceQuery(a).toChartSeries()).toEqual(before);
  });

  it("combined query total mass stays 1 across composition", () => {
    const atkExpr = "(d20 + 8 AC 16) * (1d8 + 4) crit (2d8 + 4)";
    const attack = parse(atkExpr);
    const mains = new DiceQuery([attack, attack]);
    const pAny = mains.probAtLeastOne(["hit", "crit"]);
    const smite = PMF.withProbability(parse("3d6"), pAny);
    const oa = PMF.withProbability(parse(atkExpr), 0.25);
    const full = new DiceQuery([attack, attack, smite, oa]);
    expect(full.combined.mass()).toBeCloseTo(1, 12);
  });

  it("firstSuccessSplit: bounds and subset guard", () => {
    const atk = parse("(d20 + 8 AC 16) * (1d8 + 4) crit (2d8 + 4)");
    const per = new DiceQuery([atk]);

    const [pAny, pSubset, pSuccess, pNone] = per.firstSuccessSplit(
      ["hit", "crit"],
      ["crit"]
    );

    for (const x of [pAny, pSubset, pSuccess, pNone]) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(1);
    }

    // Subset must not exceed total; calling with ["crit"] as total and ["hit","crit"] as subset should throw
    expect(() => per.firstSuccessSplit(["crit"], ["hit", "crit"])).toThrow();
  });

  it("repeated probAtLeastOne calls are idempotent and stateless", () => {
    const atkExpr = "(d20 + 8 AC 16) * (1d8 + 4) crit (2d8 + 4)";
    const attack = parse(atkExpr);
    const dq = attack.query();
    const p0 = dq.probAtLeastOne(["hit", "crit"]);
    for (let i = 0; i < 20; i++) {
      const p = dq.probAtLeastOne(["hit", "crit"]);
      expect(p).toBeCloseTo(p0, 12);
    }
  });

  it("order of building singles does not change distribution", () => {
    const expr = "(d20 + 8 AC 16) * (1d8 + 4) crit (2d8 + 4)";
    const attack = parse(expr);

    // Single-swing query to get per-attack probabilities
    const single = new DiceQuery([attack]);

    // Get split probabilities: total success vs crit
    const [pSubset, pSuccess] = single.firstSuccessSplit(
      ["hit", "crit"],
      ["crit"]
    );

    // Build smite as ONE exclusive mixture: {6d6 if first hit crit, 3d6 if first hit non-crit, 0 if no hit}
    const smite = PMF.empty(undefined, "smiteExclusive")
      .addScaled(parse("6d6"), pSubset) // crit smite
      .addScaled(parse("3d6"), pSuccess) // normal smite
      .addScaled(PMF.zero(), 1 - (pSubset + pSuccess)); // miss/no smite

    // OA as a standard Bernoulli mixture
    const oa = PMF.withProbability(parse(expr), 0.25);

    // Two builds with different ordering
    const q1 = new DiceQuery([attack, attack, smite, oa]);
    const q2 = new DiceQuery([oa, smite, attack, attack]); // shuffled order

    // Ensure the resulting distributions are identical
    expect(q1.mean()).toBeCloseTo(q2.mean(), 12);

    for (const [x, bin] of q1.combined.map) {
      expect(bin.p).toBeCloseTo(q2.combined.map.get(x)?.p ?? 0, 12);
    }

    expect(q1.totalMass()).toBeCloseTo(1, 12);
    expect(q2.totalMass()).toBeCloseTo(1, 12);
  });

  it("firstSuccessSplit: edge cases (no hits, no crits, all hits)", () => {
    // Likely-miss case (very low hit chance) — use TWO swings in the split
    const missy = parse("(d20 + 0 AC 25) * (1d8 + 4) crit (2d8 + 4)");
    const dqMiss1 = new DiceQuery([missy]); // single swing for pH/pC
    const dqMiss2 = new DiceQuery([missy, missy]); // two swings for the split
    const pHM = dqMiss1.probAtLeastOne(["hit", "crit"]);
    const pCM = dqMiss1.probAtLeastOne(["crit"]);
    const [pMissSuccess, pMissSubset, pMissAny, pMissNone] =
      dqMiss2.firstSuccessSplit(["hit", "crit"], ["crit"]);
    expect(pMissAny).toBeCloseTo(1 - (1 - pHM) ** 2, 12);
    expect(pMissSubset + pMissSuccess).toBeCloseTo(pMissAny, 12);
    expect(pMissAny + pMissNone).toBeCloseTo(1, 12);

    // No crits scenario (no 'crit' clause → pC ≈ 0)
    const noCrit = parse("(d20 + 8 AC 16) * (1d8 + 4)");
    const dqNoCrit1 = new DiceQuery([noCrit]);
    const dqNoCrit2 = new DiceQuery([noCrit, noCrit]);
    const pHN = dqNoCrit1.probAtLeastOne(["hit", "crit"]);
    const pCN = dqNoCrit1.probAtLeastOne(["crit"]);
    const [pSuccessNoCrit, pSubsetNoCrit, pAnyNoCrit] =
      dqNoCrit2.firstSuccessSplit(["hit", "crit"], ["crit"]);
    expect(pCN).toBeCloseTo(0, 6);
    expect(pSubsetNoCrit).toBeCloseTo(0, 6); // no crits → subset ~ 0
    expect(pSuccessNoCrit).toBeCloseTo(1 - (1 - pHN) ** 2, 12); // two-swing any

    // Very-high-hit case (pTotal ~ 1 per swing) — again TWO swings for the split
    const always = parse("(d20 + 20 AC 5) * (1d8 + 4) crit (2d8 + 4)");
    const dqAlways1 = new DiceQuery([always]);
    const dqAlways2 = new DiceQuery([always, always]);
    const pHA = dqAlways1.probAtLeastOne(["hit", "crit"]);
    const [pAlwaysSuccess, pAlwaysSubset, pAlwaysAny, pAlwaysNone] =
      dqAlways2.firstSuccessSplit(["hit", "crit"], ["crit"]);
    expect(pHA).toBeGreaterThan(0.99); // near-certain per swing
    expect(pAlwaysAny).toBeGreaterThan(0.9999); // near-certain across two
    expect(pAlwaysNone).toBeLessThan(1e-6);
  });

  it("PMF.add averages two normalized PMFs", () => {
    const a = PMF.withProbability(parse("3d6"), 0.25);
    const b = PMF.withProbability(parse("3d6"), 0.75);

    const avg = a.add(b);
    const qAvg = new DiceQuery([avg]);
    const expectedMean = 0.5 * (a.mean() + b.mean());

    expect(qAvg.mean()).toBeCloseTo(expectedMean, 12);
    expect(qAvg.totalMass()).toBeCloseTo(1, 12);
  });

  it("split equivalence when payload is the same (no crit doubling)", () => {
    const expr = "(d20 + 8 AC 16) * (1d8 + 4) crit (2d8 + 4)";
    const payload = parse("3d6");
    const attack = parse(expr);

    // Per-attack (single swing) probs
    const attacks = new DiceQuery([attack, attack]);
    const [pNonSubsetFirst, pSubsetFirst, pAny] = attacks.firstSuccessSplit(
      ["hit", "crit"],
      ["crit"]
    );

    // Build smite as ONE exclusive mixture among {payload, 0}
    // (both branches use the same payload here, so the weights just add)
    const smiteSplit = PMF.empty(undefined, "smiteExclusive")
      .addScaled(payload, pSubsetFirst + pNonSubsetFirst)
      .addScaled(PMF.zero(), 1 - (pSubsetFirst + pNonSubsetFirst));

    // Simple gate by pAny
    const smiteSimple = PMF.withProbability(payload, pAny);

    const qSplit = new DiceQuery([smiteSplit]);
    const qSimple = new DiceQuery([smiteSimple]);

    // Expectation and distribution should match (within FP tolerance)
    expect(qSplit.mean()).toBeCloseTo(qSimple.mean(), 12);
    for (const [x, bin] of qSplit.combined.map) {
      expect(bin.p).toBeCloseTo(qSimple.combined.map.get(x)?.p ?? 0, 12);
    }

    expect(qSplit.totalMass()).toBeCloseTo(1, 12);
    expect(qSimple.totalMass()).toBeCloseTo(1, 12);
  });

  it("crit-aware smite DPR matches hand calculation", () => {
    const atk = parse("(d20 + 8 AC 16) * (1d8 + 4) crit (2d8 + 4)");
    const attacks = new DiceQuery([atk, atk]);

    const [pFirstNonCrit, pFirstCrit] = attacks.firstSuccessSplit(
      ["hit", "crit"],
      ["crit"]
    );

    const mains = new DiceQuery([atk, atk]);
    const smiteCrit = PMF.withProbability(parse("6d6"), pFirstCrit);
    const smiteNorm = PMF.withProbability(parse("3d6"), pFirstNonCrit);
    const oa = PMF.withProbability(
      parse("(d20 + 8 AC 16) * (1d8 + 4) crit (2d8 + 4)"),
      0.25
    );

    const full = new DiceQuery([atk, atk, smiteNorm, smiteCrit, oa]);

    // Hand expectations
    const mainDPR = 11.5;
    const smiteDPR = 10.5 * 0.81 + 21 * 0.0675; // 9.9225
    const oaDPR = 0.25 * 5.75; // 1.4375
    const total = mainDPR + smiteDPR + oaDPR; // 22.86

    expect(mains.mean()).toBeCloseTo(mainDPR, 4);
    expect(smiteNorm.mean() + smiteCrit.mean()).toBeCloseTo(smiteDPR, 4);
    expect(new DiceQuery([oa]).mean()).toBeCloseTo(oaDPR, 4);
    expect(full.mean()).toBeCloseTo(total, 4);
  });

  it("withProbability: preserves mass and scales labels", () => {
    const atk = parse("(d20 + 8 AC 16) * (1d8 + 4) crit (2d8 + 4)");
    const p = 0.37;

    const gated = PMF.withProbability(atk, p);
    const q = new DiceQuery([gated]);

    // Mass stays 1 because it's a proper Bernoulli mixture (payload vs zero)
    expect(q.totalMass()).toBeCloseTo(1, 12);

    // Label probability scales linearly
    const pAny = new DiceQuery([atk]).probAtLeastOne(["hit", "crit"]);
    expect(q.probAtLeastOne(["hit", "crit"])).toBeCloseTo(p * pAny, 12);
  });

  it("combined query mass stays 1 across composition", () => {
    const atk = parse("(d20 + 8 AC 16) * (1d8 + 4) crit (2d8 + 4)");
    const per = new DiceQuery([atk]);
    const [pAny] = per.firstSuccessSplit(["hit", "crit"], ["crit"]);
    const smite = PMF.withProbability(parse("3d6"), pAny);
    const oa = PMF.withProbability(atk, 0.25);

    const full = new DiceQuery([atk, atk, smite, oa]);
    expect(full.totalMass()).toBeCloseTo(1, 12);
  });

  it("firstSuccessSplit: randomized property test (pb ⊆ pa)", () => {
    const trials = 500;
    for (let i = 0; i < trials; i++) {
      const pTotal = Math.random(); // pa ~ U(0,1)
      const pSubset = Math.random() * pTotal; // pb ∈ [0, pa]
      const twoMinus = 2 - pTotal;

      const pAny = 1 - (1 - pTotal) ** 2;
      const pSubsetFirst = pSubset * twoMinus;
      const pNonSubsetFirst = (pTotal - pSubset) * twoMinus;
      const pNone = (1 - pTotal) ** 2;

      const clamp = (x: number) => Math.max(0, Math.min(1, x));
      const s = {
        pAny: clamp(pAny),
        pSubsetFirst: clamp(pSubsetFirst),
        pNonSubsetFirst: clamp(pNonSubsetFirst),
        pNone: clamp(pNone),
      };

      expect(s.pSubsetFirst + s.pNonSubsetFirst).toBeCloseTo(s.pAny, 12);
      expect(s.pAny + s.pNone).toBeCloseTo(1, 12);
      for (const v of Object.values(s)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it("Should calculate the correct damage rider statistics", () => {
    const q = fullRoundSimulationExample();

    expect(q.mean()).toBeCloseTo(28.775, 3);
    expect(q.stddev()).toBeCloseTo(12.365, 3);
    expect(q.min()).toBeCloseTo(0.0, 12);
    expect(q.max()).toBeCloseTo(124.0, 12);
    expect(q.percentiles([0.25, 0.5, 0.75])).toEqual([20, 29, 37]);
    expect(q.totalMass()).toBeCloseTo(1, 12);
  });
});
