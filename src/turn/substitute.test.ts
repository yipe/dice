import { describe, expect, it } from "vitest";
import {
  bounce,
  d4,
  d6,
  d8,
  d10,
  d12,
  d20,
  keepBestDamage,
  roll,
  turn,
  Turn,
  TurnSpecError,
} from "../builder";
import type { AttackBuilder, Transform } from "../builder";
import { Mixture } from "../pmf/mixture";
import { PMF } from "../pmf/pmf";
import { inspectTurn } from "./turn";

function pmfMaxDiff(actual: PMF, expected: PMF): number {
  const support = new Set([...actual.support(), ...expected.support()]);
  let worst = 0;
  for (const value of support) {
    worst = Math.max(worst, Math.abs(actual.pAt(value) - expected.pAt(value)));
  }
  return worst;
}

function expectSamePMF(actual: PMF, expected: PMF, tolerance = 1e-12): void {
  expect(pmfMaxDiff(actual, expected)).toBeLessThan(tolerance);
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(TurnSpecError);
    return (error as TurnSpecError).code;
  }
  return undefined;
}

/** Mean of `label`'s slice given that label — a payload mean read off a one-attack turn. */
function conditionalMean(pmf: PMF, label: string): number {
  const slice = pmf.filterOutcome(label);
  return slice.mean() / slice.mass();
}

/** Exact totals of `count` dice with `sides` faces, plus a flat `bonus`. */
function diceTotals(count: number, sides: number, bonus = 0): Map<number, number> {
  let dist = new Map<number, number>([[bonus, 1]]);
  for (let i = 0; i < count; i++) {
    const next = new Map<number, number>();
    for (const [total, p] of dist) {
      for (let face = 1; face <= sides; face++) {
        next.set(total + face, (next.get(total + face) ?? 0) + p / sides);
      }
    }
    dist = next;
  }
  return dist;
}

/** E[max(x, X')] for a fresh X' from `dist`. */
function keepBetter(x: number, dist: Map<number, number>): number {
  let mean = 0;
  for (const [value, p] of dist) mean += p * Math.max(x, value);
  return mean;
}

function meanOf(dist: Map<number, number>): number {
  let mean = 0;
  for (const [value, p] of dist) mean += p * value;
  return mean;
}

// d20+5 vs AC 12: miss on 1-6, hit on 7-19, crit on 20.
const P_MISS = 0.3;
const P_HIT = 0.65;
const P_CRIT = 0.05;
const ODDS = { miss: P_MISS, hit: P_HIT, crit: P_CRIT };
type Mode = keyof typeof ODDS;
const MODES: Mode[] = ["miss", "hit", "crit"];

/** Base payload totals by mode: what the threshold compares. */
type Payloads = { hit: Map<number, number>; crit: Map<number, number> };
/** `2d6+3`, auto-doubled on a crit to `4d6+3`. */
const O20_PAYLOADS: Payloads = { hit: diceTotals(2, 6, 3), crit: diceTotals(4, 6, 3) };

/** A watched attack that landed, in turn order, and whether the rules still let a later watched attack land. */
type Landing = { mode: "hit" | "crit"; laterCanLand: boolean };

/**
 * Exact E[damage] of one path's landings under the once-per-turn keep-the-better
 * reroll: a landing spends it when its base payload total is below the mode's
 * threshold, or when no later watched attack can still land; otherwise it holds.
 * `null` thresholds spend on the first landing.
 */
function pathMean(
  landings: readonly Landing[],
  thresholds: { hit: number; crit: number } | null,
  payloads: Payloads,
  from = 0,
  unspent = true
): number {
  if (from === landings.length) return 0;
  const { mode, laterCanLand } = landings[from];
  const dist = payloads[mode];
  if (!unspent) return meanOf(dist) + pathMean(landings, thresholds, payloads, from + 1, false);
  let mean = 0;
  for (const [x, p] of dist) {
    const spends = thresholds === null || !laterCanLand || x < thresholds[mode];
    mean += spends
      ? p * (keepBetter(x, dist) + pathMean(landings, thresholds, payloads, from + 1, false))
      : p * (x + pathMean(landings, thresholds, payloads, from + 1, true));
  }
  return mean;
}

/**
 * O20/O27 by exact enumeration: two `d20+5` vs AC 12 attacks, a once-per-turn
 * keep-the-better reroll spent under a threshold policy. Attack 1 can always be
 * followed by attack 2; attack 2 is the last. `strictLast` applies the threshold
 * on the last attack too — the wrong reading of the policy.
 */
function exactPolicyMean(
  thresholds: { hit: number; crit: number } | null,
  strictLast = false,
  payloads: Payloads = O20_PAYLOADS
): number {
  let total = 0;
  for (const one of MODES) {
    for (const two of MODES) {
      const landings: Landing[] = [];
      if (one !== "miss") landings.push({ mode: one, laterCanLand: true });
      if (two !== "miss") landings.push({ mode: two, laterCanLand: strictLast });
      total += ODDS[one] * ODDS[two] * pathMean(landings, thresholds, payloads);
    }
  }
  return total;
}

const o20Attack = d20.plus(5).ac(12).onHit(roll(2, d6).plus(3));
const o20Turn = turn([o20Attack, o20Attack]);

