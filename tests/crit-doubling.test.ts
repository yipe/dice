import { describe, expect, it } from "vitest";
import "../src/builder/ac";
import "../src/builder/dc";
import { d, d20, d4, d6, d8, roll } from "../src/builder/factory";
import type { AttackBuilder } from "../src/builder/attack";
import { ParsedRollBuilder } from "../src/builder/roll";
import type { PooledRollBuilder, RollBuilder } from "../src/builder/roll";
import type { PMF } from "../src/pmf/pmf";
import { turn, type Damage, type Rider } from "../src/turn";

/** Every damage payload with dice doubles those dice on a crit; flats never double. */

function expectSamePMF(actual: PMF, expected: PMF): void {
  const support = new Set([...actual.support(), ...expected.support()]);
  for (const value of support) {
    expect(Math.abs(actual.pAt(value) - expected.pAt(value)), `bin ${value}`).toBeLessThanOrEqual(1e-12);
  }
}

/** `2d6+3`, roll it all twice and keep the better. */
const pool = (): PooledRollBuilder => roll(2, d6).plus(3).keepHighestAll(2, 1);
/** The dice double inside the pool, then it pools. */
const poolCrit = (): PooledRollBuilder => roll(4, d6).plus(3).keepHighestAll(2, 1);
/** The wrong reading: the whole pool rolled twice, which also doubles the +3 and the pooling. */
const DEFECT_B = 22.7438;

/** Two attacks, `d20+8` vs AC 16: P(at least one crit) = 1 - 0.95². */
const dagger = d20.plus(8).ac(16).onHit(d4.plus(4));
const P_ANY_CRIT = 0.0975;

describe("R33 pooled payloads: a crit doubles the dice inside the pool, then pools", () => {
  it("onHit(pool) crits bin for bin as roll(4,d6).plus(3).keepHighestAll(2,1) — O4-crit, never Defect B", () => {
    const res = d20.plus(5).ac(12).onHit(pool()).resolve();
    expectSamePMF(res.crit, poolCrit().toPMF());
    expect(res.hit.mean()).toBeCloseTo(11.3719, 4); // best of two 2d6 + 3
    expect(res.crit.mean()).toBeCloseTo(18.9334, 4); // best of two 4d6 + 3
    expect(res.crit.mean()).not.toBeCloseTo(DEFECT_B, 4);
  });

  it("doubleDice() on the pool itself is the same rebuilt pool", () => {
    expectSamePMF(pool().doubleDice().toPMF(), poolCrit().toPMF());
    expect(pool().doubleDice().toExpression()).toBe(poolCrit().toExpression());
  });

  it("dice added after pooling double too, the pool's flats do not", () => {
    const added = pool().plus(roll(1, d4)).plus(2);
    const expected = poolCrit().plus(roll(2, d4)).plus(2);
    expectSamePMF(added.doubleDice().toPMF(), expected.toPMF());
  });

  it("keepLowestAll, nested pools and times() rebuild from their own doubled rolls", () => {
    expectSamePMF(
      roll(1, d8).plus(1).keepLowestAll(3, 2).doubleDice().toPMF(),
      roll(2, d8).plus(1).keepLowestAll(3, 2).toPMF()
    );
    expectSamePMF(
      d6.keepHighestAll(4, 3).keepHighestAll(3, 2).doubleDice().toPMF(),
      roll(2, d6).keepHighestAll(4, 3).keepHighestAll(3, 2).toPMF()
    );
    expectSamePMF(pool().times(3).doubleDice().toPMF(), poolCrit().times(3).toPMF());
  });

  it("a pooled plusSeparateDamage channel doubles inside the pool on a crit", () => {
    const res = d20.plus(5).ac(12).onHit(roll(1, d4)).plusSeparateDamage(pool()).resolve();
    expectSamePMF(res.critSeparate, poolCrit().toPMF());
  });

  it("a pooled rider crits as the rebuilt pool: any-crit adds P(any crit) × 18.9334", () => {
    const attacks = turn([dagger, dagger]);
    const auto = turn([dagger, dagger]).rider({ damage: pool(), on: "any-crit" });
    const explicit = turn([dagger, dagger]).rider({ damage: pool(), critDamage: poolCrit(), on: "any-crit" });
    expectSamePMF(auto.pmf, explicit.pmf);
    expect(auto.mean() - attacks.mean()).toBeCloseTo(P_ANY_CRIT * 18.933358577198593, 8);
    expect(auto.mean() - attacks.mean()).not.toBeCloseTo(P_ANY_CRIT * DEFECT_B, 3);
  });

  it("rerollDamage/minimumDamageDie still refuse a pooled payload: it has no dice descriptor", () => {
    expect(() => d20.plus(5).ac(12).onHit(pool()).rerollDamage(2)).toThrow(/requires a dice descriptor/);
    expect(() => d20.plus(5).ac(12).onHit(pool()).minimumDamageDie(2)).toThrow(/requires a dice descriptor/);
  });
});

