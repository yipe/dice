import { describe, expect, it } from "vitest";
import {
  advantage,
  critOnHit,
  d4,
  d6,
  d8,
  d10,
  d12,
  d20,
  disadvantage,
  keepBestDamage,
  roll,
  turn,
  Turn,
  TurnSpecError,
} from "../builder";
import type { RiderDamage } from "../builder";
import { PMF } from "../pmf/pmf";
import { inspectTurn } from "./turn";
import { MAX_TRIGGER_GROUPS } from "./types";

// Every oracle below: `d20+5` vs AC 12 (flat miss 0.30 / hit 0.65 / crit 0.05; advantage
// 0.09 / 0.8125 / 0.0975), `1d8+3` on a hit, `2d8+3` on a crit. Expected values are exact
// fractions from an independent state DP, pinned to 1e-9.
const sword = d20.plus(5).ac(12).onHit(roll(1, d8).plus(3));
const FLAT = 5.475;
const ADVANTAGE = 7.26375;
const DISADVANTAGE = 0.4875 * 7.5 + 0.0025 * 12;

function pmfMaxDiff(actual: PMF, expected: PMF): number {
  const support = new Set([...actual.support(), ...expected.support()]);
  let worst = 0;
  for (const value of support) {
    worst = Math.max(worst, Math.abs(actual.pAt(value) - expected.pAt(value)));
  }
  return worst;
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof TurnSpecError ? error.code : `not a TurnSpecError: ${String(error)}`;
  }
  return undefined;
}

describe("O25: advantage on the next attack, two attacks — the smallest case", () => {
  const t = turn([sword, sword]).onEveryHit(advantage().untilNextAttack(), { id: "next" });

  it("mean is 12.202125: attack 2 has advantage exactly when attack 1 landed", () => {
    expect(t.mean()).toBeCloseTo(12.202125, 9);
    expect(t.mean()).toBeCloseTo(FLAT + 0.3 * FLAT + 0.7 * ADVANTAGE, 9);
    expect(t.pmf.pAt(0)).toBeCloseTo(0.09, 12);
    expect(t.pmf.mass()).toBeCloseTo(1, 12);
  });

  it("fireProbability of the condition is P(attack 1 landed) = 0.70, not P(any landing)", () => {
    expect(t.fireProbability("next")).toBeCloseTo(0.7, 12);
    expect(t.fireProbability("next")).not.toBeCloseTo(0.91, 2);
  });

  it("matches a brute force over the d20s, per bin within 1e-12", () => {
    const hit = roll(1, d8).plus(3).toPMF();
    const crit = roll(2, d8).plus(3).toPMF();
    const payload = (face: number): PMF | null =>
      face === 20 ? crit : face + 5 >= 12 ? hit : null;
    const expected = new Map<number, number>();
    const addPair = (first: PMF | null, second: PMF | null, weight: number): void => {
      const a = first ?? PMF.delta(0);
      const b = second ?? PMF.delta(0);
      for (const x of a.support()) {
        for (const y of b.support()) {
          const value = x + y;
          expected.set(value, (expected.get(value) ?? 0) + weight * a.pAt(x) * b.pAt(y));
        }
      }
    };
    for (let first = 1; first <= 20; first++) {
      const one = payload(first);
      if (one === null) {
        for (let second = 1; second <= 20; second++) addPair(one, payload(second), 1 / 400);
        continue;
      }
      for (let a = 1; a <= 20; a++) {
        for (let b = 1; b <= 20; b++) addPair(one, payload(Math.max(a, b)), 1 / 8000);
      }
    }
    let worst = 0;
    const support = new Set([...expected.keys(), ...t.pmf.support()]);
    for (const value of support) {
      worst = Math.max(worst, Math.abs(t.pmf.pAt(value) - (expected.get(value) ?? 0)));
    }
    expect(worst).toBeLessThan(1e-12);
  });

  it("the JSON spec is the same turn", () => {
    const fromSpec = Turn.from({
      attacks: [sword, sword],
      conditions: [{ on: "every-hit", grants: [{ advantage: true, until: "next-attack" }] }],
    });
    expect(pmfMaxDiff(fromSpec.pmf, t.pmf)).toBeLessThan(1e-15);
    expect(fromSpec.conditionIds).toEqual(["condition 1"]);
  });
});

