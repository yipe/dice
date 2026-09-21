import { describe, expect, it } from "vitest";
import { d8, roll } from "../builder";

// Oracles from docs/superpowers/plans/2026-09-21-native-bounce-and-explode.md, §1.3. Computed by
// brute-force enumeration in the plan/spec's appendix — ground truth. NEVER adjust these numbers
// to match an implementation; if an assertion disagrees, the implementation is wrong.
describe("RollBuilder.explodePool() — pool-wide exploding-dice budget", () => {
  const oracles: { pool: string; count: number; budget: number; poolWideMean: number; perDieMean: number }[] = [
    { pool: "1d8", count: 1, budget: 1, poolWideMean: 5.0625000000, perDieMean: 5.0625000000 },
    { pool: "1d8", count: 1, budget: 3, poolWideMean: 5.1416015625, perDieMean: 5.1416015625 },
    { pool: "2d8", count: 2, budget: 1, poolWideMean: 10.0546875000, perDieMean: 10.1250000000 },
    { pool: "3d8", count: 3, budget: 2, poolWideMean: 15.3402099609, perDieMean: 15.3984375000 },
    { pool: "4d8", count: 4, budget: 3, poolWideMean: 20.5365715027, perDieMean: 20.5664062500 },
    { pool: "4d8", count: 4, budget: 5, poolWideMean: 20.5701819956, perDieMean: 20.5713500977 },
  ];

  for (const { pool, count, budget, poolWideMean } of oracles) {
    it(`${pool} explodePool(${budget}) has pool-wide mean ${poolWideMean}`, () => {
      const pmf = roll(count, d8).explodePool(budget).toPMF();
      expect(pmf.mean()).toBeCloseTo(poolWideMean, 10);
      expect(pmf.mass()).toBeCloseTo(1, 12);
    });
  }

  // 2d8 budget 1 is the discriminating case: per-die semantics gives 10.125, true pool-wide
  // gives 10.0546875. A regression to per-die semantics must fail this exact assertion.
  it("2d8 explodePool(1) mean is the pool-wide figure, not the per-die figure (discriminating case)", () => {
    const pmf = roll(2, d8).explodePool(1).toPMF();
    expect(pmf.mean()).toBeCloseTo(10.0546875, 10);
    expect(pmf.mean()).not.toBeCloseTo(10.125, 4);
  });

  for (const { pool, count, budget, perDieMean } of oracles.filter((o) => o.count === 1)) {
    it(`single-die ${pool} explodePool(${budget}) matches explode(${budget}) exactly (one die cannot share a budget with itself)`, () => {
      const poolWide = roll(count, d8).explodePool(budget).toPMF();
      const perDie = roll(count, d8).explode(budget).toPMF();
      expect(poolWide.mean()).toBeCloseTo(perDieMean, 10);
      expect(poolWide.mean()).toBeCloseTo(perDie.mean(), 10);
      expect(poolWide.mass()).toBeCloseTo(1, 12);
    });
  }

  it("explode() and explodePool() are mutually exclusive on one config", () => {
    expect(() => roll(2, d8).explode(1).explodePool(1)).toThrow();
    expect(() => roll(2, d8).explodePool(1).explode(1)).toThrow();
  });

  it("explodePool() throws on a pooled roll, mirroring explode()'s guard", () => {
    const pooled = roll(4, d8).keepHighestAll(4, 3);
    expect(() => pooled.explodePool(1)).toThrow(/pooled roll/);
  });

  it("toExpression() throws for a pool-wide explosion budget, mirroring explode()'s guard", () => {
    expect(() => roll(2, d8).explodePool(1).toExpression()).toThrow(/explode syntax/);
  });

  it("explode() semantics are unaffected by the new pool-wide budget (regression)", () => {
    const pmf = roll(1, d8).explode(3).toPMF();
    expect(pmf.mean()).toBeCloseTo(5.1416015625, 10);
    expect(pmf.mass()).toBeCloseTo(1, 10);
  });
});
