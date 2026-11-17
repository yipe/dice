import { describe, expect, it } from "vitest";
import { d, d4, d6, d8, d20, flat, roll, savePenalty, turn, Turn, vulnerability } from "../builder";
import type { Rng } from "../common/rng";

type Mode = "miss" | "hit" | "crit";

/** P(miss/hit/crit) for `d20 + bonus` against `ac`, crit on a natural 20 only. */
function odds(bonus: number, ac: number): Record<Mode, number> {
  const out: Record<Mode, number> = { miss: 0, hit: 0, crit: 0 };
  for (let r = 1; r <= 20; r++) out[r === 20 ? "crit" : r === 1 || r + bonus < ac ? "miss" : "hit"] += 1 / 20;
  return out;
}

const MODES: Mode[] = ["miss", "hit", "crit"];
const SWORD = { miss: 0, hit: 7.5, crit: 12 }; // 1d8+3, dice doubled on a crit
const RIDER = { miss: 0, hit: 3.5, crit: 7 }; // 1d6, doubled on a crit

/** Two attacks, a `1d6` rider on the first landing; `convert` crits the first miss. Exact enumeration. */
function enumerate(bonus: number, ac: number, convert: boolean): { mean: number; converted: number } {
  const p = odds(bonus, ac);
  let mean = 0;
  let converted = 0;
  for (const one of MODES) {
    for (const two of MODES) {
      const pr = p[one] * p[two];
      let seq: Mode[] = [one, two];
      if (convert) {
        const at = seq.indexOf("miss");
        if (at !== -1) {
          seq = seq.map((mode, i) => (i === at ? "crit" : mode));
          converted += pr;
        }
      }
      const first = seq.find((mode) => mode !== "miss") ?? "miss";
      mean += pr * (seq.reduce((sum, mode) => sum + SWORD[mode], 0) + RIDER[first]);
    }
  }
  return { mean, converted };
}

const build = (bonus: number, ac: number) => {
  const sword = d20.plus(bonus).ac(ac).onHit(roll(1, d8).plus(3));
  return turn([sword, sword]).onFirstHit(roll(1, d6));
};

