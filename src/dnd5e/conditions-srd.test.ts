import { describe, expect, it } from "vitest";
import { d20, d8, roll, turn } from "../builder";
import { effectSpec } from "../turn/effects";
import {
  charmed,
  deafened,
  exhaustion,
  exhaustionRule,
  frightened,
  grappled,
  grappledRule,
  incapacitated,
  invisible,
  petrified,
  poisoned,
  RULES,
} from "./index";

const TOLERANCE = 1e-12;
const close = (actual: number, expected: number): void => {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(TOLERANCE);
};

const sword = d20.plus(7).ac(16).melee().onHit(roll(1, d8).plus(4));
const ranged = d20.plus(7).ac(16).ranged().onHit(roll(1, d8).plus(4));

describe("SRD conditions", () => {
  it("RULES has the 13 keys of the table", () => {
    expect(Object.keys(RULES).sort()).toEqual([
      "blinded",
      "charmed",
      "deafened",
      "frightened",
      "incapacitated",
      "invisible",
      "paralyzed",
      "petrified",
      "poisoned",
      "prone",
      "restrained",
      "stunned",
      "unconscious",
    ]);
  });

  it("the rules are the table's", () => {
    expect(RULES.charmed).toEqual({});
    expect(RULES.deafened).toEqual({});
    expect(RULES.incapacitated).toEqual({});
    expect(RULES.frightened).toEqual({ own: { attack: ["disadvantage"], check: ["disadvantage"] } });
    expect(RULES.poisoned).toEqual({ own: { attack: ["disadvantage"], check: ["disadvantage"] } });
    expect(RULES.blinded).toEqual({
      attack: { melee: ["advantage"], ranged: ["advantage"] },
      own: { attack: ["disadvantage"] },
    });
    expect(RULES.invisible).toEqual({
      attack: { melee: ["disadvantage"], ranged: ["disadvantage"] },
      own: { attack: ["advantage"] },
    });
    expect(RULES.petrified).toEqual({
      attack: { melee: ["advantage"], ranged: ["advantage"] },
      save: { strength: ["autoFail"], dexterity: ["autoFail"] },
    });
    expect(RULES.prone).toEqual({
      attack: { melee: ["advantage"], ranged: ["disadvantage"] },
      own: { attack: ["disadvantage"] },
    });
    expect(RULES.restrained).toEqual({
      attack: { melee: ["advantage"], ranged: ["advantage"] },
      save: { dexterity: ["saveDisadvantage"] },
      own: { attack: ["disadvantage"] },
    });
    expect(RULES.unconscious.onEnd).toEqual({ condition: "prone", rule: RULES.prone });
  });

  it("grappledRule differs by edition", () => {
    expect(grappledRule("2014")).toEqual({});
    expect(grappledRule("2024")).toEqual({ own: { attack: ["disadvantage"] } });
  });

  it("exhaustionRule: the 2014 table is cumulative, 2024 is 2 per level", () => {
    const saves = Object.fromEntries(
      ["strength", "dexterity", "constitution", "intelligence", "wisdom", "charisma"].map((ability) => [
        ability,
        ["saveDisadvantage"],
      ])
    );
    for (const level of [1, 2]) expect(exhaustionRule(level, "2014")).toEqual({ own: { check: ["disadvantage"] } });
    for (const level of [3, 4, 5, 6]) {
      expect(exhaustionRule(level, "2014")).toEqual({
        own: { attack: ["disadvantage"], check: ["disadvantage"] },
        save: saves,
      });
    }
    for (const level of [1, 2, 3, 4, 5, 6]) expect(exhaustionRule(level, "2024")).toEqual({ d20Penalty: 2 * level });
  });

  it("exhaustionRule refuses a level outside 1..6", () => {
    expect(() => exhaustionRule(0, "2024")).toThrow(RangeError);
    expect(() => exhaustionRule(7, "2014")).toThrow(RangeError);
    expect(() => exhaustionRule(1.5, "2014")).toThrow(RangeError);
  });

  it("each effect is its rule as a condition", () => {
    const effects = { charmed, deafened, frightened, incapacitated, invisible, petrified, poisoned };
    for (const [name, make] of Object.entries(effects)) {
      expect(effectSpec(make().untilEndOfTurn())).toEqual({
        condition: name,
        rule: RULES[name as keyof typeof RULES],
        until: "end-of-turn",
      });
    }
    expect(effectSpec(grappled("2024").untilEndOfTurn())).toEqual({
      condition: "grappled",
      rule: grappledRule("2024"),
      until: "end-of-turn",
    });
    expect(effectSpec(exhaustion(3, "2014").untilEndOfTurn())).toEqual({
      condition: "exhaustion",
      rule: exhaustionRule(3, "2014"),
      until: "end-of-turn",
    });
  });

  it("an Invisible target is attacked at disadvantage, a Petrified one at advantage", () => {
    close(turn([sword]).atStart(invisible()).mean(), 3.07125);
    close(turn([ranged]).atStart(petrified()).mean(), 7.57875);
  });

  it("Frightened changes no row of the turn", () => {
    close(turn([sword]).atStart(frightened()).mean(), 5.325);
  });
});
