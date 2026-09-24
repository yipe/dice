import { describe, expect, it } from "vitest";
import { d, roll } from "../src/builder";

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

/** Smallest total t with exact P(X ≤ t) ≥ num/den. */
function exactQuantile(n: number, sides: number, num: number, den: number): number {
  const counts = diceCounts(n, sides);
  const total = counts.reduce((a, b) => a + b, 0n);
  let cumulative = 0n;
  for (let i = 0; i < counts.length; i++) {
    cumulative += counts[i];
    if (cumulative * BigInt(den) >= BigInt(num) * total) return n + i;
  }
  return n + counts.length - 1;
}

const SHAPES: Array<[number, number]> = [
  [1, 4],
  [1, 6],
  [1, 8],
  [1, 10],
  [1, 12],
  [1, 20],
  [1, 100],
  [2, 6],
  [3, 6],
  [2, 20],
  [5, 6],
  [30, 4],
];

describe("quantiles at exact CDF boundaries", () => {
  it("d20 median is 10 through percentiles, quantile and snapshot", () => {
    const pmf = roll(1, d(20)).toPMF();
    expect(pmf.quantile(0.5)).toBe(10);
    expect(pmf.query().percentiles([0.5])).toEqual([10]);
    expect(pmf.query().snapshot().percentiles.p50).toBe(10);
  });

  it("d12 median is 6 and d10 90th percentile is 9", () => {
    const d12 = roll(1, d(12)).toPMF();
    expect(d12.quantile(0.5)).toBe(6);
    expect(d12.query().percentiles([0.5])).toEqual([6]);
    expect(d12.query().snapshot().percentiles.p50).toBe(6);
    expect(roll(1, d(10)).toPMF().query().percentiles([0.9])).toEqual([9]);
  });

  it("d100 quantiles land on the exact face", () => {
    const pmf = roll(1, d(100)).toPMF();
    expect(pmf.quantile(0.5)).toBe(50);
    expect(pmf.quantile(0.01)).toBe(1);
    expect(pmf.quantile(0.25)).toBe(25);
  });

  it("quantile(1) is the maximum even when the top bins are below one ulp of the CDF", () => {
    const pmf = roll(30, d(4)).toPMF();
    expect(pmf.quantile(1)).toBe(120);
    expect(pmf.query().percentiles([1])).toEqual([120]);
    expect(pmf.quantile(0)).toBe(30);
  });

  it("matches an exact BigInt CDF for every k/20 and k/100 target", () => {
    const mismatches: string[] = [];
    for (const [n, sides] of SHAPES) {
      const pmf = roll(n, d(sides)).toPMF();
      const query = pmf.query();
      const targets: Array<[number, number]> = [];
      for (let k = 0; k <= 20; k++) targets.push([k, 20]);
      for (let k = 1; k < 100; k += 7) targets.push([k, 100]);
      for (const [num, den] of targets) {
        const exact = exactQuantile(n, sides, num, den);
        const p = num / den;
        const viaQuantile = pmf.quantile(p);
        const [viaPercentiles] = query.percentiles([p]);
        if (viaQuantile !== exact) mismatches.push(`${n}d${sides} quantile(${num}/${den}) = ${viaQuantile}, exact ${exact}`);
        if (viaPercentiles !== exact) mismatches.push(`${n}d${sides} percentiles(${num}/${den}) = ${viaPercentiles}, exact ${exact}`);
      }
      const snapshot = query.snapshot().percentiles;
      expect(snapshot).toEqual({
        p25: exactQuantile(n, sides, 1, 4),
        p50: exactQuantile(n, sides, 1, 2),
        p75: exactQuantile(n, sides, 3, 4),
      });
    }
    expect(mismatches).toEqual([]);
  });

  it("out-of-range targets clamp to the support ends", () => {
    const pmf = roll(2, d(6)).toPMF();
    expect(pmf.quantile(-0.5)).toBe(2);
    expect(pmf.quantile(1.5)).toBe(12);
    expect(pmf.query().percentiles([-1, 2])).toEqual([2, 12]);
  });
});
