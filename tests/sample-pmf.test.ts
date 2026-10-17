import { describe, expect, it } from "vitest";
import { PMF } from "../src/pmf/pmf";
import { samplePMF, scaleValue } from "../src/pmf/sample";
import type { Rng } from "../src/common/rng";

/** A scripted rng: `chance` answers from a queue, `die` is never called here. */
const scripted = (answers: boolean[]): Rng => ({
  die: () => {
    throw new Error("die() not expected");
  },
  chance: () => {
    const a = answers.shift();
    if (a === undefined) throw new Error("ran out");
    return a;
  },
});

describe("samplePMF", () => {
  const pmf = PMF.fromMap(
    new Map([
      [0, 0.25],
      [5, 0.5],
      [9, 0.25],
    ])
  );
  it("walks bins ascending with conditional coins", () => {
    // first coin: P(0)=0.25 -> false; second coin: P(5 | not 0) = 0.5/0.75 -> true
    expect(samplePMF(pmf, scripted([false, true])).total).toBe(5);
    expect(samplePMF(pmf, scripted([true])).total).toBe(0);
    // last bin needs no coin
    expect(samplePMF(pmf, scripted([false, false])).total).toBe(9);
  });
  it("picks an outcome label inside the bin", () => {
    const mixed = new PMF(new Map([[6, { p: 1, count: { hit: 0.75, crit: 0.25 } }]]));
    expect(samplePMF(mixed, scripted([true])).outcome).toBe("crit"); // labels sorted: crit, hit; P(crit)=0.25 coin true
    expect(samplePMF(mixed, scripted([false])).outcome).toBe("hit");
  });
  it("is unbiased over many draws (seeded LCG)", () => {
    let s = 12345;
    const lcg: Rng = {
      die: () => 1,
      chance: (p) => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 4294967296 < p;
      },
    };
    const counts = new Map<number, number>();
    for (let i = 0; i < 20000; i++) {
      const { total } = samplePMF(pmf, lcg);
      counts.set(total, (counts.get(total) ?? 0) + 1);
    }
    expect((counts.get(5) ?? 0) / 20000).toBeCloseTo(0.5, 1);
  });
});

describe("scaleValue", () => {
  it("matches PMF.scaleDamage per value", () => {
    const pmf = PMF.fromMap(new Map([[7, 1]]));
    expect(scaleValue(7, 1, "floor", 2)).toBe(pmf.scaleDamage(1, "floor", 2).support()[0]);
    expect(scaleValue(21, 9, "ceil", 7)).toBe(27);
    expect(scaleValue(7, 0.5, "floor")).toBe(3);
  });
});
