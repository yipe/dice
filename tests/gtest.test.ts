import { describe, expect, it } from "vitest";
import { d20 } from "../src/builder/factory";
import { PMF } from "../src/pmf/pmf";
import { gammaQ, gTest } from "./helpers/gtest";
import { lcgRng } from "./helpers/lcg";

describe("gammaQ", () => {
  /** Chi-square survival with df = 2k is exact: exp(-x/2) * sum_{i<k} (x/2)^i / i!. */
  const chiSqEven = (df: number, x: number): number => {
    let term = 1;
    let sum = 1;
    for (let i = 1; i < df / 2; i++) {
      term *= x / 2 / i;
      sum += term;
    }
    return Math.exp(-x / 2) * sum;
  };
  it("matches the closed-form chi-square survival for even df", () => {
    for (const [df, x] of [
      [2, 2],
      [2, 5.991465],
      [4, 4],
      [4, 9.487729],
      [10, 18.307038],
      [30, 43.772972],
    ]) {
      expect(gammaQ(df / 2, x / 2)).toBeCloseTo(chiSqEven(df, x), 10);
    }
  });
  it("matches tabulated chi-square critical values for odd df", () => {
    expect(gammaQ(0.5, 3.841459 / 2)).toBeCloseTo(0.05, 6);
    expect(gammaQ(0.5, 6.634897 / 2)).toBeCloseTo(0.01, 6);
    expect(gammaQ(1.5, 7.814728 / 2)).toBeCloseTo(0.05, 6);
    expect(gammaQ(2.5, 15.086272 / 2)).toBeCloseTo(0.01, 6);
  });
  it("covers both the series and continued-fraction branches at the boundary", () => {
    expect(gammaQ(0.5, 0)).toBe(1);
    expect(gammaQ(3, 3.9)).toBeCloseTo(chiSqEven(6, 7.8), 10);
    expect(gammaQ(3, 4.1)).toBeCloseTo(chiSqEven(6, 8.2), 10);
  });
});

describe("gTest", () => {
  const fair = PMF.fromMap(new Map(Array.from({ length: 6 }, (_, i) => [i + 1, 1 / 6])));
  it("accepts a fair die sampled fairly", () => {
    const rng = lcgRng(5);
    const counts = new Map<number, number>();
    for (let i = 0; i < 60000; i++) {
      const f = rng.die(6);
      counts.set(f, (counts.get(f) ?? 0) + 1);
    }
    expect(gTest(counts, fair, 60000).p).toBeGreaterThan(1e-3);
  });
  it("rejects a loaded die", () => {
    expect(
      gTest(
        new Map([
          [1, 5000],
          [2, 5000],
          [3, 5000],
          [4, 5000],
          [5, 5000],
          [6, 35000],
        ]),
        fair,
        60000
      ).p
    ).toBeLessThan(1e-12);
  });
  it("pools bins with expected count under 5", () => {
    const spiky = PMF.fromMap(new Map([[0, 0.9999], [100, 0.0001]]));
    expect(gTest(new Map([[0, 1000]]), spiky, 1000).df).toBe(1);
  });
  it("returns p = 0 for an observed value the PMF gives no mass, even one draw", () => {
    const observed = new Map([[1, 9999], [2, 9999], [3, 10000], [4, 10000], [5, 10000], [6, 10000], [7, 2]]);
    const r = gTest(observed, fair, 60000);
    expect(r.p).toBe(0);
    expect(r.g).toBe(Infinity);
  });
  it("throws when n is not the observed total", () => {
    expect(() => gTest(new Map([[1, 10]]), fair, 11)).toThrow(/observed total/);
  });
});

describe("lcgRng", () => {
  it("2d20 keep-highest over 200k draws passes the G-test against the exact PMF", () => {
    const rng = lcgRng(11);
    const counts = new Map<number, number>();
    const N = 200000;
    for (let i = 0; i < N; i++) {
      const f = Math.max(rng.die(20), rng.die(20));
      counts.set(f, (counts.get(f) ?? 0) + 1);
    }
    expect(gTest(counts, d20.withAdvantage().pmf, N).p).toBeGreaterThan(1e-3);
  });
  it("chance(p) is a fair coin at p over 100k draws", () => {
    const rng = lcgRng(3);
    const counts = new Map<number, number>([[0, 0], [1, 0]]);
    const N = 100000;
    for (let i = 0; i < N; i++) {
      const k = rng.chance(0.3) ? 1 : 0;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    expect(gTest(counts, PMF.fromMap(new Map([[0, 0.7], [1, 0.3]])), N).p).toBeGreaterThan(1e-3);
  });
});
