import { describe, expect, it } from "vitest";
import "../src/builder/ac";
import { d20, flat } from "../src/builder/factory";
import { Turn } from "../src/turn";

/**
 * d20+8 vs AC 16, 5 flat damage on a landing: miss on 1-7 (0.35), hit on 8-19
 * (0.60), crit on 20 (0.05). Flat damage never doubles, so hit and crit both deal
 * exactly 5 — each d20 outcome maps to one damage value, which keeps the
 * brute-force oracle a plain enumeration with no dice to roll.
 */
const sword = d20.plus(8).ac(16).onHit(flat(5));

type Outcome = "none" | "miss" | "hit" | "crit";

const resolve = (r: number): Outcome => (r === 20 ? "crit" : r >= 8 ? "hit" : "miss");
const damageOf = (o: Outcome): number => (o === "hit" || o === "crit" ? 5 : 0);

/** Exact mean by enumerating every d20 pair and the occurrence branch. */
function oracleMean(c: number, riders: { firstHit?: number; firstMiss?: number } = {}): number {
  const riderDamage = (outcomes: readonly Outcome[]): number => {
    let d = 0;
    if (riders.firstHit && outcomes.some((o) => o === "hit" || o === "crit")) d += riders.firstHit;
    if (riders.firstMiss && outcomes.some((o) => o === "miss")) d += riders.firstMiss;
    return d;
  };

  let total = 0;
  // Attack 1 does not happen: its outcome is "none" for every r2.
  for (let r2 = 1; r2 <= 20; r2++) {
    const o2 = resolve(r2);
    total += ((1 - c) / 20) * (damageOf(o2) + riderDamage(["none", o2]));
  }
  // Attack 1 happens: enumerate r1 and r2.
  for (let r1 = 1; r1 <= 20; r1++) {
    for (let r2 = 1; r2 <= 20; r2++) {
      const o1 = resolve(r1);
      const o2 = resolve(r2);
      total += (c / 400) * (damageOf(o1) + damageOf(o2) + riderDamage([o1, o2]));
    }
  }
  return total;
}

describe("attack({ source, chance })", () => {
  it("mean() matches the brute-force oracle for a bare gated turn", () => {
    for (const c of [0, 0.25, 0.5, 0.75, 1]) {
      const t = Turn.from({ attacks: [{ source: sword, chance: c }, sword] });
      expect(t.mean()).toBeCloseTo(oracleMean(c), 12);
    }
  });

  it("interacts with a first-hit rider: a not-happened attack is no landing", () => {
    for (const c of [0, 0.3, 0.5, 0.8, 1]) {
      const t = Turn.from({
        attacks: [{ source: sword, chance: c }, sword],
        riders: [{ id: "rider", damage: flat(10), on: "first-hit" }],
      });
      expect(t.mean()).toBeCloseTo(oracleMean(c, { firstHit: 10 }), 12);
      // A 10-damage rider adds 10 exactly when it fires, so its fire probability
      // is the mean's rider share over 10.
      const fire = (oracleMean(c, { firstHit: 10 }) - oracleMean(c)) / 10;
      expect(t.fireProbability("rider")).toBeCloseTo(fire, 12);
    }
  });

  it("interacts with a first-miss rider: a not-happened attack is no miss", () => {
    for (const c of [0, 0.3, 0.5, 0.8, 1]) {
      const t = Turn.from({
        attacks: [{ source: sword, chance: c }, sword],
        riders: [{ id: "rider", damage: flat(10), on: "first-miss" }],
      });
      expect(t.mean()).toBeCloseTo(oracleMean(c, { firstMiss: 10 }), 12);
      const fire = (oracleMean(c, { firstMiss: 10 }) - oracleMean(c)) / 10;
      expect(t.fireProbability("rider")).toBeCloseTo(fire, 12);
    }
  });

  it("chance 1 is byte-identical to omitting it", () => {
    const withChance = Turn.from({ attacks: [{ source: sword, chance: 1 }, sword] });
    const without = Turn.from({ attacks: [sword, sword] });
    expect(withChance.pmf.fingerprint()).toBe(without.pmf.fingerprint());
    expect(withChance.mean()).toBe(without.mean());
  });

  it("chance 0 contributes nothing and never fires a miss or landing", () => {
    const t = Turn.from({ attacks: [{ source: sword, chance: 0 }, sword] });
    expect(t.mean()).toBeCloseTo(oracleMean(0), 12);
    expect(t.pmf.pAt(0)).toBeCloseTo(0.35, 12); // only the second attack can whiff
    expect(t.stepStats("attack 1").hit).toBe(0);
    expect(t.stepStats("attack 1").crit).toBe(0);
    expect(t.stepStats("attack 2").hit).toBeCloseTo(0.65, 12);
  });

  it("stepStats and toQuery agree with the walk", () => {
    const t = Turn.from({ attacks: [{ source: sword, chance: 0.5 }, sword] });
    expect(t.stepStats("attack 1").rolled).toBeCloseTo(1, 12);
    expect(t.stepStats("attack 1").hit).toBeCloseTo(0.5 * 0.65, 12);
    expect(t.stepStats("attack 1").crit).toBeCloseTo(0.5 * 0.05, 12);
    expect(t.toQuery().mean()).toBeCloseTo(t.mean(), 12);
  });

  it("a gated turn's chart conserves mass", () => {
    const t = Turn.from({ attacks: [{ source: sword, chance: 0.5 }, sword] });
    const mass = t
      .toQuery()
      .combinedWithAttribution()
      .damageAttributionChartModel()
      .totals.reduce((a, b) => a + b, 0);
    expect(mass).toBeCloseTo(1, 12);
  });
});