describe("O22: advantage on the next attack, three attacks", () => {
  const t = turn([sword, sword, sword]).onEveryHit(advantage().untilNextAttack());

  it("mean is 19.19219625 and P(0) is 0.027", () => {
    expect(t.mean()).toBeCloseTo(19.19219625, 9);
    expect(t.pmf.pAt(0)).toBeCloseTo(0.027, 12);
  });

  it("the reading attack consumes the flag even on a miss: not the no-grant, sticky or all-advantage figure", () => {
    expect(t.mean()).not.toBeCloseTo(3 * FLAT, 4); // 16.425: the grant never applied
    expect(t.mean()).not.toBeCloseTo(19.3048875, 4); // the flag was never cleared by a miss
    expect(t.mean()).not.toBeCloseTo(3 * ADVANTAGE, 4); // 21.79125: every attack had advantage
  });

  it("a Modifiers value is not a Grant: forgetting the lifetime does not compile", () => {
    // @ts-expect-error — `advantage()` has no lifetime yet, so it is not a Grant.
    expect(() => turn([sword, sword]).onEveryHit(advantage())).toThrow();
  });
});

describe("O23: advantage for the turn on a 0.5 chance, retried on every landing", () => {
  const t = turn([sword, sword, sword]).onEveryHit(advantage().untilEndOfTurn(), { chance: 0.5 });

  it("mean is 18.084065625", () => {
    expect(t.mean()).toBeCloseTo(18.084065625, 9);
  });

  it("an every-hit grant retries: not the one-attempt figure", () => {
    expect(t.mean()).not.toBeCloseTo(17.86494375, 4);
  });

  it("a save contributes its P(fail): d20+2 vs DC 15 fails 0.6 of the time, same as chance 0.6", () => {
    const bySave = turn([sword, sword, sword]).onEveryHit(advantage().untilEndOfTurn(), {
      save: d20.plus(2).dc(15),
    });
    const byChance = turn([sword, sword, sword]).onEveryHit(advantage().untilEndOfTurn(), {
      chance: 0.6,
    });
    expect(pmfMaxDiff(bySave.pmf, byChance.pmf)).toBeLessThan(1e-12);
  });

  it("vsAC rebinds the attacks and leaves the save's chance alone", () => {
    const save = d20.plus(2).dc(15);
    const at12 = turn([d20.plus(5).ac(16).onHit(roll(1, d8).plus(3)), sword])
      .onEveryHit(advantage().untilEndOfTurn(), { save })
      .vsAC(12);
    const direct = turn([sword, sword]).onEveryHit(advantage().untilEndOfTurn(), { chance: 0.6 });
    expect(pmfMaxDiff(at12.pmf, direct.pmf)).toBeLessThan(1e-12);
  });
});

describe("O24: first-hit grant of advantage and crit-on-hit for the turn, chance 0.4", () => {
  const t = turn([sword, sword, sword, sword]).onFirstHit(
    advantage().critOnHit().untilEndOfTurn(),
    { chance: 0.4 }
  );

  it("mean is 27.525774", () => {
    expect(t.mean()).toBeCloseTo(27.525774, 9);
  });

  it("not the base turn, not an uncollapsed crit chance, not a retried save", () => {
    expect(t.mean()).not.toBeCloseTo(4 * FLAT, 4); // 21.9: the grant never applied
    expect(t.mean()).not.toBeCloseTo(23.7481365, 4); // P(crit) 0.0975: critOnHit did not collapse
    expect(t.mean()).not.toBeCloseTo(29.45957664, 4); // every landing retried the save
  });

  it("critOnHit composes with advantage: P(crit) = P(land) = 0.91", () => {
    const certain = turn([sword, sword]).onFirstHit(advantage().critOnHit().untilEndOfTurn());
    // attack 2 crits on every landing (0.91) when attack 1 landed (0.70), else flat.
    expect(certain.mean()).toBeCloseTo(FLAT + 0.7 * 0.91 * 12 + 0.3 * FLAT, 9);
  });

  it("the group's first code is the tried state: a passed save is final", () => {
    expect(inspectTurn(t).groupCount).toBe(1);
  });
});