describe("R33 parsed strings: doubling rewrites every dice term's count, operators kept", () => {
  it('onHit("2d6+5") crits exactly like onHit(roll(2,d6).plus(5)): weights, hit and crit', () => {
    const parsed = d20.plus(5).ac(12).onHit("2d6+5").resolve();
    const built = d20.plus(5).ac(12).onHit(roll(2, d6).plus(5)).resolve();
    expect(parsed.weights.hit).toBeCloseTo(0.65, 12);
    expect(parsed.weights.crit).toBeCloseTo(0.05, 12);
    expect(parsed.weights.miss).toBeCloseTo(0.3, 12);
    expect(parsed.weights.crit).toBeCloseTo(built.weights.crit, 12);
    expectSamePMF(parsed.hit, built.hit);
    expectSamePMF(parsed.crit, built.crit);
    expectSamePMF(parsed.pmf, built.pmf);
    expect(parsed.crit.mean()).toBeCloseTo(19, 10);
  });

  it('d("2d6 // 2") doubled is d("4d6 // 2"), not two halved 2d6', () => {
    const doubled = d("2d6 // 2").doubleDice();
    expectSamePMF(doubled.toPMF(), d("4d6 // 2").toPMF());
    expect(doubled.toPMF().mean()).toBeCloseTo(6.75, 10);
    expect(doubled.toExpression()).toBe("4d6 // 2");
  });

  it("a pooled string doubles inside, then pools: 2kh1(2d6+3) crits at O4-crit", () => {
    const doubled = d("2kh1(2d6+3)").doubleDice();
    expect(doubled.toExpression()).toBe("2kh1(4d6+3)");
    expectSamePMF(doubled.toPMF(), poolCrit().toPMF());
    expect(doubled.toPMF().mean()).not.toBeCloseTo(DEFECT_B, 4);
  });

  it("every builder-rendered shape doubles like the builder itself", () => {
    const shapes: RollBuilder[] = [
      roll(2, d6).plus(5),
      roll(1, d6).reroll(1), // "d6 reroll 1": one die with its reroll -> 2(d6 reroll 1)
      roll(1, d6).reroll(1).plus(3), // "d6 reroll 1 + 3"
      roll(2, d6).reroll(2), // "2(d6 reroll d2)": the d2 is a face set, not damage
      roll(1, d6).minimum(3), // "3>d6"
      roll(2, d6).minimum(3).reroll(1), // "2(3>(d6 reroll 1))"
      roll(1, d8).plus(3).half(), // "(1d8 + 3) // 2"
      roll(1, d6).scaleResult(2), // "2 ** (1d6)"
      roll(1, d6).keepHighest(2, 1), // "2kh1(1d6)"
      roll(1, d8).plus(roll(2, d6)).plus(4),
      pool(),
      pool().times(3),
    ];
    for (const shape of shapes) {
      const expression = shape.toExpression();
      expectSamePMF(d(expression).doubleDice().toPMF(), shape.doubleDice().toPMF());
    }
  });

  it("scaleDice(n) multiplies the dice n times and keeps the flats", () => {
    expectSamePMF(d("2d6+5").scaleDice(3).toPMF(), roll(6, d6).plus(5).toPMF());
    // Keep-highest-of-1 multiplies inside each trial; any other keep refuses (tests/crit-keep.test.ts).
    expectSamePMF(d("4kh1d6").scaleDice(3).toPMF(), d("4kh1(3d6)").toPMF());
  });

  it("an attack's expression now carries the parsed payload's doubled crit", () => {
    expect(d20.plus(5).ac(12).onHit("2d6 + 5").toExpression()).toBe("(d20 + 5 AC 12) * (2d6 + 5) crit (4d6 + 5)");
  });

  it("an expression containing an attack check is not damage: doubling throws instead of doubling the d20", () => {
    expect(() => d("(d20 + 5 AC 12) * (2d6)").doubleDice()).toThrow(/attack check/);
    expect(() => d20.plus(5).ac(12).onHit("(d20 + 5 AC 12) * (2d6)").resolve()).toThrow(/attack check/);
    // An explicit crit or noCrit() never doubles, so the same payload still resolves.
    expect(() => d20.plus(5).ac(12).onHit("(d20 + 5 AC 12) * (2d6)").noCrit().resolve()).not.toThrow();
  });
});

