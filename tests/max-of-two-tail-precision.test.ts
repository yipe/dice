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

/** Exact P(max of two NdS = n + i) = (C(i)² − C(i−1)²) / T², as a Number. */
function exactMaxOfTwo(n: number, sides: number): number[] {
  const counts = diceCounts(n, sides);
  const total = BigInt(sides) ** BigInt(n);
  const denominator = total * total;
  const out: number[] = [];
  let below = 0n;
  for (const ways of counts) {
    const upTo = below + ways;
    const numerator = upTo * upTo - below * below;
    // Scale into Number range without losing relative precision.
    const shift = BigInt(Math.max(0, denominator.toString().length - numerator.toString().length + 20));
    out.push(Number((numerator * 10n ** shift) / denominator) / 10 ** Number(shift));
    below = upTo;
  }
  return out;
}

describe("maxOfTwo tail precision", () => {
  for (const [n, sides] of [
    [20, 6],
    [30, 4],
    [10, 20],
  ] as const) {
    it(`${n}d${sides}: every bin, including the top ones, within 1e-13 relative`, () => {
      const pmf = roll(n, d(sides)).toPMF().maxOfTwo();
      const exact = exactMaxOfTwo(n, sides);
      const worst = exact.reduce((acc, p, i) => {
        const got = pmf.pAt(n + i);
        return Math.max(acc, Math.abs(got - p) / p);
      }, 0);
      expect(worst).toBeLessThan(1e-13);
      expect(pmf.pAt(n * sides)).toBeGreaterThan(0);
    });
  }

  it("20d6 top bin is 2·6^-20 − 6^-40 to 1e-14 relative", () => {
    const top = roll(20, d(6)).toPMF().maxOfTwo().pAt(120);
    const exact = 7312316880125951 / 13367494538843734067838845976576;
    expect(Math.abs(top - exact) / exact).toBeLessThan(1e-14);
  });
});