describe("O26: two conditions, two lifetimes, one walk", () => {
  const t = turn([sword, sword, sword])
    .onEveryHit(advantage().untilNextAttack())
    .onEveryHit(advantage().untilEndOfTurn(), { chance: 0.5 });

  it("mean is 19.248541875, above both single conditions and below the all-advantage bound", () => {
    expect(t.mean()).toBeCloseTo(19.248541875, 9);
    expect(t.mean()).toBeGreaterThan(19.19219625);
    expect(t.mean()).toBeGreaterThan(18.084065625);
    expect(t.mean()).toBeLessThan(3 * ADVANTAGE);
    expect(t.pmf.pAt(0)).toBeCloseTo(0.027, 12);
  });

  it("the state count is the four flag combinations at most, then collapses once nothing reads them", () => {
    const { stateCounts, groupCount } = inspectTurn(t);
    expect(groupCount).toBe(0);
    expect(stateCounts).toEqual([3, 4, 1]);
  });
});

describe("O28: both save branches", () => {
  const withSave = turn([sword, sword, sword, sword]).onFirstHit(advantage().untilEndOfTurn(), {
    chance: 0.4,
    onSave: advantage().untilNextAttack(),
  });

  it("mean is 24.79240875", () => {
    expect(withSave.mean()).toBeCloseTo(24.79240875, 9);
  });

  it("dropping the success branch is the fail-only turn, 23.7481365", () => {
    const failOnly = turn([sword, sword, sword, sword]).onFirstHit(advantage().untilEndOfTurn(), {
      chance: 0.4,
    });
    expect(failOnly.mean()).toBeCloseTo(23.7481365, 9);
    expect(withSave.mean()).not.toBeCloseTo(23.7481365, 4);
  });

  it("once an end-of-turn grant is in force, later landings roll no save and apply no onSave grant", () => {
    const t = turn([sword, sword, sword]).onEveryHit(advantage().untilEndOfTurn(), {
      chance: 0.5,
      onSave: disadvantage().untilNextAttack(),
    });
    expect(t.mean()).toBeCloseTo(17.0510625, 9);
    // Re-rolling the save while advantage is in force would cancel it half the time.
    expect(t.mean()).not.toBeCloseTo(16.7662040625, 4);
  });
});

describe("a chance gates grants only, never damage", () => {
  it("a damage rider in the same call fires on every first landing; the split call is the same turn", () => {
    const together = turn([sword, sword]).onFirstHit([d8, advantage().untilEndOfTurn()], {
      chance: 0.5,
      id: "extra",
    });
    const apart = turn([sword, sword])
      .onFirstHit(d8)
      .onFirstHit(advantage().untilEndOfTurn(), { chance: 0.5 });
    expect(together.fireProbability("extra")).toBeCloseTo(0.91, 12);
    expect(together.fireProbability(together.conditionIds[0])).toBeCloseTo(0.35, 12);
    expect(pmfMaxDiff(together.pmf, apart.pmf)).toBeLessThan(1e-12);
  });

  it("O29: the rider doubles on a crit like any attack damage; mean is 15.9635625", () => {
    const t = turn([sword, sword]).onFirstHit([d8, advantage().untilEndOfTurn()], { chance: 0.5 });
    expect(t.mean()).toBeCloseTo(15.9635625, 9);
    // A result here means the d8 rider was gated by the save, like the grant is.
    expect(t.mean()).not.toBeCloseTo(13.7698125, 4);
    // A result here means the rider did not double its dice on a crit.
    expect(t.mean()).not.toBeCloseTo(15.6710625, 4);
  });
});

describe("O30: a granted advantage rolls three dice when the attacker says so", () => {
  it("mean is 12.67501875: attack 2 lands 0.973 of the time in the granted state, not 0.91", () => {
    const three = d20.plus(5).ac(12).threeDiceAdvantage().onHit(roll(1, d8).plus(3));
    const t = turn([three, three]).onEveryHit(advantage().untilNextAttack());
    expect(t.mean()).toBeCloseTo(12.67501875, 9);
    expect(t.mean()).not.toBeCloseTo(12.202125, 4);
  });
});