describe("keepBestDamage() — exactness", () => {
  it("O7: two d20+5 vs AC 12 attacks for 1d4 match a brute-force enumeration of every die", () => {
    type Outcome = { p: number; lands: boolean; base: number; better: number };
    const outcomes: Outcome[] = [];
    for (let r = 1; r <= 20; r++) {
      if (r === 1 || (r !== 20 && r + 5 < 12)) {
        outcomes.push({ p: 1 / 20, lands: false, base: 0, better: 0 });
        continue;
      }
      const dice = r === 20 ? 2 : 1; // a crit doubles the dice
      const faces = 4 ** dice;
      for (let first = 0; first < faces; first++) {
        for (let second = 0; second < faces; second++) {
          const sum = (code: number): number =>
            dice === 1 ? code + 1 : (code % 4) + 1 + Math.floor(code / 4) + 1;
          outcomes.push({
            p: 1 / 20 / (faces * faces),
            lands: true,
            base: sum(first),
            better: Math.max(sum(first), sum(second)),
          });
        }
      }
    }
    const expected = new Map<number, number>();
    for (const one of outcomes) {
      for (const two of outcomes) {
        // Spent on the first landing attack; the other deals its own roll.
        const total = one.lands ? one.better + two.base : two.better;
        expected.set(total, (expected.get(total) ?? 0) + one.p * two.p);
      }
    }

    const attack = d20.plus(5).ac(12).onHit(roll(1, d4));
    const actual = turn([attack, attack]).onFirstHit(keepBestDamage()).pmf;
    expectSamePMF(actual, PMF.fromMap(expected));
    expect(actual.mass()).toBeCloseTo(1, 12);
  });

  it("a single attack equals the attack with its hit and crit payloads passed through maxOfTwo", () => {
    const resolution = o20Attack.resolve();
    const expected = Mixture.mix([
      ["hit", resolution.hitBase.maxOfTwo(), resolution.weights.hit],
      ["crit", resolution.critBase.maxOfTwo(), resolution.weights.crit],
      ["missNone", PMF.delta(0), resolution.weights.miss],
    ]);
    const actual = turn(o20Attack).onFirstHit(keepBestDamage()).pmf;
    expectSamePMF(actual, expected);
    expect(actual.outcomes().sort()).toEqual(["crit", "hit", "missNone"]);
  });

  it("a crit transforms the already-doubled crit payload, never the doubled-then-pooled figure", () => {
    const pmf = turn(o20Attack).onFirstHit(keepBestDamage()).pmf;
    expect(conditionalMean(pmf, "hit")).toBeCloseTo(11.3719, 4);
    expect(conditionalMean(pmf, "crit")).toBeCloseTo(18.9334, 4);
    expect(conditionalMean(pmf, "crit")).not.toBeCloseTo(22.7438, 1); // Defect B
  });

  it("leaves the miss slice untouched and total mass at 1", () => {
    const single = turn(o20Attack);
    expectSamePMF(
      single.onFirstHit(keepBestDamage()).pmf.filterOutcome("missNone"),
      single.pmf.filterOutcome("missNone")
    );
    const substituted = o20Turn.onFirstHit(keepBestDamage()).pmf;
    expect(substituted.pAt(0)).toBeCloseTo(0.09, 12);
    expect(substituted.mass()).toBeCloseTo(1, 12);
  });

  it("O20: scores 15.9849 under the first-landing policy — below the 16.1889 optimum it does not reach", () => {
    expect(o20Turn.mean()).toBeCloseTo(14.7, 4);
    const mean = o20Turn.onFirstHit(keepBestDamage()).mean();
    expect(mean).toBeCloseTo(15.9849, 4);
    expect(mean).toBeCloseTo(exactPolicyMean(null), 9);
    expect(mean).toBeLessThan(16.1889);
  });

  it("three copies of one attack gain strictly less than 3x the single-attack gain", () => {
    const gain = (count: number): number => {
      const plain = turn().attacks(count, o20Attack);
      return plain.onFirstHit(keepBestDamage()).mean() - plain.mean();
    };
    expect(gain(3)).toBeGreaterThan(gain(1));
    expect(gain(3)).toBeLessThan(3 * gain(1));
  });
});

describe("O9: split equivalence (R14) — onHit(2d6+5+2d6) vs onHit(2d6+5) + onEveryHit(2d6)", () => {
  it("full turn PMF matches bin for bin over the same two attacks, both mean 28.0000", () => {
    const base = d20.plus(9).ac(16);
    const folded = base.onHit(roll(2, d6).plus(5).plus(2, d6));
    const split = base.onHit(roll(2, d6).plus(5));
    const foldedTurn = turn([folded, folded]);
    const splitTurn = turn([split, split]).onEveryHit(roll(2, d6));
    expectSamePMF(foldedTurn.pmf, splitTurn.pmf);
    expect(foldedTurn.mean()).toBeCloseTo(28, 10);
    expect(splitTurn.mean()).toBeCloseTo(28, 10);
  });
});

