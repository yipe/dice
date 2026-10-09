import { describe, expect, it } from "vitest";
import { d20, d8 } from "../builder";
import { advantage } from "../turn/effects";
import { turn } from "../turn/turn";
import { saveDC } from "./index";

describe("saveDC", () => {
  it.each([
    [{ con: 2 }, { ability: "constitution", dc: 15, bonus: 2 }],
    [{ constitution: 2 }, { ability: "constitution", dc: 15, bonus: 2 }],
    [{ str: -1 }, { ability: "strength", dc: 15, bonus: -1 }],
    [{ dex: 0 }, { ability: "dexterity", dc: 15, bonus: 0 }],
    [{ int: 4 }, { ability: "intelligence", dc: 15, bonus: 4 }],
    [{ wis: 3 }, { ability: "wisdom", dc: 15, bonus: 3 }],
    [{ charisma: 1 }, { ability: "charisma", dc: 15, bonus: 1 }],
  ])("one ability, %o, is one save by its full name", (bonuses, expected) => {
    expect(saveDC(15, bonuses)).toEqual(expected);
  });

  it("several abilities are the list the target picks from, in the order given", () => {
    expect(saveDC(15, { str: 5, dex: 1 })).toEqual([
      { ability: "strength", dc: 15, bonus: 5 },
      { ability: "dexterity", dc: 15, bonus: 1 },
    ]);
  });

  it.each([
    ["no ability", () => saveDC(15, {})],
    ["an unknown ability", () => saveDC(15, { luck: 2 } as never)],
    ["a prototype key", () => saveDC(15, { toString: 2 } as never)],
    ["the same ability twice", () => saveDC(15, { con: 2, constitution: 2 })],
    ["a fractional dc", () => saveDC(15.5, { con: 2 })],
    ["a NaN dc", () => saveDC(Number.NaN, { con: 2 })],
    ["a fractional bonus", () => saveDC(15, { con: 2.5 })],
    ["an infinite bonus", () => saveDC(15, { con: Number.POSITIVE_INFINITY })],
  ])("throws a TypeError on %s", (_, call) => {
    expect(call).toThrow(TypeError);
  });

  it("is accepted wherever a trigger takes save: the same condition as the DC check with ability()", () => {
    const sword = d20.plus(8).ac(16).melee().onHit(d8);
    const sugared = turn([sword, sword]).onFirstHit(advantage().untilEndOfTurn(), { save: saveDC(15, { str: 5, dex: 1 }) });
    const spelled = turn([sword, sword]).onFirstHit(advantage().untilEndOfTurn(), {
      save: [d20.plus(5).dc(15).ability("str"), d20.plus(1).dc(15).ability("dex")],
    });
    expect(sugared.mean()).toBe(spelled.mean());
  });
});
