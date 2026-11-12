import { describe, expect, it } from "vitest";
import { enumerateSyntheticTurn, type AttackSpec, type RiderSpec, type SyntheticTurn } from "../../tests/oracle/bruteForce";
import { d20, d8, flat, roll, Turn, TurnSpecError } from "../builder";
import { RULES } from "../dnd5e";
import type { Rider, TurnSpec } from "./types";

const TOLERANCE = 1e-12;

const sword = d20.plus(7).ac(16).melee().onHit(roll(1, d8).plus(4));
const fear = d20.plus(2).dc(15).ability("wis").onSaveFailure(0);

/** C1's turn (a failed save frightens, two swords) with one flat 4 rider per name in `names`, each gated on its own condition. */
const spec = (names: readonly string[]): TurnSpec => ({
  attacks: [
    { id: "fear", source: fear },
    { id: "a", source: sword },
    { id: "b", source: sword },
  ],
  riders: names.map((name, index) => ({ id: `rider ${index}`, on: "every-hit", of: ["a", "b"], damage: flat(4), targetHas: [name] }) as Rider),
  conditions: [
    {
      on: "every-hit",
      of: ["fear"],
      landing: "fail",
      grants: [{ condition: "frightened", rule: RULES.frightened, until: "end-of-turn" }],
    },
  ],
});

const swordSpec: AttackSpec = { toHit: 7, ac: 16, critRange: 20, advantage: "flat", range: "melee", damage: { count: 1, sides: 8, flat: 4 } };
const rider = (): RiderSpec => ({ of: [0, 1], trigger: "hit", max: Infinity, damage: { count: 0, sides: 1, flat: 4 }, targetHas: ["frightened"] });
const oracle = (riders: number): SyntheticTurn => ({
  attacks: [swordSpec, swordSpec],
  saves: [{ dc: 15, saveBonus: 2, onSuccess: "none", damage: { count: 0, sides: 1 }, ability: "wisdom" }],
  order: [2, 0, 1],
  grants: [{ of: [2], trigger: "failedSave", cap: "unlimited", effects: [{ kind: "condition", condition: "frightened" }] }],
  riders: Array.from({ length: riders }, rider),
});

describe("targetHas gates scale with distinct conditions, not riders", () => {
  it("31 riders gated on frightened build and evaluate: the mean is the brute-force sum", () => {
    const names = Array.from({ length: 31 }, () => "frightened");
    expect(Math.abs(Turn.from(spec(names)).mean() - enumerateSyntheticTurn(oracle(31)).mean)).toBeLessThanOrEqual(TOLERANCE);
  });

  it("31 riders on 31 distinct conditions are refused as too-many-states, not a RangeError", () => {
    const names = Array.from({ length: 31 }, (_, index) => `invented ${index}`);
    let caught: unknown;
    try {
      Turn.from(spec(names)).mean();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TurnSpecError);
    expect((caught as TurnSpecError).code).toBe("too-many-states");
  });
});