describe("O20: optimal-vs-first-hit gain ratio at P(hit)=0.65 (R25, no-crit reading)", () => {
  // The engine has no direct P(hit) knob, so build an attack that lands on exactly 13 of 20
  // rolls (65%) with crit weight forced to 0 via noCrit() — miss 0.35, hit 0.65, crit 0. That is
  // the reading the plan's headline ratio actually uses: the audit's re-derivation confirmed
  // counting the O20 setup's own crit slice (hit 0.65, crit 0.05) instead gives
  // 1.158736 / 1.339681 / 1.510045, which does not match the plan's 1.136 / 1.300 / 1.456.
  const noCritAttack = d20.plus(0).ac(8).onHit(roll(2, d6)).noCrit();

  it("crit weight is exactly 0 and hit is exactly 0.65", () => {
    const weights = noCritAttack.resolve().weights;
    expect(weights.crit).toBe(0);
    expect(weights.hit).toBeCloseTo(0.65, 12);
    expect(weights.miss).toBeCloseTo(0.35, 12);
  });

  const payload = diceTotals(2, 6);
  const payloadMean = meanOf(payload);
  const p = 0.65;

  /**
   * Backward induction (R25): the expected value the unspent reroll still adds with `k` future
   * landing opportunities (including the one about to resolve) left, under optimal play.
   * `optimalValueAdd(0) = 0` makes the last opportunity always spend — the spend-now gain
   * `keepBetter(x, payload) - x` is never negative.
   */
  function optimalValueAdd(k: number): number {
    if (k === 0) return 0;
    const remaining = optimalValueAdd(k - 1);
    let landingContribution = 0;
    for (const [x, prob] of payload) {
      landingContribution += prob * Math.max(keepBetter(x, payload) - x, remaining);
    }
    return p * landingContribution + (1 - p) * remaining;
  }

  const rows: { n: number; expectedRatio: number }[] = [
    { n: 2, expectedRatio: 1.136 },
    { n: 3, expectedRatio: 1.3 },
    { n: 4, expectedRatio: 1.456 },
  ];

  for (const row of rows) {
    it(`n=${row.n}: optimal recovers ${row.expectedRatio}x first-hit's gain`, () => {
      const attacks = Array.from({ length: row.n }, () => noCritAttack);
      const noFeature = turn(attacks).mean();
      const firstHit = turn(attacks).onFirstHit(keepBestDamage()).mean();
      const optimal = row.n * p * payloadMean + optimalValueAdd(row.n);
      const ratio = (optimal - noFeature) / (firstHit - noFeature);
      expect(ratio).toBeCloseTo(row.expectedRatio, 3);
    });
  }
});

describe("keepBestDamage() — firing", () => {
  it("fireProbability is P(spent): P(at least one watched attack lands) under the default policy", () => {
    const t = o20Turn.onFirstHit(keepBestDamage(), { id: "reroll" });
    expect(t.fireProbability("reroll")).toBeCloseTo(0.91, 12);
    expect(t.substituteIds).toEqual(["reroll"]);
  });

  it("fires with a first-hit rider over the same `of`", () => {
    const weaker = d20.plus(2).ac(12).onHit(roll(2, d6).plus(3));
    const t = turn([o20Attack, weaker])
      .onFirstHit(roll(3, d6), { id: "rider" })
      .onFirstHit(keepBestDamage(), { id: "reroll" });
    expect(t.fireProbability("reroll")).toBeCloseTo(t.fireProbability("rider"), 12);
  });

  it("the rider and the substitution fire on the SAME attack, not merely with equal probability", () => {
    // attack 1 always lands (never misses, RAW crit still possible) so it is unambiguously the
    // "first landing" on every draw; attack 2's own payload is never a candidate. A mean-only
    // check (equal fireProbability) cannot catch a "fired on the wrong attack" bug: expectation
    // is additive regardless of which attack either effect actually fires on.
    const guaranteed = d20.plus(9).ac(10).alwaysHits().onHit(roll(1, d4).plus(2));
    const other = d20.plus(5).ac(12).onHit(roll(4, d8).plus(1));
    const t = turn([guaranteed, other])
      .onFirstHit(roll(1, d4), { id: "rider" })
      .onFirstHit(keepBestDamage(), { id: "reroll" });
    // Correct: both effects land on `guaranteed` every time; `other` always deals its own,
    // untransformed damage.
    const expected =
      turn(guaranteed)
        .onFirstHit(roll(1, d4), { id: "rider" })
        .onFirstHit(keepBestDamage(), { id: "reroll" })
        .mean() + turn(other).mean();
    expect(Math.abs(t.mean() - expected)).toBeLessThan(1e-9);
    // Wrong: both the rider and the substitution mistakenly target `other`, not `guaranteed` —
    // structurally a different attack.
    const wrong =
      turn(guaranteed).mean() +
      turn(other)
        .onFirstHit(roll(1, d4), { id: "rider" })
        .onFirstHit(keepBestDamage(), { id: "reroll" })
        .mean();
    expect(Math.abs(t.mean() - wrong)).toBeGreaterThan(0.1);
  });

  it("otherwise() after a transform fires exactly when nothing watched landed (R23, R29)", () => {
    const t = o20Turn
      .onFirstHit(keepBestDamage(), { id: "reroll" })
      .otherwise(roll(1, d6), { id: "fallback" });
    expect(t.fireProbability("fallback")).toBeCloseTo(0.09, 12);
    expect(t.fireProbability("fallback")).toBeCloseTo(1 - t.fireProbability("reroll"), 12);
  });

  it("allocates no trigger group", () => {
    expect(inspectTurn(o20Turn).groupCount).toBe(0);
    expect(inspectTurn(o20Turn.onFirstHit(keepBestDamage())).groupCount).toBe(0);
    const withRider = o20Turn.onFirstHit(roll(3, d6));
    expect(inspectTurn(withRider).groupCount).toBe(1);
    expect(inspectTurn(withRider.onFirstHit(keepBestDamage())).groupCount).toBe(1);
  });

  it("disjoint `of` sets are legal: each substitute fires once, on its own attack", () => {
    const t = o20Turn
      .onFirstHit(keepBestDamage(), { id: "first", of: ["attack 1"] })
      .onFirstHit(keepBestDamage(), { id: "second", of: ["attack 2"] });
    expect(t.fireProbability("first")).toBeCloseTo(0.7, 12);
    expect(t.fireProbability("second")).toBeCloseTo(0.7, 12);
  });

  it("halfOnMiss's missDamage is not a landing: riders fire as often, and the substitution never touches it", () => {
    const weapon = d20.plus(9).ac(16).onHit(roll(2, d6).plus(5));
    const halved = weapon.halfOnMiss();
    const plain = turn([weapon, weapon]);
    const half = turn([halved, halved]);
    const a = plain.onFirstHit(roll(3, d6), { id: "first" }).onEveryHit(d6, { id: "every" });
    const b = half.onFirstHit(roll(3, d6), { id: "first" }).onEveryHit(d6, { id: "every" });
    expect(b.fireProbability("first")).toBeCloseTo(a.fireProbability("first"), 12);
    expect(b.fireProbability("every")).toBeCloseTo(a.fireProbability("every"), 12);
    expect(half.onFirstHit(keepBestDamage(), { id: "r" }).fireProbability("r")).toBeCloseTo(
      plain.onFirstHit(keepBestDamage(), { id: "r" }).fireProbability("r"),
      12
    );
    const single = turn(halved);
    expectSamePMF(
      single.onFirstHit(keepBestDamage()).pmf.filterOutcome("missDamage"),
      single.pmf.filterOutcome("missDamage")
    );
  });
});

