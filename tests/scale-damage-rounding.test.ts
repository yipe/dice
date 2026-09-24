import { describe, expect, it } from "vitest";
import { d, roll } from "../src/builder";
import { PMF } from "../src/index";

type Mode = "floor" | "ceil" | "round";

/** Exact integer rounding of v·num/den; `round` is half toward +∞. */
function exactScale(v: number, num: number, den: number, mode: Mode): number {
  const a = BigInt(v * num);
  const b = BigInt(den);
  const floorDiv = (x: bigint, y: bigint): bigint => {
    const q = x / y;
    return (x % y !== 0n && (x < 0n) !== (y < 0n)) ? q - 1n : q;
  };
  if (mode === "floor") return Number(floorDiv(a, b));
  if (mode === "ceil") return -Number(floorDiv(-a, b));
  return Number(floorDiv(2n * a + b, 2n * b));
}

describe("scaleDamage with an integer ratio", () => {
  it("rounds v·num/den exactly for every num, den ≤ 12, every mode, v in [-300, 300]", () => {
    const values = Array.from({ length: 601 }, (_, i) => i - 300);
    const uniform = PMF.fromMap(new Map(values.map((v) => [v, 1])), 0);
    const wrong: string[] = [];
    for (let num = 1; num <= 12; num++) {
      for (let den = 1; den <= 12; den++) {
        for (const mode of ["floor", "ceil", "round"] as Mode[]) {
          const scaled = uniform.scaleDamage(num, mode, den);
          const expected = new Map<number, number>();
          for (const v of values) {
            const u = exactScale(v, num, den, mode);
            expected.set(u, (expected.get(u) ?? 0) + 1);
          }
          const got = [...scaled.support()];
          const want = [...expected.keys()].sort((a, b) => a - b);
          if (got.join() !== want.join()) {
            wrong.push(`${num}/${den} ${mode}`);
            continue;
          }
          for (const u of want) {
            if (Math.abs(scaled.pAt(u) - (expected.get(u) as number) / 601) > 1e-15) {
              wrong.push(`${num}/${den} ${mode} at ${u}`);
              break;
            }
          }
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it("scaleResult(9, 7, ceil) of 1d20+1 has mean 76/5 and exact bins", () => {
    const pmf = roll(1, d(20)).plus(1).scaleResult(9, 7, "ceil").toPMF();
    const expected = new Map<number, number>();
    for (let v = 2; v <= 21; v++) {
      const u = exactScale(v, 9, 7, "ceil");
      expected.set(u, (expected.get(u) ?? 0) + 1 / 20);
    }
    expect(pmf.support()).toEqual([...expected.keys()].sort((a, b) => a - b));
    for (const [u, p] of expected) expect(pmf.pAt(u)).toBeCloseTo(p, 15);
    expect(pmf.pAt(27)).toBeCloseTo(1 / 20, 15);
    expect(pmf.pAt(28)).toBe(0);
    expect(pmf.mean()).toBeCloseTo(76 / 5, 12);
  });

  it("scaleResult(7, 10, round) of 8d12 rounds halves up", () => {
    // Exact mean by enumeration of the 8d12 total's face counts.
    let counts: number[] = [1];
    for (let die = 0; die < 8; die++) {
      const next = new Array<number>(counts.length + 11).fill(0);
      counts.forEach((ways, i) => {
        for (let face = 0; face < 12; face++) next[i + face] += ways;
      });
      counts = next;
    }
    const total = 12 ** 8;
    let exactMean = 0;
    counts.forEach((ways, i) => {
      exactMean += (exactScale(8 + i, 7, 10, "round") * ways) / total;
    });
    const pmf = roll(8, d(12)).scaleResult(7, 10, "round").toPMF();
    expect(pmf.mean()).toBeCloseTo(exactMean, 12);
    expect(exactMean).toBeCloseTo(15672832797 / 429981696, 12);
  });

  it("a plain factor keeps its meaning (×1/2 floor, ×3/2 round)", () => {
    const pmf = roll(1, d(6)).toPMF();
    expect(pmf.scaleDamage(0.5).support()).toEqual([0, 1, 2, 3]);
    expect(pmf.scaleDamage(1.5, "round").support()).toEqual([2, 3, 5, 6, 8, 9]);
  });
});