describe("semantics (§7.2)", () => {
  it("any-crit: attack 2 has advantage only after a crit", () => {
    const t = turn([sword, sword]).onAnyCrit(advantage().untilEndOfTurn());
    expect(t.mean()).toBeCloseTo(FLAT + 0.05 * ADVANTAGE + 0.95 * FLAT, 9);
  });

  it("first-miss (JSON): a miss gives the next attack disadvantage", () => {
    const t = Turn.from({
      attacks: [sword, sword],
      conditions: [{ on: "first-miss", grants: [{ disadvantage: true, until: "next-attack" }] }],
    });
    expect(t.mean()).toBeCloseTo(FLAT + 0.3 * DISADVANTAGE + 0.7 * FLAT, 9);
  });

  it("advantage and disadvantage in the same state cancel to a flat roll", () => {
    const t = turn([sword, sword]).onEveryHit([
      advantage().untilNextAttack(),
      disadvantage().untilNextAttack(),
    ]);
    expect(t.mean()).toBeCloseTo(2 * FLAT, 9);
  });

  it("a next-attack flag scoped with `to` is consumed only by the attack it names", () => {
    const t = turn([sword, sword, sword]).onEveryHit(advantage().untilNextAttack().to("attack 3"), {
      of: ["attack 1"],
    });
    expect(t.mean()).toBeCloseTo(2 * FLAT + 0.7 * ADVANTAGE + 0.3 * FLAT, 9);
  });

  it("miss damage is not a landing: a half-on-miss attack sets no flag when it misses", () => {
    const halves = d20.plus(5).ac(12).onHit(roll(1, d8).plus(3)).halfOnMiss();
    const t = turn([halves, halves]).onEveryHit(advantage().untilNextAttack(), { id: "next" });
    expect(t.fireProbability("next")).toBeCloseTo(0.7, 12);
  });

  it("miss damage is not a landing: an onMiss attack sets no flag when it misses", () => {
    const based = d20.plus(5).ac(12).onHit(roll(1, d8).plus(3));
    const misses = based.onMiss(roll(1, d4));
    const t = turn([misses, misses]).onEveryHit(advantage().untilNextAttack(), { id: "next" });
    expect(t.fireProbability("next")).toBeCloseTo(0.7, 12);

    // PMF level, one attack: the grant only reads a hit/crit, so its "hit" slice matches
    // the same attack without onMiss damage, and the grant leaves missDamage untouched.
    const single = turn(misses).onEveryHit(advantage().untilNextAttack());
    const plainSingle = turn(based).onEveryHit(advantage().untilNextAttack());
    expect(
      pmfMaxDiff(single.pmf.filterOutcome("hit"), plainSingle.pmf.filterOutcome("hit"))
    ).toBeLessThan(1e-12);
    expect(
      pmfMaxDiff(single.pmf.filterOutcome("missDamage"), turn(misses).pmf.filterOutcome("missDamage"))
    ).toBeLessThan(1e-12);
  });

  it("an end-of-turn grant for one set of attacks and its opposite for another come from the same save", () => {
    const heavy = d20.plus(5).ac(12).onHit(roll(1, d8).plus(3));
    const shot = d20.plus(5).ac(12).onHit(roll(1, d6).plus(3));
    const t = turn()
      .attack(heavy, { tag: "melee" })
      .attack(shot, { tag: "ranged" })
      .attack(heavy, { tag: "melee" })
      .onEveryHit(
        [advantage().untilEndOfTurn().to("melee"), disadvantage().untilEndOfTurn().to("ranged")],
        { of: ["attack 1"], chance: 0.5 }
      );

    const first = heavy.toPMF();
    const landed = first.filterOutcome("hit").add(first.filterOutcome("crit"));
    const applied = landed.scaleMass(0.5);
    const notApplied = first.filterOutcome("missNone").add(landed.scaleMass(0.5));
    const variant = (source: typeof heavy, rollType: "advantage" | "disadvantage"): PMF =>
      source.withCheck((check) => ({ ...check, rollType })).toPMF();
    // Raw convolution: the branches are sub-mass and must stay that way.
    const expected = applied
      .convolve(variant(shot, "disadvantage"), undefined, true)
      .convolve(variant(heavy, "advantage"), undefined, true)
      .add(notApplied.convolve(shot.toPMF(), undefined, true).convolve(heavy.toPMF(), undefined, true));
    expect(pmfMaxDiff(t.pmf, expected)).toBeLessThan(1e-12);
  });

  it("a `to` naming nothing after the condition's sources is unknown-id", () => {
    expect(
      codeOf(() =>
        turn([sword, sword]).onEveryHit(advantage().untilNextAttack().to("attack 1"), {
          of: ["attack 2"],
        })
      )
    ).toBe("unknown-id");
    expect(
      codeOf(() => turn([sword, sword]).onEveryHit(advantage().untilNextAttack().to("nowhere")))
    ).toBe("unknown-id");
  });

  it("a flag no step reads leaves the state count unchanged", () => {
    // The last attack's grant has no later attack roll to read it. (A grant from an
    // any-miss reroll is refused instead: in play the reroll lands mid-turn.)
    const musket = d20.plus(9).ac(15).onHit(roll(1, d12).plus(1, d4).plus(18));
    const base = turn([musket, musket]).onFirstHit(roll(1, d10));
    const unread = base.onEveryHit(advantage().untilNextAttack(), { of: ["attack 2"] });
    expect(inspectTurn(unread).stateCounts).toEqual(inspectTurn(base).stateCounts);
    expect(unread.mean()).toBeCloseTo(base.mean(), 12);
  });
});