describe("keepBestDamage() — base payload only (R14, R26)", () => {
  const fireBlade = (ac = 16): AttackBuilder =>
    d20.plus(9).ac(ac).onHit(roll(2, d6).plus(5)).plusSeparateDamage(roll(2, d6));

  it("O10: rerolls the weapon dice and never the separate channel", () => {
    const pmf = turn(fireBlade()).onFirstHit(keepBestDamage()).pmf;
    expect(conditionalMean(turn(fireBlade()).pmf, "hit")).toBeCloseTo(19, 4);
    expect(conditionalMean(pmf, "hit")).toBeCloseTo(20.3719, 4);
    expect(conditionalMean(pmf, "hit")).not.toBeCloseTo(20.9334, 2); // channel rerolled too
    expect(conditionalMean(pmf, "crit")).toBeCloseTo(34.9334, 4);
    expect(conditionalMean(pmf, "crit")).not.toBeCloseTo(35.7296, 2);
  });

  it("O11: the end-to-end fire-blade turn scores 31.0604, and never moves miss mass", () => {
    const weapon = fireBlade().rerollDamage(2);
    expect(turn(weapon).mean()).toBeCloseTo(15, 4);
    expect(turn([weapon, weapon]).mean()).toBeCloseTo(30, 4);
    const t = turn([weapon, weapon]).onFirstHit(keepBestDamage());
    expect(t.mean()).toBeCloseTo(31.0604, 4);
    expect(t.pmf.pAt(0)).toBeCloseTo(0.09, 12);

    // Wrong spelling 1: the fire folded into the base payload, so it is rerolled too.
    const folded = d20.plus(9).ac(16).onHit(roll(2, d6).reroll(2).plus(5).plus(2, d6));
    const wrongFire = turn([folded, folded]).onFirstHit(keepBestDamage());
    expect(wrongFire.mean()).toBeCloseTo(31.665, 4);
    expect(t.mean()).not.toBeCloseTo(wrongFire.mean(), 2);
    expect(wrongFire.pmf.pAt(0)).toBeCloseTo(0.09, 12);

    // Wrong spelling 2: applied per attack instead of once per turn.
    const perAttack = 2 * turn(weapon).onFirstHit(keepBestDamage()).mean();
    expect(perAttack).toBeCloseTo(31.6314, 4);
    expect(t.mean()).not.toBeCloseTo(perAttack, 2);
  });

  it("O12: rerollDamage and the substitution compose sublinearly — the transform sees modified dice", () => {
    const weapon = d20.plus(9).ac(16).onHit(roll(2, d6).plus(5));
    const hitMean = (t: Turn): number => conditionalMean(t.pmf, "hit");
    expect(hitMean(turn(weapon))).toBeCloseTo(12, 4);
    expect(hitMean(turn(weapon.rerollDamage(2)))).toBeCloseTo(13.3333, 4);
    expect(hitMean(turn(weapon).onFirstHit(keepBestDamage()))).toBeCloseTo(13.3719, 4);
    const both = hitMean(turn(weapon.rerollDamage(2)).onFirstHit(keepBestDamage()));
    expect(both).toBeCloseTo(14.4649, 4);
    expect(both).not.toBeCloseTo(14.7052, 2); // additive: the transform ran on unmodified dice

    const fire = fireBlade();
    expect(turn([fire, fire]).mean()).toBeCloseTo(28, 4);
    expect(turn([fire, fire].map((a) => a.rerollDamage(2))).mean()).toBeCloseTo(30, 4);
    expect(turn([fire, fire]).onFirstHit(keepBestDamage()).mean()).toBeCloseTo(29.2849, 4);
    const rerolled = fire.rerollDamage(2);
    expect(turn([rerolled, rerolled]).onFirstHit(keepBestDamage()).mean()).toBeCloseTo(31.0604, 4);
  });

  it("O21: the transform runs before the every-hit fold, so the fold's dice are never rerolled", () => {
    const weapon = d20.plus(9).ac(16).onHit(roll(2, d6).plus(5));
    const pmf = turn(weapon).onEveryHit(roll(1, d6)).onFirstHit(keepBestDamage()).pmf;
    expect(conditionalMean(pmf, "hit")).toBeCloseTo(16.8719, 4);
    expect(conditionalMean(pmf, "crit")).toBeCloseTo(27.9334, 4);
    expect(conditionalMean(pmf, "hit")).not.toBeCloseTo(17.1763, 2);
    expect(conditionalMean(pmf, "crit")).not.toBeCloseTo(28.3652, 2);
  });

  it("a dice-match trigger reads the base pool only: the separate channel never counts toward a match", () => {
    const orb = d20.plus(5).ac(17).onHit(roll(3, d8));
    const withFire = orb.plusSeparateDamage(roll(2, d8));
    const plain = bounce({ source: orb, max: 1 }).fireProbability("bounce 1");
    const fired = turn(withFire).onDiceMatch(["attack 1"], orb, { id: "bounce 1" });
    // P(bounce) = P(orb lands) x P(its 3d8 — never the 2d8 channel — matched).
    expect(fired.fireProbability("bounce 1")).toBeCloseTo(plain, 12);
    expect(plain).toBeCloseTo(0.4 * 0.34375 + 0.05 * 0.923096, 5);
  });
});