describe("R33 bare PMFs: a fixed distribution has no dice, so it is added as-is on a crit", () => {
  it("a PMF rider adds its own distribution on a crit", () => {
    const attacks = turn([dagger, dagger]);
    const flat = turn([dagger, dagger]).rider({ damage: d6.pmf, on: "any-crit" });
    expect(flat.mean() - attacks.mean()).toBeCloseTo(P_ANY_CRIT * 3.5, 8);
  });

  it("in a mixed rider, the builder parts double and the PMF parts stay as they are", () => {
    const attacks = turn([dagger, dagger]);
    const mixed = turn([dagger, dagger]).rider({ damage: [roll(1, d6), d4.pmf], on: "any-crit" });
    expect(mixed.mean() - attacks.mean()).toBeCloseTo(P_ANY_CRIT * (7 + 2.5), 8);
  });
});

describe("R33 parsed riders: a parsed damage string is damage, whatever its PMF's default 'hit' label", () => {
  const triggers = ["any-crit", "first-hit", "every-hit"] as const;

  it('d("3d6") rides exactly like roll(3,d6) on any-crit, first-hit and every-hit', () => {
    for (const on of triggers) {
      expectSamePMF(
        turn([dagger, dagger]).rider({ damage: d("3d6"), on }).pmf,
        turn([dagger, dagger]).rider({ damage: roll(3, d6), on }).pmf
      );
    }
    // 8.7 for the daggers + P(any crit) × 6d6's 21.
    expect(turn([dagger, dagger]).rider({ damage: d("3d6"), on: "any-crit" }).mean()).toBeCloseTo(10.7475, 10);
  });

  it("a parsed rider's critDamage is used, like a builder rider's", () => {
    expectSamePMF(
      turn([dagger, dagger]).rider({ damage: d("3d6"), critDamage: d("10d6"), on: "any-crit" }).pmf,
      turn([dagger, dagger]).rider({ damage: roll(3, d6), critDamage: roll(10, d6), on: "any-crit" }).pmf
    );
  });

  it("a list of parsed parts rides like the same list of builders", () => {
    for (const on of triggers) {
      expectSamePMF(
        turn([dagger, dagger]).rider({ damage: [d("2d6"), d("1d6+2"), roll(1, d4)], on }).pmf,
        turn([dagger, dagger]).rider({ damage: [roll(2, d6), roll(1, d6).plus(2), roll(1, d4)], on }).pmf
      );
    }
  });

  it("a parsed damage rider is not an attack: a hit trigger cannot watch it, exactly as with a builder", () => {
    for (const damage of [d("3d6"), roll(3, d6)]) {
      expect(() =>
        turn([dagger])
          .rider({ id: "r", damage, on: "first-hit" })
          .rider({ damage: roll(1, d4), on: "first-hit", of: ["r"] })
      ).toThrow(expect.objectContaining({ code: "not-an-attack" }));
    }
  });

  it("a parsed string with an AC check stays attack-shaped: watchable, and it refuses critDamage", () => {
    // With or without a crit clause, and always hitting: each carries hit and crit labels.
    for (const attack of ["(d20 + 8 AC 16) * (2d6)", "(d20+5 AC 12) * (1d8+3) crit (2d8+3)", "(d20+30 AC 5) * (1d8)"]) {
      expect(() =>
        turn([dagger])
          .rider({ id: "ua", damage: d(attack), on: "first-miss" })
          .rider({ damage: roll(1, d4), on: "first-hit", of: ["ua"] })
      ).not.toThrow();
      expect(() =>
        turn([dagger]).rider({ damage: d(attack), critDamage: roll(2, d6), on: "first-miss" })
      ).toThrow(expect.objectContaining({ code: "unused-crit-damage" }));
    }
  });

  it("a bare PMF keeps its label-based shape: a 'hit'-labelled PMF is attack-shaped, an unlabelled one is damage", () => {
    expect(() =>
      turn([dagger, dagger]).rider({ damage: d("3d6").toPMF(), critDamage: roll(6, d6), on: "any-crit" })
    ).toThrow(expect.objectContaining({ code: "unused-crit-damage" }));
    expect(() =>
      turn([dagger, dagger]).rider({ damage: roll(3, d6).toPMF(), critDamage: roll(6, d6), on: "any-crit" })
    ).not.toThrow();
  });
});