describe("Turn.convertFirstMissToCrit", () => {
  for (const [bonus, ac] of [[5, 15], [5, 12], [0, 25], [9, 10]] as const) {
    it(`is exact against enumeration (d20+${bonus} vs AC ${ac})`, () => {
      const expected = enumerate(bonus, ac, true);
      const crit = build(bonus, ac).convertFirstMissToCrit({ id: "luck" });
      expect(crit.mean()).toBeCloseTo(expected.mean, 9);
      expect(crit.fireProbability("luck")).toBeCloseTo(expected.converted, 12);
    });
  }

  it("beats a plain conversion by exactly the crit's extra dice", () => {
    const plain = build(5, 15).convertFirstMiss({ id: "p" });
    const crit = build(5, 15).convertFirstMissToCrit({ id: "c" });
    const extra = (SWORD.crit - SWORD.hit) + (RIDER.crit - RIDER.hit);
    // The rider's extra dice only apply where the converted attack is the first landing.
    expect(crit.mean()).toBeGreaterThan(plain.mean());
    expect(crit.fireProbability("c")).toBeCloseTo(plain.fireProbability("p"), 12);
    expect(crit.mean() - plain.mean()).toBeLessThanOrEqual(extra * crit.fireProbability("c") + 1e-9);
  });

  it("pins the guide's example", () => {
    const attack = d20.plus(5).ac(12).onHit(roll(2, d6).plus(3));
    expect(turn([attack, attack]).convertFirstMiss().mean()).toBeCloseTo(19.8, 9);
    expect(turn([attack, attack]).convertFirstMissToCrit().mean()).toBeCloseTo(23.37, 9);
  });

  it("a converted miss deals plusNatural20Damage every time, as sampling does", () => {
    const attack = d20.ac(15).critOn(19).onHit(1).plusNatural20Damage(flat(10));
    // Misses 14/20 and each deals 1 + 10; 15-18 deal 1, 19 deals 1, 20 deals 11.
    expect(turn([attack]).convertFirstMissToCrit().mean()).toBeCloseTo(0.7 * 11 + 0.2 + 0.05 + 0.55, 12);
    // Without the extra damage the ordinary crit is already the converted one.
    const plain = d20.ac(15).critOn(19).onHit(1);
    expect(turn([plain]).convertFirstMissToCrit().mean()).toBeCloseTo(0.7 + 0.3, 12);
  });

  it("the planned mean agrees with sampling where plusNatural20Damage meets a dice-match rider", () => {
    const attack = d20.plus(3).ac(15).critOn(19).onHit(roll(2, d6)).plusNatural20Damage(roll(1, d6));
    const t = turn([attack, attack]).onDiceMatch(["attack 1", "attack 2"], roll(1, d8)).convertFirstMissToCrit();
    let state = 99;
    const rng: Rng = {
      die: (sides) => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return 1 + Math.floor((state / 2 ** 32) * sides);
      },
      chance: (p) => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 2 ** 32 < p;
      },
    };
    const n = 40000;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += t.sample(rng).total;
    expect(Math.abs(sum / n - t.mean())).toBeLessThan(0.12);
  }, 60_000);

  const seeded = (seed: number): Rng => {
    let state = seed;
    const next = (): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
    return { die: (sides) => 1 + Math.floor(next() * sides), chance: (p) => next() < p };
  };

  it("a converted crit is typed by its own damage: a dealing condition reads it", () => {
    // Ordinary crits deal cold only on a natural 20 (the 1 deals none); a converted miss always deals the 10.
    const ray = d20.ac(15).critOn(19).onHit(0).plusNatural20Damage(flat(10)).typed("cold");
    const save = d20.plus(3).dc(14).onSaveFailure(d("3d6")).saveHalf();
    const t = turn([ray, save])
      .convertFirstMissToCrit({ of: ["attack 1"] })
      .onFirstHit(savePenalty(d4).untilNextSave(), { dealing: "cold", of: ["attack 1"] });
    // The 10 is dealt by 0.7 (converted misses) + 0.05 (a natural 20); the other landings deal nothing.
    const mean = (penalised: boolean): number => {
      let roll = d20.plus(3);
      if (penalised) roll = roll.minus(1, d4);
      return roll.dc(14).onSaveFailure(d("3d6")).saveHalf().mean();
    };
    expect(t.mean()).toBeCloseTo(0.75 * 10 + 0.75 * mean(true) + 0.25 * mean(false), 9);
  }, 60_000);

  it("a converted crit on a vulnerable row doubles the natural-20 damage, as sampling does", () => {
    const grant = d20.ac(15).critOn(19).onHit(1).onEveryHit(vulnerability().untilNextHit());
    const attack = d20.ac(15).critOn(19).onHit(1).plusNatural20Damage(flat(10));
    const t = turn([grant, attack]).convertFirstMissToCrit();
    const rng = seeded(5);
    const n = 150000;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += t.sample(rng).total;
    expect(Math.abs(sum / n - t.mean())).toBeLessThan(0.05);
  }, 60_000);

  it("round-trips through Turn.from as plain data", () => {
    const sword = d20.plus(5).ac(15).onHit(roll(1, d8).plus(3));
    const spec = Turn.from({ attacks: [sword, sword], substitutes: [{ id: "luck", on: "first-miss", substitute: "crit" }] });
    expect(spec.mean()).toBeCloseTo(turn([sword, sword]).convertFirstMissToCrit({ id: "luck" }).mean(), 12);
  });

  it("is refused as a second conversion over the same attacks", () => {
    expect(() => build(5, 15).convertFirstMiss().convertFirstMissToCrit().mean()).toThrow(/duplicate-substitute|both watch/);
  });

  it("sampling agrees with the exact mean", () => {
    let state = 12345;
    const rng: Rng = {
      die: (sides) => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return 1 + Math.floor((state / 2 ** 32) * sides);
      },
      chance: (p) => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 2 ** 32 < p;
      },
    };
    const crit = build(5, 15).convertFirstMissToCrit();
    const n = 40000;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += crit.sample(rng).total;
    expect(sum / n).toBeCloseTo(crit.mean(), 0);
  });
});
