import { describe, expect, it } from "vitest";
import "../src/builder/ac";
import { d, d20, d4, d6, d8, roll } from "../src/builder/factory";
import type { PMF } from "../src/pmf/pmf";
import { turn } from "../src/turn";

/**
 * R33 on a per-die keep. Keep-highest-of-1 ("roll it N times, keep the best") doubles its dice
 * inside each trial, like a pool. Every other per-die keep, a bestOf() that doubling moves between
 * a plain sum and a keep, and a die rolled with advantage/disadvantage/elven accuracy have no single
 * doubled meaning, so doubling them throws until the caller gives an explicit crit.
 */

function expectSamePMF(actual: PMF, expected: PMF): void {
  const support = new Set([...actual.support(), ...expected.support()]);
  for (const value of support) {
    expect(Math.abs(actual.pAt(value) - expected.pAt(value)), `bin ${value}`).toBeLessThanOrEqual(1e-12);
  }
}

/** Two attacks, `d20+8` vs AC 16: P(at least one crit) = 1 - 0.95². */
const dagger = d20.plus(8).ac(16).onHit(d4.plus(4));
const P_ANY_CRIT = 0.0975;

/** Exact means (Python Fractions over the full enumeration). */
const MAX_OF_TWO_2D6 = 5425 / 648; // 8.3719
const MAX_OF_TWO_2D6_PLUS_3 = 7369 / 648; // 11.3719, O4-hit
const MAX_OF_TWO_4D6_PLUS_3 = 7950193 / 419904; // 18.9334, O4-crit
const MAX_OF_THREE_6D6 = 2968620697 / 120932352; // 24.5478
const MAX_OF_TWO_2D12_PLUS_5 = 107755 / 5184; // 20.7861
const MAX_OF_FOUR_2D6 = 7972693 / 839808; // 9.4935
const FOUR_D6_DROP_LOWEST = 15869 / 1296; // 12.2446

