import { describe, expect, it } from "vitest";
import "../src/builder/ac";
import "../src/builder/dc";
import { d10, d20, d4, d6, d8, flat, roll } from "../src/builder/factory";
import { onAnyHit, onCritOnly } from "../src/common/types";
import { PMF } from "../src/pmf/pmf";
import { DiceQuery } from "../src/pmf/query";
import { Turn, turn } from "../src/turn";

/**
 * Every figure quoted in the README's "Damage Riders" section. Docs that quote
 * numbers drift silently; these fail loudly instead.
 */
const dagger = d20.plus(8).ac(16).onHit(d4.plus(4));
const sword = d20.plus(9).ac(16).onHit(d6.plus(5));
const greatsword = d20.plus(9).ac(16).onHit(roll(2, d6).plus(5));
const unarmed = d20.plus(8).ac(16).onHit(d6.plus(4));
const poison = d20.dc(13).onSaveFailure(roll(3, d6)).saveHalf();

describe("README: the rogue", () => {
  const rogue = turn([dagger, dagger]).onFirstHit(roll(3, d6));

  it("quotes the right mean and whiff chance", () => {
    expect(rogue.mean()).toBeCloseTo(18.6225, 4);
    expect(rogue.pmf.pAt(0)).toBeCloseTo(0.1225, 4);
  });

  it("quotes the right wrong answer for the naive construction", () => {
    const attacks = new DiceQuery([dagger.pmf, dagger.pmf]);
    const [pHit, pCrit] = attacks.firstSuccessSplit(onAnyHit, onCritOnly);
    const naive = new DiceQuery([
      dagger.pmf,
      dagger.pmf,
      PMF.exclusive([
        [roll(3, d6).pmf, pHit],
        [roll(3, d6).doubleDice().pmf, pCrit],
      ]),
    ]);
    expect(naive.combined.pAt(0)).toBeCloseTo(0.015, 3);
  });

  it("quotes the right statistics", () => {
    expect(rogue.pmf.stdev()).toBeCloseTo(8.886, 3);
    expect(rogue.toQuery().probTotalAtLeast(20)).toBeCloseTo(0.5062, 4);
    expect(rogue.toQuery().percentiles([0.25, 0.5, 0.75])).toEqual([15, 20, 24]);
  });
});

describe("README: extra attack", () => {
  it("quotes the right means for 4 and 8 attacks", () => {
    expect(turn().attacks(4, sword).onEveryHit(d6).mean()).toBeCloseTo(35, 6);
    expect(turn().attacks(8, sword).onEveryHit(d6).mean()).toBeCloseTo(70, 6);
  });

  it("matches spelling the attacks out by hand", () => {
    expect(turn().attacks(2, sword).mean()).toBeCloseTo(
      turn([sword, sword]).mean(),
      12
    );
  });

  it("rejects a count that is not a positive integer", () => {
    expect(() => turn().attacks(0, sword)).toThrow(RangeError);
    expect(() => turn().attacks(-1, sword)).toThrow(RangeError);
    expect(() => turn().attacks(2.5, sword)).toThrow(RangeError);
  });
});

describe("README: a rider can be anything that makes damage", () => {
  it("accepts a whole attack, a saving throw, a flat bonus and a list", () => {
    expect(
      turn([greatsword, greatsword]).onAnyCrit(greatsword).mean()
    ).toBeGreaterThan(turn([greatsword, greatsword]).mean());
    expect(turn([dagger]).onFirstHit(poison).mean()).toBeGreaterThan(
      turn([dagger]).mean()
    );
    // Rage adds its 2 on every landing attack, crit or not, so the gain is
    // exactly 2 x P(one attack lands) x 2 attacks.
    const pLands = new DiceQuery([sword.pmf]).probAtLeastOne(onAnyHit);
    expect(turn([sword, sword]).onEveryHit(flat(2)).mean()).toBeCloseTo(
      turn([sword, sword]).mean() + 2 * 2 * pLands,
      6
    );
    expect(
      turn([dagger, dagger])
        .onAnyCrit(roll(4, d8))
        .otherwise([unarmed, unarmed])
        .mean()
    ).toBeGreaterThan(0);
  });
});

describe("README: the goliath and the single-attack turn", () => {
  it("quotes the right mean", () => {
    const goliath = turn([dagger, dagger])
      .onFirstHit(roll(3, d6))
      .onFirstHit(d10)
      .onAnyCrit(roll(2, d8))
      .otherwise([unarmed, unarmed])
      .onEveryHit(d6);
    // Exactly 39.59025 (8.7 dagger + 9.9225 sneak + 5.1975 burn + 1.755 smite + 9.11525 flurry
    // + 4.9 mark), which the README rounds to 39.5903.
    expect(goliath.mean()).toBeCloseTo(39.59025, 10);
  });

  it("accepts a bare source as well as a list", () => {
    expect(turn(greatsword).mean()).toBeCloseTo(turn([greatsword]).mean(), 12);
  });
});

describe("README: ids and plain data", () => {
  const paladin = turn([dagger, dagger]).onAnyCrit(roll(2, d8), { id: "smite" });

  it("quotes the right ids and fire probability", () => {
    expect(paladin.fireProbability("smite")).toBeCloseTo(0.0975, 4);
    expect(paladin.attackIds).toEqual(["attack 1", "attack 2"]);
    expect(paladin.riderIds).toEqual(["smite"]);
  });

  it("builds the same turn from plain data", () => {
    const fromUI = Turn.from({
      attacks: [
        { id: "dagger 1", source: dagger },
        { id: "dagger 2", source: dagger },
      ],
      riders: [{ id: "sneak", damage: roll(3, d6), on: "first-hit" }],
    });
    expect(fromUI.mean()).toBeCloseTo(18.6225, 4);
  });
});
