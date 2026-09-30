import { describe, expect, it } from "vitest";
import "../src/builder/ac";
import { advantage, d20, flat } from "../src/builder";
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

  it("rejects a chance outside [0, 1]", () => {
    expect(() => Turn.from({ attacks: [{ source: sword, chance: 1.5 }] })).toThrow(RangeError);
    expect(() => Turn.from({ attacks: [{ source: sword, chance: -0.1 }] })).toThrow(RangeError);
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

/**
 * A next-attack grant, by enumeration. `granter` is d20+5 vs AC 15 (a landing on 10-20)
 * for 10 flat, and a landing grants advantage on the next attack that happens. `plain`
 * is the same attack with no grant. Each attack is a d20, or the better of two under
 * advantage; a skipped attack rolls nothing and leaves a pending grant alone.
 */
const granter = d20.plus(5).ac(15).onHit(flat(10)).onEveryHit(advantage().untilNextAttack());
const plain = d20.plus(5).ac(15).onHit(flat(10));

interface Swing {
  grants: boolean;
  chance: number;
}

function grantOracle(swings: readonly Swing[]): { mean: number; advantage: number[] } {
  const lands = (roll: number): boolean => roll >= 10;
  // P(landing) for a swing rolled straight and with advantage, by listing the rolls.
  let straight = 0;
  let advantaged = 0;
  for (let a = 1; a <= 20; a++) {
    if (lands(a)) straight += 1 / 20;
    for (let b = 1; b <= 20; b++) if (lands(Math.max(a, b))) advantaged += 1 / 400;
  }
  const live = swings.map(() => 0);
  let mean = 0;
  // `pending` is the mass in which a grant is waiting; the rest has none.
  const walk = (index: number, pending: number, none: number): void => {
    if (index === swings.length) return;
    const { grants, chance } = swings[index];
    live[index] += pending;
    const landed = chance * (pending * advantaged + none * straight);
    const missed = chance * (pending * (1 - advantaged) + none * (1 - straight));
    mean += 10 * landed;
    // A swing that happens uses up a waiting grant; one that is skipped leaves it alone.
    // A landing on a granter sets a new one.
    const skipped = { pending: pending * (1 - chance), none: none * (1 - chance) };
    walk(
      index + 1,
      skipped.pending + (grants ? landed : 0),
      skipped.none + missed + (grants ? 0 : landed)
    );
  };
  walk(0, 0, 1);
  return { mean, advantage: live };
}

describe("a skipped attack and a next-attack grant", () => {
  it("chance 0 equals the turn without the attack (the case from issue 29)", () => {
    const without = Turn.from({ attacks: [granter, { source: plain, id: "last" }] });
    const skipped = Turn.from({
      attacks: [granter, { source: plain, id: "skippable", chance: 0 }, { source: plain, id: "last" }],
    });
    expect(skipped.mean()).toBeCloseTo(12.36125, 6);
    expect(skipped.mean()).toBeCloseTo(without.mean(), 12);
    expect(skipped.stepStats("last").live.advantage).toBeCloseTo(0.55, 12);
    for (const damage of [0, 10, 20, 30]) {
      expect(skipped.pmf.pAt(damage)).toBeCloseTo(without.pmf.pAt(damage), 12);
    }
  });

  it("chance 0.5 keeps the grant for the next attack half the time", () => {
    const t = Turn.from({
      attacks: [granter, { source: plain, id: "skippable", chance: 0.5 }, { source: plain, id: "last" }],
    });
    expect(t.mean()).toBeCloseTo(15.11125, 6);
    expect(t.stepStats("last").live.advantage).toBeCloseTo(0.275, 12);
  });

  const shapes: [string, Swing[]][] = [
    ["granter, skippable plain, plain", [{ grants: true, chance: 1 }, { grants: false, chance: 0.5 }, { grants: false, chance: 1 }]],
    ["granter, two skippable plains, plain", [{ grants: true, chance: 1 }, { grants: false, chance: 0.3 }, { grants: false, chance: 0.6 }, { grants: false, chance: 1 }]],
    ["skippable granter twice, plain", [{ grants: true, chance: 0.4 }, { grants: true, chance: 0.7 }, { grants: false, chance: 1 }]],
    ["granter, skippable granter, plain", [{ grants: true, chance: 1 }, { grants: true, chance: 0.25 }, { grants: false, chance: 1 }]],
    ["skippable plain first, granter, plain", [{ grants: false, chance: 0.5 }, { grants: true, chance: 1 }, { grants: false, chance: 1 }]],
  ];

  for (const [name, swings] of shapes) {
    it(`matches the enumeration: ${name}`, () => {
      for (const scale of [0, 0.5, 1]) {
        const shaped = swings.map((swing) => ({ ...swing, chance: swing.chance === 1 ? 1 : swing.chance * scale }));
        const t = Turn.from({
          attacks: shaped.map((swing, index) => ({
            source: swing.grants ? granter : plain,
            id: `swing ${index}`,
            chance: swing.chance,
          })),
        });
        const expected = grantOracle(shaped);
        expect(t.mean()).toBeCloseTo(expected.mean, 10);
        shaped.forEach((_, index) => {
          expect(t.stepStats(`swing ${index}`).live.advantage).toBeCloseTo(expected.advantage[index], 10);
        });
      }
    });
  }
});