describe("keepBestDamage().ifBelow() — hold semantics (R25, O27)", () => {
  // Thresholds are on the base payload total: `2d6+3` on a hit, `4d6+3` on a crit.
  const rows: { name: string; thresholds: { hit: number; crit: number }; transform: () => Transform; expected: number; strictWrong?: number }[] = [
    { name: "{hit: 10, crit: 18} (the optimum)", thresholds: { hit: 10, crit: 18 }, transform: () => keepBestDamage().ifBelow({ hit: 10, crit: 18 }), expected: 16.188901, strictWrong: 16.053727 },
    { name: "{hit: 11, crit: 18}", thresholds: { hit: 11, crit: 18 }, transform: () => keepBestDamage().ifBelow({ hit: 11, crit: 18 }), expected: 16.187147 },
    { name: "10 (one number: a crit's 4d6+3 almost always holds)", thresholds: { hit: 10, crit: 10 }, transform: () => keepBestDamage().ifBelow(10), expected: 16.13419, strictWrong: 15.93429 },
    { name: "{hit: 16, crit: 28} (always spends)", thresholds: { hit: 16, crit: 28 }, transform: () => keepBestDamage().ifBelow({ hit: 16, crit: 28 }), expected: 15.984935 },
    { name: "1 (only attack 2, the last opportunity, spends)", thresholds: { hit: 1, crit: 1 }, transform: () => keepBestDamage().ifBelow(1), expected: 15.688412, strictWrong: 14.7 },
  ];

  for (const row of rows) {
    it(`ifBelow(${row.name})`, () => {
      const mean = o20Turn.onFirstHit(row.transform()).mean();
      expect(mean).toBeCloseTo(row.expected, 6);
      expect(Math.abs(mean - exactPolicyMean(row.thresholds))).toBeLessThan(1e-9);
      if (row.strictWrong !== undefined) {
        // The wrong number a threshold applied on the last attack too would give.
        expect(exactPolicyMean(row.thresholds, true)).toBeCloseTo(row.strictWrong, 6);
        expect(mean).not.toBeCloseTo(row.strictWrong, 4);
      }
    });
  }

  it("always-spend thresholds equal keepBestDamage() exactly", () => {
    expectSamePMF(
      o20Turn.onFirstHit(keepBestDamage().ifBelow({ hit: 16, crit: 28 })).pmf,
      o20Turn.onFirstHit(keepBestDamage()).pmf
    );
  });

  it("fireProbability is P(spent): 0.70 under ifBelow(1), 0.91 under the default", () => {
    expect(o20Turn.onFirstHit(keepBestDamage().ifBelow(1), { id: "r" }).fireProbability("r")).toBeCloseTo(0.7, 12);
    expect(o20Turn.onFirstHit(keepBestDamage(), { id: "r" }).fireProbability("r")).toBeCloseTo(0.91, 12);
  });

  it("needs no dice descriptor: a parsed-string or bare-PMF payload splits exactly like the builder", () => {
    const built = d20.plus(5).ac(12).onHit(roll(2, d6).plus(5));
    // An explicit crit on the parsed payload, spelled out to equal the built one's auto-doubled crit.
    const parsed = d20.plus(5).ac(12).onHit("2d6+5").onCrit("4d6+5");
    const policy = { hit: 12, crit: 20 };
    const expected = turn([built, built]).onFirstHit(keepBestDamage().ifBelow(policy)).pmf;
    expectSamePMF(turn([parsed, parsed]).onFirstHit(keepBestDamage().ifBelow(policy)).pmf, expected);
    const bare = built.toPMF();
    expectSamePMF(turn([bare, bare]).onFirstHit(keepBestDamage().ifBelow(policy)).pmf, expected);
    // And the threshold does split: it is neither always-spend nor plain.
    expect(expected.mean()).not.toBeCloseTo(turn([built, built]).onFirstHit(keepBestDamage()).pmf.mean(), 3);
  });

  it("a parsed payload with NO onCrit auto-doubles its crit like the builder (R33), and .ifBelow() still works", () => {
    const parsed = d20.plus(5).ac(12).onHit("2d6+5");
    expect(parsed.resolve().weights.crit).toBeCloseTo(0.05, 12);
    expect(parsed.resolve().weights.hit).toBeCloseTo(0.65, 12);
    const threshold = 12;
    const payloads: Payloads = { hit: diceTotals(2, 6, 5), crit: diceTotals(4, 6, 5) };
    const exact = exactPolicyMean({ hit: threshold, crit: threshold }, false, payloads);
    const mean = turn([parsed, parsed]).onFirstHit(keepBestDamage().ifBelow(threshold)).mean();
    expect(Math.abs(mean - exact)).toBeLessThan(1e-9);
    const built = d20.plus(5).ac(12).onHit(roll(2, d6).plus(5));
    // The parsed payload's crit is its dice doubled (4d6+5), exactly the plain builder attack's.
    expectSamePMF(parsed.toPMF(), built.toPMF());
    expectSamePMF(
      turn([parsed, parsed]).onFirstHit(keepBestDamage().ifBelow(threshold)).pmf,
      turn([built, built]).onFirstHit(keepBestDamage().ifBelow(threshold)).pmf
    );
  });

  it("an explicit onCrit with its own flat bonus: the crit threshold splits the crit payload's own totals", () => {
    // Hit 2d6+5, crit 4d6+10. The superseded "dice total" reading subtracted the hit's
    // +5 on both modes, which on this crit is the threshold 5 higher.
    const attack = d20.plus(5).ac(12).onHit(roll(2, d6).plus(5)).onCrit(roll(4, d6).plus(10));
    const payloads: Payloads = { hit: diceTotals(2, 6, 5), crit: diceTotals(4, 6, 10) };
    const thresholds = { hit: 12, crit: 24 };
    const mean = turn([attack, attack]).onFirstHit(keepBestDamage().ifBelow(thresholds)).mean();
    const expected = exactPolicyMean(thresholds, false, payloads);
    expect(Math.abs(mean - expected)).toBeLessThan(1e-9);
    const shifted = exactPolicyMean({ hit: 12, crit: 29 }, false, payloads);
    expect(Math.abs(mean - shifted)).toBeGreaterThan(1e-4);
  });

  it("optimally() is unsupported-policy in this release, from the factory and from plain data", () => {
    expect(codeOf(() => keepBestDamage().optimally())).toBe("unsupported-policy");
    expect(
      codeOf(() =>
        Turn.from({
          attacks: [o20Attack],
          substitutes: [{ on: "first-hit", substitute: "reroll-keep-higher", policy: { kind: "optimal" } }],
        })
      )
    ).toBe("unsupported-policy");
  });

  it("the default `of` does not sweep in dice-match beams (R22): name them to let the transform hold for one", () => {
    const orb = d20.plus(5).ac(17).onHit(roll(3, d8));
    const chain = bounce({ source: orb, max: 2 });
    // Default `of` is just the orb, so it is the last opportunity and ifBelow(1) spends there anyway.
    expectSamePMF(
      chain.onFirstHit(keepBestDamage().ifBelow(1)).pmf,
      chain.onFirstHit(keepBestDamage()).pmf
    );
    // Named beams are later opportunities — but only while one can still fire. A beam
    // follows a landing whose dice matched, so ifBelow(1) holds a matched landing (the
    // next beam will roll) and spends an unmatched one (nothing can follow it).
    const named = chain.onFirstHit(keepBestDamage().ifBelow(1), {
      id: "r",
      of: ["attack 1", "bounce 1", "bounce 2"],
    });
    const lands = orb.resolve().weights.hit + orb.resolve().weights.crit;
    const matched = chain.fireProbability("bounce 1"); // P(a landing's dice matched)
    const unmatched = lands - matched;
    // Orb unmatched: spent. Orb matched: bounce 1 rolls; unmatched spends, matched holds
    // for bounce 2, the last beam, which spends if it lands.
    const spent = unmatched + matched * (unmatched + matched * lands);
    expect(named.fireProbability("r")).toBeCloseTo(spent, 12);
    // A static "last watched step" would hold on the orb and bounce 1 whatever they rolled.
    expect(named.fireProbability("r")).not.toBeCloseTo(matched * matched * lands, 3);
  });

  /**
   * Two O20 attacks, a `first-miss` reroll of the same attack, and the transform
   * watching all three, by exact enumeration of the rules. Turn order: attack 1;
   * the reroll right after it if it missed; attack 2; the reroll right after it if
   * it missed and the reroll is unused. Attack 1 and a reroll after it are always
   * followed by attack 2. When attack 2 lands nothing can follow it: either the
   * reroll already fired, or attack 2 did not miss. The trailing reroll is last.
   * `staticLast` instead lets attack 2 hold whenever the trailing reroll's step
   * follows it in the walk — even in states where that step cannot fire.
   */
  function firstMissPolicyMean(thresholds: { hit: number; crit: number }, staticLast = false): number {
    let total = 0;
    for (const one of MODES) {
      for (const reroll of MODES) {
        for (const two of MODES) {
          const rerolls = one === "miss" || two === "miss";
          // The reroll's own outcome only exists when an attack missed.
          const pReroll = rerolls ? ODDS[reroll] : reroll === "miss" ? 1 : 0;
          const p = ODDS[one] * ODDS[two] * pReroll;
          if (p === 0) continue;
          const order: { mode: Mode; laterCanLand: boolean }[] =
            one === "miss"
              ? [{ mode: reroll, laterCanLand: true }, { mode: two, laterCanLand: staticLast }]
              : [
                  { mode: one, laterCanLand: true },
                  { mode: two, laterCanLand: staticLast },
                  ...(rerolls ? [{ mode: reroll, laterCanLand: false }] : []),
                ];
          const landings = order.filter((entry): entry is Landing => entry.mode !== "miss");
          total += p * pathMean(landings, thresholds, O20_PAYLOADS);
        }
      }
    }
    return total;
  }

  it("the last opportunity reads the walk state: with a first-miss reroll watched, attack 2 never holds", () => {
    for (const [thresholds, transform] of [
      [{ hit: 10, crit: 18 }, keepBestDamage().ifBelow({ hit: 10, crit: 18 })],
      [{ hit: 1, crit: 1 }, keepBestDamage().ifBelow(1)],
    ] as const) {
      const t = turn([o20Attack, o20Attack])
        .onFirstMiss(o20Attack, { id: "reroll" })
        .onFirstHit(transform, { id: "r", of: ["attack 1", "attack 2", "reroll"] });
      const mean = t.mean();
      expect(Math.abs(mean - firstMissPolicyMean(thresholds))).toBeLessThan(1e-9);
      expect(Math.abs(mean - firstMissPolicyMean(thresholds, true))).toBeGreaterThan(1e-3);
    }
  });
});

