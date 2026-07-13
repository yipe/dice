import { describe, expect, it } from "vitest";
import { d, d20 } from "../builder";
import { RollBuilder, ScaleRollBuilder, sumRolls } from "./roll";

const mean = (pmf: { map: Map<number, { p: number }> }): number => {
  let m = 0;
  for (const [v, b] of pmf.map.entries()) m += v * b.p;
  return m;
};

const distEntries = (pmf: { map: Map<number, { p: number }> }) =>
  [...pmf.map.entries()].sort((a, b) => a[0] - b[0]).map(([v, b]) => [v, b.p]);

const d6 = () => new RollBuilder().plus(1, d(6));

describe("scaleResult / ScaleRollBuilder", () => {
  it("halves (floor) a single die: expression and distribution", () => {
    const half = d6().scaleResult(1, 2);
    expect(half).toBeInstanceOf(ScaleRollBuilder);
    expect(half.toExpression()).toBe("(1d6) // 2");
    // floor(1..6 / 2) => 0,1,1,2,2,3
    expect(distEntries(half.pmf)).toEqual([
      [0, 1 / 6],
      [1, 2 / 6],
      [2, 2 / 6],
      [3, 1 / 6],
    ]);
    expect(mean(half.pmf)).toBeCloseTo(1.5, 10);
  });

  it("matches the existing half() node for the // 2 case", () => {
    expect(d6().scaleResult(1, 2).toExpression()).toBe(d6().half().toExpression());
    expect(mean(d6().scaleResult(1, 2).pmf)).toBeCloseTo(mean(d6().half().pmf), 10);
  });

  it("doubles the total for vulnerability (2 * (expr))", () => {
    const vuln = d6().scaleResult(2);
    expect(vuln.toExpression()).toBe("2 * (1d6)");
    // 2 * (1..6) => even values 2..12, each 1/6 (NOT triangular like 2d6)
    expect(distEntries(vuln.pmf)).toEqual([
      [2, 1 / 6],
      [4, 1 / 6],
      [6, 1 / 6],
      [8, 1 / 6],
      [10, 1 / 6],
      [12, 1 / 6],
    ]);
    expect(mean(vuln.pmf)).toBeCloseTo(7, 10);
  });

  it("renders a general numerator/denominator form", () => {
    expect(d6().scaleResult(3, 4).toExpression()).toBe("(1d6) * 3 // 4");
  });

  it("supports round and ceil rounding modes", () => {
    // ceil(1..6 / 2) => 1,1,2,2,3,3 => mean 2
    expect(mean(d6().scaleResult(1, 2, "ceil").pmf)).toBeCloseTo(2, 10);
  });
});

describe("sumRolls", () => {
  it("returns a single part unwrapped and empty as 0", () => {
    const base = new RollBuilder().plus(3).plus(1, d(8));
    expect(sumRolls([base])).toBe(base);
    expect(sumRolls([]).toExpression()).toBe("0");
  });

  it("preserves a scaled part beside a plain part (which plus() would drop)", () => {
    const base = new RollBuilder().plus(3).plus(1, d(8)); // 1d8 + 3, mean 7.5
    const resistedFire = d6().scaleResult(1, 2); // (1d6)//2, mean 1.5
    const payload = sumRolls([base, resistedFire]);

    expect(payload.toExpression()).toBe("1d8 + 3 + (1d6) // 2");
    expect(mean(payload.pmf)).toBeCloseTo(9.0, 10);

    // Guard: the flat merge silently drops the scaled part.
    expect(base.plus(resistedFire).toExpression()).toBe("1d8 + 3");
  });

  it("only scales the resisted damage type in a mixed attack (floor is per-type)", () => {
    // 1d8 slashing (unresisted) + 1d6 fire (resisted). Halving the WHOLE total would be wrong.
    const slashing = new RollBuilder().plus(1, d(8)); // mean 4.5
    const fireResisted = d6().scaleResult(1, 2); // mean 1.5
    const perType = sumRolls([slashing, fireResisted]);
    expect(mean(perType.pmf)).toBeCloseTo(6.0, 10);

    // Halving the merged total instead would give floor((1d8+1d6)/2) => mean ~3.79, clearly different.
    const wholeHalved = new RollBuilder().plus(1, d(8)).plus(1, d(6)).scaleResult(1, 2);
    expect(mean(wholeHalved.pmf)).not.toBeCloseTo(6.0, 1);
  });

  it("carries resistance through a full attack's hit and crit payloads + keeps attribution", () => {
    const hit = sumRolls([
      new RollBuilder().plus(3).plus(1, d(8)),
      d6().scaleResult(1, 2),
    ]);
    const crit = sumRolls([
      new RollBuilder().plus(3).plus(2, d(8)),
      new RollBuilder().plus(2, d(6)).scaleResult(1, 2),
    ]);
    const attack = d20.ac(15).onHit(hit).onCrit(crit);

    expect(attack.toExpression()).toBe(
      "(d20 AC 15) * (1d8 + 3 + (1d6) // 2) crit (2d8 + 3 + (2d6) // 2)"
    );

    const totals: Record<string, number> = {};
    for (const [, b] of attack.pmf.map.entries()) {
      for (const [k, p] of Object.entries(b.count ?? {})) {
        totals[k] = (totals[k] ?? 0) + (p as number);
      }
    }
    // 0.7 miss / 0.25 hit / 0.05 crit at AC 15 with a flat d20.
    expect(totals.missNone).toBeCloseTo(0.7, 6);
    expect(totals.hit).toBeCloseTo(0.25, 6);
    expect(totals.crit).toBeCloseTo(0.05, 6);
  });
});