describe("keep-highest-of-1 doubles inside each trial, unchanged", () => {
  it("roll(1,d6).keepHighest(2,1) doubles to 2kh1(2d6), the parsed string's own reading", () => {
    const doubled = roll(1, d6).keepHighest(2, 1).doubleDice();
    expect(doubled.toExpression()).toBe("2kh1(2d6)");
    expectSamePMF(doubled.toPMF(), d("2kh1(2d6)").toPMF());
    expect(doubled.toPMF().mean()).toBeCloseTo(MAX_OF_TWO_2D6, 12);
  });

  it("roll(2,d6).keepHighest(2,1).plus(3) doubles to O4-crit, bin for bin with the pooled crit", () => {
    const doubled = roll(2, d6).keepHighest(2, 1).plus(3).doubleDice();
    expect(doubled.toExpression()).toBe("2kh1(4d6) + 3");
    expectSamePMF(doubled.toPMF(), roll(4, d6).plus(3).keepHighestAll(2, 1).toPMF());
    expectSamePMF(doubled.toPMF(), d("2kh1(4d6) + 3").toPMF());
    expect(doubled.toPMF().mean()).toBeCloseTo(MAX_OF_TWO_4D6_PLUS_3, 12);

    const res = d20.plus(5).ac(12).onHit(roll(2, d6).keepHighest(2, 1).plus(3)).resolve();
    expect(res.hit.mean()).toBeCloseTo(MAX_OF_TWO_2D6_PLUS_3, 12);
    expect(res.crit.mean()).toBeCloseTo(MAX_OF_TWO_4D6_PLUS_3, 12);
    expect(res.weights.crit).toBeCloseTo(0.05, 12);
  });

  it("a die count equal to the trial count stays trials of sums: roll(3,d6).keepHighest(3,1) → 3kh1(6d6)", () => {
    const doubled = roll(3, d6).keepHighest(3, 1).doubleDice();
    expect(doubled.toExpression()).toBe("3kh1(6d6)");
    expect(doubled.toPMF().mean()).toBeCloseTo(MAX_OF_THREE_6D6, 12);
  });

  it("an attack auto-crits roll(1,d12).keepHighest(2,1).plus(5) as 2kh1(2d12) + 5", () => {
    const attack = d20.plus(11).ac(15).onHit(roll(1, 12).keepHighest(2, 1).plus(5));
    expect(attack.toExpression()).toBe("(d20 + 11 AC 15) * (2kh1(1d12) + 5) crit (2kh1(2d12) + 5)");
    expect(attack.resolve().crit.mean()).toBeCloseTo(MAX_OF_TWO_2D12_PLUS_5, 12);
  });

  it("keepHighestAll(2,1) still doubles inside, then pools (O4-crit)", () => {
    const doubled = roll(2, d6).plus(3).keepHighestAll(2, 1).doubleDice();
    expect(doubled.toExpression()).toBe("2kh1(4d6 + 3)");
    expect(doubled.toPMF().mean()).toBeCloseTo(MAX_OF_TWO_4D6_PLUS_3, 12);
  });

  it("parsed NkhK with K = 1 doubles inside: 2kh1(1d6), 2kh1(2d6)+3, 4kh1d6", () => {
    expect(d("2kh1(1d6)").doubleDice().toExpression()).toBe("2kh1(2d6)");
    expect(d("2kh1(1d6)").doubleDice().toPMF().mean()).toBeCloseTo(MAX_OF_TWO_2D6, 12);
    expect(d("2kh1(2d6)+3").doubleDice().toExpression()).toBe("2kh1(4d6)+3");
    expect(d("2kh1(2d6)+3").doubleDice().toPMF().mean()).toBeCloseTo(MAX_OF_TWO_4D6_PLUS_3, 12);
    expect(d("4kh1d6").doubleDice().toExpression()).toBe("4kh1(2d6)");
    expect(d("4kh1d6").doubleDice().toPMF().mean()).toBeCloseTo(MAX_OF_FOUR_2D6, 12);
    // A string max of two dice terms is the same keep-highest-of-1: each side doubles.
    expect(d("d6 > d6").doubleDice().toExpression()).toBe("2d6 > 2d6");
    expect(d("d6 > d6").doubleDice().toPMF().mean()).toBeCloseTo(MAX_OF_TWO_2D6, 12);
  });

  it("a keep-highest-of-1 rider crits at the doubled keep: any-crit adds P(any crit) × O4-crit", () => {
    const rider = turn([dagger, dagger]).rider({ damage: roll(2, d6).keepHighest(2, 1).plus(3), on: "any-crit" });
    expect(rider.mean() - turn([dagger, dagger]).mean()).toBeCloseTo(P_ANY_CRIT * MAX_OF_TWO_4D6_PLUS_3, 10);
  });

  it("a bestOf() that stays a plain sum after doubling doubles as plain dice", () => {
    // bestOf(2) on 1d6 is not below the count before or after (2d6), so it is plain dice both times.
    expect(roll(1, d6).bestOf(2).doubleDice().toPMF().mean()).toBeCloseTo(7, 12);
  });

  it("an advantage attack check is never doubled: its crit rate and doubled payload are unchanged", () => {
    const res = d20.withAdvantage().plus(5).ac(12).onHit(roll(2, d6)).resolve();
    expect(res.weights.crit).toBeCloseTo(0.0975, 12);
    expect(res.crit.mean()).toBeCloseTo(14, 12);
  });
});