describe("keepBestDamage() — errors (R17, R23)", () => {
  it("two substitutes over overlapping `of` are duplicate-substitute — the guard prevents max-of-four", () => {
    expect(codeOf(() => o20Turn.onFirstHit(keepBestDamage()).onFirstHit(keepBestDamage()))).toBe(
      "duplicate-substitute"
    );
    expect(
      codeOf(() =>
        o20Turn.onFirstHit(keepBestDamage(), { of: ["attack 1"] }).onFirstHit(keepBestDamage())
      )
    ).toBe("duplicate-substitute");
    const payload = roll(2, d6).plus(5).toPMF();
    expect(payload.maxOfTwo().mean()).toBeCloseTo(13.3719, 4);
    expect(payload.maxOfTwo().maxOfTwo().mean()).toBeCloseTo(14.4935, 4);
  });

  it("a transform on any verb but onFirstHit is unsupported-trigger", () => {
    const transform = keepBestDamage() as never;
    expect(codeOf(() => o20Turn.onEveryHit(transform))).toBe("unsupported-trigger");
    expect(codeOf(() => o20Turn.onAnyCrit(transform))).toBe("unsupported-trigger");
    expect(codeOf(() => o20Turn.onAnyMiss(transform))).toBe("unsupported-trigger");
    expect(codeOf(() => o20Turn.onFirstMiss(transform))).toBe("unsupported-trigger");
    expect(codeOf(() => o20Turn.onFirstHit(d6).otherwise(transform))).toBe("unsupported-trigger");
    expect(
      codeOf(() => Turn.from({ attacks: [o20Attack], riders: [{ on: "first-hit", damage: transform }] }))
    ).toBe("unsupported-trigger");
  });

  it("an `of` naming nothing in the turn is unknown-id; naming a save is not-an-attack", () => {
    expect(codeOf(() => o20Turn.onFirstHit(keepBestDamage(), { of: ["nope"] }))).toBe("unknown-id");
    const save = d20.dc(13).onSaveFailure(roll(3, d6)).saveHalf();
    // `not-an-attack` here predates S1: `resolveSources`'s "has no hit/crit outcomes" check
    // (plan.ts) is the same mechanism riders used on `main` before this branch — S1 only
    // extended it to substitutes (R23: "a substitute or rider watching a save/bare-PMF source
    // ... already throws `has no hit/crit outcomes` ... unchanged — verified working"). The
    // plan's Tests bullet ("unknown-id for an `of` naming a non-attack") undersells this: a
    // *declared* non-attack source (like this save-shaped rider) is `not-an-attack`, not
    // `unknown-id` — a plan-text inaccuracy, reported rather than "fixed" by changing
    // pre-existing, verified-working behavior.
    expect(
      codeOf(() => o20Turn.onFirstHit(save, { id: "poison" }).onFirstHit(keepBestDamage(), { of: ["poison"] }))
    ).toBe("not-an-attack");
  });

  it(".attack()/.attacks() after a rider or substitute whose `of` defaulted is attack-after-rider", () => {
    expect(codeOf(() => turn(o20Attack).onFirstHit(d6).attack(o20Attack))).toBe("attack-after-rider");
    expect(codeOf(() => turn(o20Attack).onFirstHit(d6).attacks(2, o20Attack))).toBe("attack-after-rider");
    expect(codeOf(() => turn(o20Attack).onFirstHit(keepBestDamage()).attack(o20Attack))).toBe(
      "attack-after-rider"
    );
    // An explicit `of` opts out.
    expect(turn(o20Attack).onFirstHit(d6, { of: ["attack 1"] }).attack(o20Attack).attackIds).toEqual([
      "attack 1",
      "attack 2",
    ]);
  });

  it("a rider added before any attack fails unknown-id at that call", () => {
    expect(codeOf(() => turn().onFirstHit(d6))).toBe("unknown-id");
  });

  it("vsAC on a turn with no AC-bearing source is no-rebindable-source", () => {
    const bare = o20Attack.toPMF();
    expect(codeOf(() => turn([bare, bare]).vsAC(15))).toBe("no-rebindable-source");
  });
});

