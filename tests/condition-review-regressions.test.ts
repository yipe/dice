import { describe, expect, it } from "vitest";
import { d20, d6, d8, roll, Turn, turn, vulnerability } from "../src/builder";
import { paralyzed, prone, restrained } from "../src/dnd5e";
import type { TriggerSave } from "../src/turn/effects";

const sword = d20.plus(8).ac(16).melee().onHit(d8.plus(4));
const bow = d20.plus(8).ac(16).ranged().onHit(d8.plus(4));

describe("SaveBuilder verbs keep attached conditions", () => {
  const base = d20.plus(2).dc(15).onSaveFailure([roll(8, d6), prone().untilEndOfTurn()]);
  const verbs = {
    ability: (s: typeof base) => s.ability("dex"),
    alwaysFails: (s: typeof base) => s.alwaysFails(),
    pinned: (s: typeof base) => s.pinned(),
    saveHalf: (s: typeof base) => s.saveHalf(),
    onSaveSuccess: (s: typeof base) => s.onSaveSuccess(3),
  };
  it.each(Object.entries(verbs))("%s", (_, verb) => {
    expect(verb(base).attached).toEqual(base.attached);
    expect(base.attached).toHaveLength(1);
  });
});

describe("a DC check's ability gates a condition by the target's state", () => {
  const gated = (save: TriggerSave) =>
    turn([sword, sword]).atStart(restrained()).onFirstHit(vulnerability().untilNextHit(), { save });

  it("matches the plain-data spelling and differs from the fixed-chance gate", () => {
    const fluent = gated(d20.plus(1).dc(15).ability("dex")).mean();
    const plain = gated({ ability: "dexterity", dc: 15, bonus: 1 }).mean();
    const fixed = gated(d20.plus(1).dc(15)).mean();
    expect(fluent).toBe(plain);
    expect(fluent).not.toBeCloseTo(fixed, 6);
  });
});

describe("Turn.attack passes every AttackOptions field", () => {
  it("after, target and chance match Turn.from", () => {
    const fluent = turn()
      .attack(sword, "first")
      .attack(sword, { id: "second", after: { of: "first", landing: "hit" }, target: "other", chance: 0.5 });
    const plain = Turn.from({
      attacks: [
        { id: "first", source: sword },
        { id: "second", source: sword, after: { of: "first", landing: "hit" }, target: "other", chance: 0.5 },
      ],
    });
    expect(fluent.pmf.mean()).toBe(plain.pmf.mean());
    const ungated = turn().attack(sword, "first").attack(sword, { id: "second", target: "other", chance: 0.5 });
    expect(fluent.pmf.mean()).not.toBeCloseTo(ungated.pmf.mean(), 6);
  });
});

describe("ranged() is an attack from beyond 5 feet for condition rules", () => {
  it("a ranged attack against a prone target has disadvantage", () => {
    const expected = d20.plus(8).withDisadvantage().ac(16).ranged().onHit(d8.plus(4)).mean();
    expect(turn([bow]).atStart(prone()).mean()).toBeCloseTo(expected, 12);
  });

  it("a ranged attack against a paralyzed target has advantage but no automatic crit", () => {
    const expected = d20.plus(8).withAdvantage().ac(16).ranged().onHit(d8.plus(4)).mean();
    expect(turn([bow]).atStart(paralyzed()).mean()).toBeCloseTo(expected, 12);
  });
});