describe("R33 parsed save and attack riders: each rides like its builder and never throws at plan build", () => {
  const triggers = ["first-hit", "every-hit", "any-crit", "first-miss"] as const;
  const watch = (damage: Damage) =>
    turn([dagger])
      .rider({ id: "r", damage, on: "first-miss" })
      .rider({ id: "watcher", damage: roll(1, d4), on: "first-hit", of: ["r"] });

  it("canDoubleDice() is true exactly when doubleDice() can rewrite the string", () => {
    const expressions = {
      "3d6": true,
      "2d6 // 2": true,
      "2kh1(2d6+3)": true,
      "(d20 + 8 AC 16) * (2d6)": false,
      "d20+5 DC 15 * (8d6) save half": false,
      "(d20+5 AC 15) * 0": false,
      d4d6: false,
    };
    for (const [expression, doubles] of Object.entries(expressions)) {
      const parsed = d(expression);
      if (!(parsed instanceof ParsedRollBuilder)) throw new Error(`expected a parsed string for ${expression}`);
      expect(parsed.canDoubleDice(), expression).toBe(doubles);
      if (doubles) expect(() => parsed.doubleDice()).not.toThrow();
      else expect(() => parsed.doubleDice()).toThrow(/Cannot double the dice/);
    }
  });

  it('d("d20+5 DC 15 * (8d6) save half") rides bin for bin like the SaveBuilder: added undoubled on a crit', () => {
    const parsed = () => d("d20+5 DC 15 * (8d6) save half");
    const built = () => d20.plus(5).dc(15).onSaveFailure(roll(8, d6)).saveHalf();
    for (const on of triggers) {
      expectSamePMF(
        turn([dagger, dagger]).rider({ damage: parsed(), on }).pmf,
        turn([dagger, dagger]).rider({ damage: built(), on }).pmf
      );
    }
    const anyCrit = turn([dagger, dagger]).rider({ damage: parsed(), on: "any-crit" }).mean();
    expect(anyCrit - turn([dagger, dagger]).mean()).toBeCloseTo(P_ANY_CRIT * 20.1625, 10);
    // Like the builder, it is damage: it takes critDamage and no hit trigger can watch it.
    expectSamePMF(
      turn([dagger, dagger]).rider({ damage: parsed(), critDamage: roll(10, d6), on: "any-crit" }).pmf,
      turn([dagger, dagger]).rider({ damage: built(), critDamage: roll(10, d6), on: "any-crit" }).pmf
    );
    for (const damage of [parsed(), built()]) {
      expect(() => watch(damage)).toThrow(expect.objectContaining({ code: "not-an-attack" }));
    }
  });

  it("a parsed attack string rides bin for bin like its AttackBuilder on every trigger, every-hit included", () => {
    // With no crit clause the string crits its hit dice doubled, so it pairs with the
    // plain auto-doubling builder; a crit clause pairs with the builder's explicit onCrit.
    const pairs = [
      ["(d20+5 AC 12) * (1d8+3) crit (2d8+3)", () => d20.plus(5).ac(12).onHit(roll(1, d8).plus(3)).onCrit(roll(2, d8).plus(3))],
      ["(d20 + 8 AC 16) * (2d6)", () => d20.plus(8).ac(16).onHit(roll(2, d6))],
    ] as const;
    for (const [expression, built] of pairs) {
      for (const on of triggers) {
        expectSamePMF(
          turn([dagger, dagger]).rider({ damage: d(expression), on }).pmf,
          turn([dagger, dagger]).rider({ damage: built(), on }).pmf
        );
      }
      const watchedParsed = watch(d(expression));
      const watchedBuilt = watch(built());
      // The watcher must actually fire on both sides — a stray unknown `on` (once
      // "any-hit") left it inert and this passed vacuously; it now throws at build.
      expect(watchedParsed.fireProbability("watcher")).toBeGreaterThan(0);
      expect(watchedBuilt.fireProbability("watcher")).toBeGreaterThan(0);
      // Watched, the watcher doubles when the source crits, so this also compares the
      // hit/crit split, which a value-only comparison of the rider PMFs cannot see.
      expectSamePMF(watchedParsed.pmf, watchedBuilt.pmf);
    }
    // Exact enumeration: 2671/400. (6.51125 is the result when the natural 20 folds into 'hit'.)
    expect(watch(d(pairs[1][0])).mean()).toBeCloseTo(6.6775, 10);
  });

  it("(d20+5 AC 15) * 0 adds nothing on any trigger, like an attack whose hit deals 0", () => {
    for (const on of triggers) {
      expectSamePMF(
        turn([dagger, dagger]).rider({ damage: d("(d20+5 AC 15) * 0"), on }).pmf,
        turn([dagger, dagger]).rider({ damage: d20.plus(5).ac(15).onHit(0), on }).pmf
      );
    }
  });

  it("a string doubleDice() cannot rewrite, d4d6, is added as-is on a crit, like its own PMF", () => {
    for (const on of triggers) {
      expectSamePMF(
        turn([dagger, dagger]).rider({ damage: d("d4d6"), on }).pmf,
        turn([dagger, dagger]).rider({ damage: d("d4d6").toPMF(), on }).pmf
      );
    }
  });
});