describe("an ambiguous per-die keep refuses to double: an explicit crit is required", () => {
  const ambiguous = [
    ["roll(4,d6).keepHighest(4,3)", () => roll(4, d6).keepHighest(4, 3), /4kh3\(1d6\)/],
    ["roll(2,d6).keepHighest(4,3)", () => roll(2, d6).keepHighest(4, 3), /4kh3\(2d6\)/],
    ["roll(1,d6).keepHighest(4,3)", () => roll(1, d6).keepHighest(4, 3), /4kh3\(1d6\)/],
    ["roll(3,d6).keepLowest(3,1)", () => roll(3, d6).keepLowest(3, 1), /3kl1\(1d6\)/],
    ["roll(1,d6).keepLowest(2,1)", () => roll(1, d6).keepLowest(2, 1), /2kl1\(1d6\)/],
    ["roll(4,d6).bestOf(3)", () => roll(4, d6).bestOf(3), /bestOf\(3\)/],
    ["roll(2,d6).bestOf(1)", () => roll(2, d6).bestOf(1), /bestOf\(1\)/],
    ["roll(2,d6).bestOf(3), plain until doubled", () => roll(2, d6).bestOf(3), /bestOf\(3\)/],
    ["d6.withAdvantage()", () => d6.withAdvantage(), /advantage/],
    ["roll(2,d8).withDisadvantage()", () => roll(2, d8).withDisadvantage(), /disadvantage/],
    ["d6.withElvenAccuracy()", () => d6.withElvenAccuracy(), /elven accuracy/],
  ] as const;

  it("doubleDice() and scaleDice(3) throw, naming the shape and suggesting onCrit(...)", () => {
    for (const [name, build, shape] of ambiguous) {
      expect(() => build().doubleDice(), name).toThrow(shape);
      expect(() => build().doubleDice(), name).toThrow(/onCrit\(/);
      expect(() => build().scaleDice(3), name).toThrow(shape);
    }
  });

  it("the throw reaches through a flat, a half, a scale, a sum and a pool built on the keep", () => {
    const keep = () => roll(4, d6).keepHighest(4, 3);
    expect(() => keep().plus(3).doubleDice()).toThrow(/4kh3/);
    expect(() => roll(1, d8).plus(keep()).doubleDice()).toThrow(/4kh3/);
    expect(() => keep().half().doubleDice()).toThrow(/4kh3/);
    expect(() => keep().scaleResult(2).doubleDice()).toThrow(/4kh3/);
    expect(() => keep().keepHighestAll(2, 1).doubleDice()).toThrow(/4kh3/);
  });

  it("an auto-critting attack throws at build (resolve and toExpression), never 88.98", () => {
    const attack = () => d20.plus(5).ac(12).onHit(roll(4, d6).keepHighest(4, 3));
    expect(() => attack().resolve()).toThrow(/4kh3\(1d6\)/);
    expect(() => attack().toExpression()).toThrow(/4kh3\(1d6\)/);
    expect(() => d20.plus(5).ac(12).onHit(d6.withAdvantage()).resolve()).toThrow(/advantage/);
  });

  it("an explicit onCrit(...) resolves with that crit; noCrit() resolves with none", () => {
    const explicitCrit = roll(4, d6).keepHighest(4, 3).plus(roll(4, d6).keepHighest(4, 3));
    const res = d20.plus(5).ac(12).onHit(roll(4, d6).keepHighest(4, 3)).onCrit(explicitCrit).resolve();
    expectSamePMF(res.crit, explicitCrit.toPMF());
    expect(res.crit.mean()).toBeCloseTo(2 * FOUR_D6_DROP_LOWEST, 12);
    expect(res.hit.mean()).toBeCloseTo(FOUR_D6_DROP_LOWEST, 12);
    expect(() =>
      d20.plus(5).ac(12).onHit(roll(4, d6).keepHighest(4, 3)).onCrit(explicitCrit).toExpression()
    ).not.toThrow();

    const none = d20.plus(5).ac(12).onHit(roll(4, d6).keepHighest(4, 3)).noCrit().resolve();
    expect(none.weights.crit).toBe(0);
    expect(none.weights.hit).toBeCloseTo(0.7, 12);
    expect(none.hit.mean()).toBeCloseTo(FOUR_D6_DROP_LOWEST, 12);
  });

  it("a rider refuses to crit the keep, but takes an explicit critDamage", () => {
    expect(() => turn([dagger, dagger]).rider({ damage: roll(4, d6).keepHighest(4, 3), on: "any-crit" }).pmf).toThrow(
      /4kh3\(1d6\)/
    );
    const explicit = turn([dagger, dagger]).rider({
      damage: roll(4, d6).keepHighest(4, 3),
      critDamage: roll(8, d6),
      on: "any-crit",
    });
    expect(explicit.mean() - turn([dagger, dagger]).mean()).toBeCloseTo(P_ANY_CRIT * 28, 10);
  });
});

describe("a parsed keep other than NkhK with K = 1 refuses to double", () => {
  const ambiguous = [
    ["4kh3(1d6)", /4kh3/],
    ["4kh3d6", /4kh3/],
    ["3kh2(2d6 + 1)", /3kh2/],
    ["kh2d6", /kh2/],
    ["3kl1(1d6)", /3kl1/],
    ["2kl1(1d6) + 3", /2kl1/],
    ["1d8 + 4kh3d6", /4kh3/],
    ["2kh1(4kh3(1d6))", /4kh3/],
    ["d6 < d6", /d6 < d6/],
  ] as const;

  it("doubleDice() throws, naming the keep and suggesting an explicit crit", () => {
    for (const [expression, shape] of ambiguous) {
      expect(() => d(expression).doubleDice(), expression).toThrow(shape);
      expect(() => d(expression).doubleDice(), expression).toThrow(/onCrit\(/);
    }
  });

  it("a string cap or floor with one dice side still doubles: 2d6 < 9, 3>d6", () => {
    expect(d("2d6 < 9").doubleDice().toExpression()).toBe("4d6 < 9");
    expect(d("3>d6").doubleDice().toExpression()).toBe("2(3>d6)");
  });

  it('onHit("4kh3(1d6)") throws at build instead of critting at 23.49; an explicit onCrit resolves', () => {
    expect(() => d20.plus(5).ac(12).onHit("4kh3(1d6)").resolve()).toThrow(/4kh3/);
    const res = d20.plus(5).ac(12).onHit("4kh3(1d6)").onCrit("4kh3(1d6) + 4kh3(1d6)").resolve();
    expect(res.crit.mean()).toBeCloseTo(2 * FOUR_D6_DROP_LOWEST, 12);
  });

  it("an attack string with no crit clause throws; a crit clause resolves", () => {
    expect(() => d("(d20 + 5 AC 12) * (4kh3(1d6))")).toThrow(/4kh3/);
    const explicit = d("(d20 + 5 AC 12) * (4kh3(1d6)) crit (4kh3(1d6) + 4kh3(1d6))").toPMF();
    expect(explicit.outcomeProbability("crit")).toBeCloseTo(0.05, 12);
    expectSamePMF(explicit.filterOutcome("crit"), d("4kh3(1d6) + 4kh3(1d6)").toPMF().scaleMass(0.05));
  });

  it("a parsed keep rider is still damage: it refuses to crit, but takes an explicit critDamage", () => {
    expect(() => turn([dagger, dagger]).rider({ damage: d("4kh3(1d6)"), on: "any-crit" }).pmf).toThrow(/4kh3/);
    const explicit = turn([dagger, dagger]).rider({ damage: d("4kh3(1d6)"), critDamage: d("8d6"), on: "any-crit" });
    expect(explicit.mean() - turn([dagger, dagger]).mean()).toBeCloseTo(P_ANY_CRIT * 28, 10);
  });
});

describe("noCrit() rescues an ambiguous keep in a plusSeparateDamage channel (R33 follow-up)", () => {
  it("noCrit() with an ambiguous plusSeparateDamage channel resolves instead of throwing", () => {
    const attack = d20
      .plus(5)
      .ac(12)
      .onHit(roll(2, d6))
      .noCrit()
      .plusSeparateDamage(roll(4, d6).keepHighest(4, 3));
    const res = attack.resolve();
    expect(res.weights.crit).toBe(0);
    expect(res.critSeparate.mass()).toBeCloseTo(1, 12);
    expect(res.critSeparate.pAt(0)).toBeCloseTo(1, 12);
    expectSamePMF(res.crit, res.critBase);
  });

  it("a crittable attack with the same ambiguous channel still throws", () => {
    const attack = d20
      .plus(5)
      .ac(12)
      .onHit(roll(2, d6))
      .plusSeparateDamage(roll(4, d6).keepHighest(4, 3));
    expect(() => attack.resolve()).toThrow(/4kh3/);
  });

  it("an attack that CAN crit stays bin-for-bin unchanged with a plain plusSeparateDamage channel", () => {
    const attack = d20.plus(9).ac(16).onHit(roll(2, d6).plus(5)).plusSeparateDamage(roll(2, d6));
    const res = attack.resolve();
    expectSamePMF(res.hit, res.hitBase.convolve(res.hitSeparate));
    expectSamePMF(res.crit, res.critBase.convolve(res.critSeparate));
    expect(res.critSeparate.mean()).toBeCloseTo(14, 10);
  });
});

describe("diceMatchInfo() on an auto-crit whose crit cannot double", () => {
  it("a keep pool has no descriptor on either branch, as on main, instead of throwing", () => {
    const attack = d20.plus(5).ac(17).onHit(roll(4, d8).keepHighest(4, 3));
    expect(attack.diceMatchInfo()).toEqual({ hit: null, crit: null });
    expect(() => attack.resolve()).toThrow(/4kh3/);
  });

  it("the hit branch keeps its descriptor; the undoublable crit branch has none", () => {
    const attack = d20.plus(5).ac(17).onHit(roll(2, d8).withDisadvantage());
    const { hit, crit } = attack.diceMatchInfo();
    expect(crit).toBeNull();
    expect(hit).toEqual(attack.onCrit(roll(4, d8)).diceMatchInfo().hit);
    expect(hit!.matchProbabilityByDamage.get(2)).toBe(1);
    expect(hit!.matchProbabilityByDamage.get(4)).toBeCloseTo(1 / 3, 12);
  });
});