describe("composition with riders, rerolls and substitutes", () => {
  it("a first-hit damage rider and a first-hit grant over the same attacks share one group", () => {
    const t = turn([sword, sword])
      .onFirstHit(roll(3, d6))
      .onFirstHit(advantage().untilEndOfTurn(), { chance: 0.5 });
    expect(inspectTurn(t).groupCount).toBe(1);
  });

  it("an every-hit grant allocates no group of its own", () => {
    const t = turn([sword, sword]).onFirstHit(roll(3, d6)).onEveryHit(advantage().untilNextAttack());
    expect(inspectTurn(t).groupCount).toBe(1);
  });

  it("all MAX_TRIGGER_GROUPS groups plus condition flags still build and resolve: flags are not counted against the group limit", () => {
    // 4 attacks, 9 distinct non-empty subsets of their ids as `of` — enough distinct
    // trigger source sets to fill the group budget without the state blow-up of 9
    // independently-drawn attacks (each first-hit group roughly doubles the walk).
    const attackIds = ["attack 1", "attack 2", "attack 3", "attack 4"];
    const subsets: string[][] = [];
    for (let mask = 1; mask < 1 << attackIds.length; mask++) {
      subsets.push(attackIds.filter((_, bit) => mask & (1 << bit)));
    }
    const groupSets = subsets.slice(0, MAX_TRIGGER_GROUPS);
    const [flagSetA, flagSetB] = subsets.slice(MAX_TRIGGER_GROUPS, MAX_TRIGGER_GROUPS + 2);

    let t = turn([sword, sword, sword, sword]);
    groupSets.forEach((of, i) => {
      t = t.onFirstHit(roll(1, d4), { of, id: `group ${i + 1}` });
    });
    expect(inspectTurn(t).groupCount).toBe(MAX_TRIGGER_GROUPS);

    // every-hit grants never call groupOf (GRANT_TRIGGERS['every-hit'].readsGroup is
    // false), so two more, each over a source set none of the groups above used, must
    // not grow the group count or throw.
    const withFlags = t
      .onEveryHit(advantage().untilNextAttack(), { of: flagSetA })
      .onEveryHit(disadvantage().untilEndOfTurn(), { of: flagSetB });
    expect(() => withFlags.mean()).not.toThrow();
    expect(inspectTurn(withFlags).groupCount).toBe(MAX_TRIGGER_GROUPS);

    // Proof this would fail if flags were counted: a first-hit RIDER (which does read
    // a group) over that same untried source set, once the budget is already full,
    // throws too-many-groups — the error a counted flag would trigger instead.
    expect(codeOf(() => t.onFirstHit(roll(1, d4), { of: flagSetA, id: "tenth" }).mean())).toBe(
      "too-many-groups"
    );
  });

  it("a first-miss reroll reads a turn flag set by an earlier attack", () => {
    const t = turn([sword, sword])
      .onEveryHit(advantage().untilEndOfTurn(), { of: ["attack 1"] })
      .onFirstMiss(sword, { of: ["attack 2"] });
    // attack 1 lands (0.7): attack 2 and its reroll both roll with advantage.
    const expected =
      FLAT + 0.7 * (ADVANTAGE + 0.09 * ADVANTAGE) + 0.3 * (FLAT + 0.3 * FLAT);
    expect(t.mean()).toBeCloseTo(expected, 9);
  });

  it("a substitute runs on whichever variant the flags selected", () => {
    const three = turn([sword, sword, sword]);
    const granted = three.onEveryHit(advantage().untilNextAttack());
    const allAdvantage = d20.withAdvantage().plus(5).ac(12).onHit(roll(1, d8).plus(3));
    const bound = turn([allAdvantage, allAdvantage, allAdvantage]);
    const gain = granted.onFirstHit(keepBestDamage()).mean() - granted.mean();
    const boundGain = bound.onFirstHit(keepBestDamage()).mean() - bound.mean();
    expect(gain).toBeGreaterThan(0);
    expect(gain).toBeLessThan(boundGain);
  });
});