describe("`of` snapshots and defaults (R15, R18)", () => {
  const sword = d20.plus(9).ac(16).onHit(roll(1, d8).plus(5));
  const axe = d20.plus(7).ac(16).onHit(roll(1, d12).plus(4));

  it("a rider pinned to the attacks it saw ignores a later attack; the attacks-first turn agrees", () => {
    const riderFirst = turn(sword).onFirstHit(roll(3, d6), { of: ["attack 1"] }).attack(axe);
    const attacksFirst = turn([sword, axe]).onFirstHit(roll(3, d6), { of: ["attack 1"] });
    const defaulted = turn([sword, axe]).onFirstHit(roll(3, d6));
    expectSamePMF(riderFirst.pmf, attacksFirst.pmf);
    // Pin exactly what "defaulted" means (both attacks), then prove riderFirst genuinely
    // diverges from it at the PMF level, not just in the mean.
    const explicitBoth = turn([sword, axe]).onFirstHit(roll(3, d6), { of: ["attack 1", "attack 2"] });
    expectSamePMF(defaulted.pmf, explicitBoth.pmf);
    expect(pmfMaxDiff(riderFirst.pmf, defaulted.pmf)).toBeGreaterThan(0.01);
  });

  it("an attack-shaped any-miss rider joins later defaulted `of` sets — declared before, included; after, not", () => {
    const before = turn([sword, sword]).onAnyMiss(sword, { id: "reroll" }).onFirstHit(roll(1, d10));
    const explicit = turn([sword, sword])
      .onAnyMiss(sword, { id: "reroll" })
      .onFirstHit(roll(1, d10), { of: ["attack 1", "attack 2", "reroll"] });
    const after = turn([sword, sword]).onFirstHit(roll(1, d10)).onAnyMiss(sword, { id: "reroll" });
    const excluded = turn([sword, sword])
      .onAnyMiss(sword, { id: "reroll" })
      .onFirstHit(roll(1, d10), { of: ["attack 1", "attack 2"] });
    expectSamePMF(before.pmf, explicit.pmf);
    expectSamePMF(after.pmf, excluded.pmf);
    expect(before.mean()).toBeGreaterThan(after.mean());
  });

  it("a damage-shaped any-miss rider never joins", () => {
    const t = turn([sword, sword]).onAnyMiss(roll(1, d6), { id: "consolation" }).onFirstHit(roll(1, d10), { id: "r" });
    const plain = turn([sword, sword]).onAnyMiss(roll(1, d6), { id: "consolation" }).onFirstHit(roll(1, d10), { id: "r", of: ["attack 1", "attack 2"] });
    expectSamePMF(t.pmf, plain.pmf);
  });

  it("Turn.from keeps the plan-time default: every declared attack", () => {
    const fromSpec = Turn.from({ attacks: [sword, axe], riders: [{ on: "first-hit", damage: roll(3, d6) }] });
    expectSamePMF(fromSpec.pmf, turn([sword, axe]).onFirstHit(roll(3, d6)).pmf);
  });

  it("a tag expands to every attack carrying it; an unknown tag is unknown-id", () => {
    const tagged = turn()
      .attack(sword, { tag: "blade" })
      .attack(axe)
      .attacks(2, sword, { tag: "blade" })
      .onFirstHit(roll(3, d6), { of: ["blade"] });
    const explicit = turn([sword, axe, sword, sword]).onFirstHit(roll(3, d6), {
      of: ["attack 1", "attack 3", "attack 4"],
    });
    expectSamePMF(tagged.pmf, explicit.pmf);
    expect(codeOf(() => turn().attack(sword, { tag: "blade" }).onFirstHit(d6, { of: ["hammer"] }))).toBe(
      "unknown-id"
    );
  });
});

