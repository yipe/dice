import { describe, expect, it } from "vitest";
import "../src/builder/ac";
import "../src/builder/dc";
import { d10, d20, d4, d6, d8, roll } from "../src/builder/factory";
import { turn, TurnSpecError } from "../src/turn";

const dagger = d20.plus(8).ac(16).onHit(d4.plus(4));
const unarmed = d20.plus(8).ac(16).onHit(d6.plus(4));

describe("chained trigger methods", () => {
  it("each onX method matches the equivalent rider object", () => {
    const pairs = [
      [turn([dagger, dagger]).onFirstHit(roll(3, d6)), { on: "first-hit" }],
      [turn([dagger, dagger]).onAnyCrit(roll(3, d6)), { on: "any-crit" }],
      [turn([dagger, dagger]).onAnyMiss(roll(3, d6)), { on: "any-miss" }],
      [turn([dagger, dagger]).onEveryHit(roll(3, d6)), { on: "every-hit" }],
    ] as const;

    for (const [chained, trigger] of pairs) {
      const spelled = turn([dagger, dagger]).rider({
        damage: roll(3, d6),
        ...trigger,
      });
      expect(chained.mean()).toBeCloseTo(spelled.mean(), 12);
      expect(chained.pmf.stdev()).toBeCloseTo(spelled.pmf.stdev(), 12);
    }
  });

  it("passes options through", () => {
    const chained = turn([dagger, dagger]).onAnyCrit(d6, {
      id: "smite",
      critDamage: roll(10, d6),
      of: ["attack 1"],
    });
    const spelled = turn([dagger, dagger]).rider({
      id: "smite",
      damage: d6,
      critDamage: roll(10, d6),
      on: "any-crit",
      of: ["attack 1"],
    });

    expect(chained.mean()).toBeCloseTo(spelled.mean(), 12);
    expect(chained.fireProbability("smite")).toBeCloseTo(0.05, 10);
  });

  it("builds the goliath turn identically to the rider form", () => {
    const chained = turn([dagger, dagger])
      .onFirstHit(roll(3, d6))
      .onFirstHit(d10)
      .onAnyCrit(roll(2, d8), { id: "smite" })
      .otherwise([unarmed, unarmed])
      .onEveryHit(d6);

    const spelled = turn([dagger, dagger])
      .rider({ damage: roll(3, d6), on: "first-hit" })
      .rider({ damage: d10, on: "first-hit" })
      .rider({ id: "smite", damage: roll(2, d8), on: "any-crit" })
      .rider({ damage: [unarmed, unarmed], on: "not-fired", of: "smite" })
      .rider({ damage: d6, on: "every-hit" });

    expect(chained.mean()).toBeCloseTo(spelled.mean(), 10);
    expect(chained.pmf.stdev()).toBeCloseTo(spelled.pmf.stdev(), 10);
    expect(chained.fireProbability("smite")).toBeCloseTo(0.0975, 10);
  });
});

describe("otherwise()", () => {
  it("negates the preceding rider even when it has no id", () => {
    const built = turn([dagger, dagger]).onAnyCrit(roll(2, d8)).otherwise(d6);

    const base = turn([dagger, dagger]).mean();
    const pCrit = 0.0975;
    // 4d8 on a crit (the dice double), 1d6 the rest of the time.
    expect(built.mean() - base).toBeCloseTo(pCrit * 18 + (1 - pCrit) * 3.5, 8);
  });

  it("makes the pair mutually exclusive", () => {
    const built = turn([dagger, dagger])
      .onAnyCrit(roll(2, d8), { id: "smite" })
      .otherwise(d6, { id: "flurry" });

    expect(
      built.fireProbability("smite") + built.fireProbability("flurry")
    ).toBeCloseTo(1, 10);
  });

  it("alternates rather than ladders when chained", () => {
    // `c` fires whenever `b` did not, which is exactly when `a` did.
    const built = turn([dagger, dagger])
      .onAnyCrit(roll(2, d8))
      .otherwise(d6)
      .otherwise(d4);

    const base = turn([dagger, dagger]).mean();
    const pCrit = 0.0975;
    expect(built.mean() - base).toBeCloseTo(
      pCrit * (18 + 2.5) + (1 - pCrit) * 3.5,
      8
    );
  });

  it("rejects a missing predecessor", () => {
    expect(() => turn([dagger]).otherwise(d6)).toThrow(TurnSpecError);
  });

  it("rejects negating an every-hit rider", () => {
    expect(() => turn([dagger]).onEveryHit(d6).otherwise(d6)).toThrow(
      /more than once/
    );
  });
});
