import { describe, expect, it } from "vitest";
import { d, d20, roll, turn } from "../src/builder";

/** Exact face-count table of NdS: `counts[i]` ways to roll a total of `n + i`. */
function diceCounts(n: number, sides: number): bigint[] {
  let counts: bigint[] = [1n];
  for (let die = 0; die < n; die++) {
    const next = new Array<bigint>(counts.length + sides - 1).fill(0n);
    counts.forEach((ways, i) => {
      for (let face = 0; face < sides; face++) next[i + face] += ways;
    });
    counts = next;
  }
  return counts;
}

/**
 * d20+10 vs AC 12 for 20d6: nat 1 misses (1/20), nat 20 crits for 40d6 (1/20), everything else
 * hits for 20d6 (18/20). Returned as integer weights over the denominator 20·6^40.
 */
function exactAttack(): { weights: Map<number, bigint>; denominator: bigint } {
  const six20 = 6n ** 20n;
  const weights = new Map<number, bigint>([[0, six20 * six20]]);
  diceCounts(20, 6).forEach((ways, i) => {
    weights.set(20 + i, (weights.get(20 + i) ?? 0n) + 18n * ways * six20);
  });
  diceCounts(40, 6).forEach((ways, i) => {
    weights.set(40 + i, (weights.get(40 + i) ?? 0n) + ways);
  });
  return { weights, denominator: 20n * six20 * six20 };
}

const attack = () => d20.plus(10).ac(12).onHit(roll(20, d(6)));

describe("attack resolution keeps every reachable damage value", () => {
  it("resolve() matches the exact single-attack distribution bin for bin, 0..240", () => {
    const { weights, denominator } = exactAttack();
    const pmf = attack().resolve().pmf;
    expect(pmf.support()).toEqual([...weights.keys()].sort((a, b) => a - b));
    expect(pmf.min()).toBe(0);
    expect(pmf.max()).toBe(240);
    for (const [value, w] of weights) {
      // Scale both to avoid Number overflow of the 6^40-sized integers.
      const exact = Number((w * 10n ** 80n) / denominator) / 1e80;
      expect(Math.abs(pmf.pAt(value) - exact)).toBeLessThanOrEqual(exact * 1e-9 + 1e-300);
    }
    expect(pmf.pAt(240)).toBeGreaterThan(0);
    expect(pmf.mean()).toBeCloseTo(70, 10);
  });

  it("resolve() and toPMF() agree bin for bin", () => {
    const resolved = attack().resolve().pmf;
    const built = attack().toPMF();
    expect(resolved.support()).toEqual(built.support());
    for (const value of built.support()) expect(resolved.pAt(value)).toBe(built.pAt(value));
  });

  it("a one-attack turn keeps the crit tail up to 240", () => {
    const pmf = turn([attack()]).pmf;
    expect(pmf.max()).toBe(240);
    expect(pmf.support()).toHaveLength(222);
  });

  it("a ten-attack turn reaches the exact maximum 2400 with every value 20..2400 present", () => {
    const pmf = turn(Array.from({ length: 10 }, attack)).pmf;
    expect(pmf.min()).toBe(0);
    expect(pmf.max()).toBe(2400);
    // {0} ∪ [20, 2400]: one attack reaches {0} ∪ [20, 240], and the ranges overlap from two on.
    expect(pmf.support()).toHaveLength(2382);
    expect(pmf.mean()).toBeCloseTo(700, 8);
  });
});