describe("vsAC (R18)", () => {
  const build = (ac: number): Turn => {
    const musket = d20.plus(9).ac(ac).onHit(roll(1, d12).plus(18));
    const poison = d20.dc(14).onSaveFailure(roll(2, d6)).saveHalf();
    return turn([musket, musket])
      .onAnyMiss(musket, { id: "reroll" })
      .onFirstHit(roll(1, d10))
      .onEveryHit(poison)
      .onFirstHit(keepBestDamage());
  };

  it("rebinds declared attacks and rider-carried attacks; a save passes through unchanged", () => {
    for (const ac of [12, 18, 21]) {
      expectSamePMF(build(15).vsAC(ac).pmf, build(ac).pmf);
    }
    expect(build(15).vsAC(18).mean()).not.toBeCloseTo(build(15).mean(), 2);
  });
});

describe("state count (R31)", () => {
  it("a turn with no state-dependent step keeps 0.11.0's merge-key count at every step (O13 turn)", () => {
    const musket = d20.plus(9).ac(15).onHit(roll(1, d12).plus(1, d4).plus(18));
    const t = turn([musket, musket])
      .onAnyMiss(musket, { id: "reroll" })
      .onFirstHit(roll(1, d10), { of: ["attack 1", "attack 2", "reroll"] });
    // 8997/160 exactly; the plan prints 56.2313 (4dp), which sits exactly 5e-5 from this value —
    // a toBeCloseTo(…, 4) boundary that passes or fails on float noise. Pin the exact figure.
    expect(t.mean()).toBeCloseTo(56.23125, 10);
    // Measured on 0.11.0 (the published engine) with the same turn.
    expect(inspectTurn(t).stateCounts).toEqual([3, 6, 7, 3]);
  });
});

describe("O17: a substitution must see the reroll (R17)", () => {
  const rows = [
    { ac: 15, baseline: 56.23125, withReroll: 58.2388, without: 58.1432 },
    { ac: 18, baseline: 49.533, withReroll: 51.4544, without: 51.2573 },
    { ac: 21, baseline: 40.342875, withReroll: 42.0726, without: 41.7902 },
  ];
  for (const row of rows) {
    it(`AC ${row.ac}`, () => {
      const musket = d20.plus(9).ac(row.ac).onHit(roll(1, d12).plus(18)).plusSeparateDamage(roll(1, d4));
      const base = turn([musket, musket])
        .onAnyMiss(musket, { id: "reroll" })
        .onFirstHit(roll(1, d10), { of: ["attack 1", "attack 2", "reroll"] });
      // Exact rational baseline (no /3 term survives a dice-total mean), so the plan's 4dp
      // figure can sit exactly at the toBeCloseTo(…, 4) boundary (AC 15 does). Assert precisely.
      expect(base.mean()).toBeCloseTo(row.baseline, 10);
      // The default `of` sees the reroll (R18), so the short spelling is the right one.
      expect(base.onFirstHit(keepBestDamage()).mean()).toBeCloseTo(row.withReroll, 4);
      const withoutReroll = base.onFirstHit(keepBestDamage(), { of: ["attack 1", "attack 2"] }).mean();
      expect(withoutReroll).toBeCloseTo(row.without, 4);
      expect(withoutReroll).not.toBeCloseTo(row.withReroll, 2);
    });
  }
});