describe("R33 parsed attack strings: no crit clause crits at the check's crit rate, its hit dice doubled", () => {
  /** Attack strings with no crit clause, each with the auto-doubling builder it spells. */
  const pairs: readonly (readonly [string, () => AttackBuilder])[] = [
    ["(d20 + 8 AC 16) * (2d6)", () => d20.plus(8).ac(16).onHit(roll(2, d6))],
    ["(d20+5 AC 15) * (1d8+3)", () => d20.plus(5).ac(15).onHit(roll(1, d8).plus(3))],
    ["(d20 + 5 AC 12) * (d6 reroll 1 + 3)", () => d20.plus(5).ac(12).onHit(roll(1, d6).reroll(1).plus(3))],
    // Bonus to-hit dice: the tracked natural-20 slice.
    ["(d20 + 5 + d4 AC 12) * (2d6)", () => d20.plus(5).plus(d4).ac(12).onHit(roll(2, d6))],
    // Advantage and halfling luck: the kept natural roll, tracked the same way.
    ["(d20 > d20 + 5 AC 12) * (2d6)", () => d20.withAdvantage().plus(5).ac(12).onHit(roll(2, d6))],
    ["(hd20 + 5 AC 12) * (2d6)", () => d20.reroll(1).plus(5).ac(12).onHit(roll(2, d6))],
  ];
  const labels = ["hit", "crit", "missNone"] as const;
  const triggers = ["first-hit", "every-hit", "any-crit", "first-miss"] as const;
  const watch = (damage: Damage) =>
    turn([dagger])
      .rider({ id: "r", damage, on: "first-miss" })
      .rider({ id: "watcher", damage: roll(1, d4), on: "first-hit", of: ["r"] });

  it("labels its crit mass 'crit' and matches the builder bin for bin, label by label", () => {
    for (const [expression, built] of pairs) {
      const parsed = d(expression).toPMF();
      const reference = built().toPMF();
      for (const label of labels) {
        expect(parsed.outcomeProbability(label), `${expression} ${label}`).toBeCloseTo(reference.outcomeProbability(label), 12);
        expectSamePMF(parsed.filterOutcome(label), reference.filterOutcome(label));
      }
    }
    expect(d(pairs[0][0]).toPMF().outcomeProbability("crit")).toBeCloseTo(0.05, 12);
    expectSamePMF(d(pairs[0][0]).toPMF().filterOutcome("crit"), roll(4, d6).toPMF().scaleMass(0.05)); // not 2d6
    expectSamePMF(d(pairs[1][0]).toPMF().filterOutcome("crit"), roll(2, d8).plus(3).toPMF().scaleMass(0.05)); // +3 once
  });

  it('d("(d20 + 8 AC 16) * (2d6)") gives the audit\'s exact figures on every path that reads crit status', () => {
    const attack = () => d(pairs[0][0]);
    const base = turn([attack()]);
    expect(base.mean()).toBeCloseTo(4.9, 10); // was 4.55
    expect(turn([attack()]).rider({ damage: roll(1, d4), on: "first-hit" }).mean() - base.mean()).toBeCloseTo(1.75, 10); // was 1.625
    const two = turn([attack(), attack()]);
    expect(turn([attack(), attack()]).rider({ damage: roll(1, d4), on: "every-hit" }).mean() - two.mean()).toBeCloseTo(3.5, 10); // was 3.25
    const anyCrit = turn([attack()]).rider({ id: "smite", damage: roll(1, d4), on: "any-crit" });
    expect(anyCrit.mean() - base.mean()).toBeCloseTo(0.25, 10); // was 0
    expect(anyCrit.fireProbability("smite")).toBeCloseTo(0.05, 12); // was 0
    expect(watch(attack()).mean()).toBeCloseTo(6.6775, 10); // was 6.51125
  });

  it("rides like the builder as an attack, as a rider on every trigger, and as a watched source", () => {
    for (const [expression, built] of pairs) {
      for (const on of triggers) {
        expectSamePMF(
          turn([d(expression), d(expression)]).rider({ damage: roll(1, d4), on }).pmf,
          turn([built(), built()]).rider({ damage: roll(1, d4), on }).pmf
        );
        expectSamePMF(
          turn([dagger, dagger]).rider({ damage: d(expression), on }).pmf,
          turn([dagger, dagger]).rider({ damage: built(), on }).pmf
        );
      }
      expectSamePMF(watch(d(expression)).pmf, watch(built()).pmf);
    }
  });

  it("a crit clause still wins over doubling: `crit (2d6)` crits undoubled, like onCrit(roll(2, d6))", () => {
    const parsed = d("(d20 + 8 AC 16) * (2d6) crit (2d6)");
    const built = d20.plus(8).ac(16).onHit(roll(2, d6)).onCrit(roll(2, d6));
    expect(parsed.toPMF().outcomeProbability("crit")).toBeCloseTo(0.05, 12);
    expectSamePMF(parsed.toPMF().filterOutcome("crit"), roll(2, d6).toPMF().scaleMass(0.05));
    expectSamePMF(watch(parsed).pmf, watch(built).pmf);
    expect(watch(parsed).mean()).toBeCloseTo(6.555, 10); // 1311/200
  });

  it("an always-hit string crits on a natural 20 too: 0.95 hit, 0.05 crit (parse() has no natural-1 miss)", () => {
    const parsed = d("(d20+30 AC 5) * (1d8)").toPMF();
    expect(parsed.outcomeProbability("hit")).toBeCloseTo(0.95, 12);
    expect(parsed.outcomeProbability("crit")).toBeCloseTo(0.05, 12);
    expectSamePMF(parsed.filterOutcome("crit"), roll(2, d8).toPMF().scaleMass(0.05));
    expect(parsed.mean()).toBeCloseTo(4.725, 10);
  });

  it("a miss or pc clause keeps its branch and gains the crit; a save string is unchanged", () => {
    const miss = d("(d20+5 AC 15) * (2d6) miss (1d6)").toPMF();
    const spelled = d("(d20+5 AC 15) * (2d6) crit (4d6) miss (1d6)").toPMF();
    const built = d20.plus(5).ac(15).onHit(roll(2, d6)).onMiss(roll(1, d6)).toPMF();
    for (const label of ["hit", "crit", "missDamage"] as const) {
      expectSamePMF(miss.filterOutcome(label), spelled.filterOutcome(label));
      expectSamePMF(miss.filterOutcome(label), built.filterOutcome(label));
    }
    // A clause after the crit used to rescale the faces but not the crit's counts: 0.05 / 6.
    expect(spelled.outcomeProbability("crit")).toBeCloseTo(0.05, 12);
    expect(miss.outcomeProbability("hit")).toBeCloseTo(0.5, 12);
    expect(miss.outcomeProbability("missDamage")).toBeCloseTo(0.45, 12);

    const pc = d("(d20 + 4 AC 13) * (1d6) pc (1d6)").toPMF();
    expectSamePMF(pc.filterOutcome("crit"), roll(2, d6).toPMF().scaleMass(0.05));
    expectSamePMF(pc, d("(d20 + 4 AC 13) * (1d6) crit (2d6) pc (1d6)").toPMF());

    const save = d("d20+5 DC 15 * (8d6) save half").toPMF();
    expect(save.outcomes().sort()).toEqual(["saveFail", "saveHalf"]);
    expect(save.outcomeProbability("saveFail")).toBeCloseTo(0.45, 12);
    expect(save.mean()).toBeCloseTo(20.1625, 10);
  });

  it("a hit payload doubleDice() cannot rewrite, d4d6, is added as-is on a crit", () => {
    const parsed = d("(d20+5 AC 15) * (d4d6)").toPMF();
    expect(parsed.outcomeProbability("crit")).toBeCloseTo(0.05, 12);
    expectSamePMF(parsed.filterOutcome("crit"), d("d4d6").toPMF().scaleMass(0.05));
  });
});

describe("trigger validation", () => {
  it("an unknown `on` is unsupported-trigger at build, not an inert rider", () => {
    // "any-hit" once left a watcher that never fired, and a parity test passed vacuously.
    const unknown = { damage: roll(1, d4), on: "any-hit" } as unknown as Rider;
    expect(() => turn([dagger]).rider(unknown)).toThrow(expect.objectContaining({ code: "unsupported-trigger" }));
  });
});