describe("guards", () => {
  it("more than 8 live flags is too-many-flags, naming every live flag", () => {
    let t = turn([sword, sword]);
    for (let i = 0; i < 8; i++) t = t.onEveryHit(advantage().untilNextAttack(), { of: ["attack 1"] });
    expect(() => t.mean()).not.toThrow();
    const ninth = (): Turn =>
      t.onEveryHit(advantage().untilNextAttack(), { of: ["attack 1"], id: "ninth" });
    expect(codeOf(ninth)).toBe("too-many-flags");
    let message = "";
    try {
      ninth().mean();
    } catch (error) {
      message = error instanceof TurnSpecError ? error.message : String(error);
    }
    for (let i = 1; i <= 8; i++) expect(message).toContain(`"condition ${i}" grant 1`);
    expect(message).toContain('"ninth" grant 1');
  });

  it("a grant read by an attack with no check to re-derive is no-rebindable-source; `to` scopes it away", () => {
    const bare = sword.toPMF();
    expect(codeOf(() => turn([sword, bare]).onEveryHit(advantage().untilNextAttack()))).toBe(
      "no-rebindable-source"
    );
    const scoped = turn([sword, bare, sword]).onEveryHit(advantage().untilEndOfTurn().to("attack 3"));
    expect(scoped.mean()).toBeCloseTo(2 * FLAT + (1 - 0.3 * 0.3) * ADVANTAGE + 0.09 * FLAT, 9);
  });

  it("a chance outside [0, 1] is a RangeError", () => {
    expect(() => turn([sword, sword]).onEveryHit(advantage().untilEndOfTurn(), { chance: 1.5 })).toThrow(
      RangeError
    );
    expect(() =>
      Turn.from({
        attacks: [sword, sword],
        conditions: [{ on: "every-hit", chance: -0.1, grants: [{ advantage: true, until: "end-of-turn" }] }],
      })
    ).toThrow(RangeError);
  });

  it("chance with save, or onSave with neither, is a plain Error", () => {
    const both = (): unknown =>
      turn([sword, sword]).onEveryHit(advantage().untilEndOfTurn(), {
        chance: 0.5,
        save: d20.plus(2).dc(15),
      });
    expect(both).toThrow(Error);
    expect(codeOf(both)).toMatch(/^not a TurnSpecError/);
    const neither = (): unknown =>
      turn([sword, sword]).onEveryHit(advantage().untilEndOfTurn(), {
        onSave: advantage().untilNextAttack(),
      });
    expect(neither).toThrow(Error);
    expect(codeOf(neither)).toMatch(/^not a TurnSpecError/);
  });

  it("a grant on a verb that does not take one is unsupported-trigger", () => {
    const grant = advantage().untilNextAttack() as unknown as RiderDamage;
    expect(codeOf(() => turn([sword, sword]).onDiceMatch(["attack 1"], grant))).toBe(
      "unsupported-trigger"
    );
    expect(codeOf(() => turn([sword, sword]).onAnyMiss(grant))).toBe("unsupported-trigger");
  });

  it("critOnHit() also starts a grant", () => {
    const t = turn([sword, sword]).onFirstHit(critOnHit().untilEndOfTurn());
    // attack 2 crits on every landing (0.70) when attack 1 landed.
    expect(t.mean()).toBeCloseTo(FLAT + 0.7 * 0.7 * 12 + 0.3 * FLAT, 9);
  });
});
