/**
 * Bookkeeping cases where this library must match dpr's engine, each reduced to its
 * smallest turn. The engine's behaviour wins; every expectation is derived by hand from its rules
 * (turn-calc `calculate.ts`, `plan.ts`, `conditionTable.ts`).
 *
 * d20 + 8 against AC 16 hits on 8-19 (0.6) and crits on 20 (0.05): it lands 0.65 and misses 0.35.
 */
import { describe, expect, it } from "vitest";
import { d20, d4, d6, d8 } from "../src/builder";
import { RULES } from "../src/dnd5e";
import { PMF } from "../src/pmf/pmf";
import {
  Turn,
  type AttackMarginal,
  type ContextualSource,
  type RiderMarginal,
  type RowCheck,
  type TurnSpec,
} from "../src/turn/index";

const melee = d20.plus(8).ac(16).melee().onHit(d8.plus(4));
const ranged = d20.plus(8).ac(16).ranged().onHit(d8.plus(4));
const LAND = 0.65;
const check = (extra: Partial<RowCheck>): RowCheck => ({
  kind: "attack",
  rollType: "flat",
  advantageDice: 2,
  pinned: false,
  autoHit: false,
  autoCrit: false,
  autoFail: false,
  ...extra,
});
/** A payload that lands without a roll (Magic Missile's darts): d4 + 1, every outcome a hit. */
const darts = new PMF(new Map([2, 3, 4, 5].map((damage) => [damage, { p: 0.25, count: { hit: 0.25 } }])));
const auto: ContextualSource = { rowCheck: check({ kind: "auto" }), under: () => darts };
const prone = { condition: "prone", rule: RULES.prone, until: "end-of-turn" as const };
const conditionsAt = (spec: TurnSpec, id: string): [string, number, number][] =>
  Turn.from(spec)
    .stepStats(id)
    .conditions.map(({ id: condition, attempted, taken }) => [condition, attempted, taken]);
const expectConditions = (actual: [string, number, number][], expected: [string, number, number][]): void => {
  expect(actual.map(([id]) => id)).toEqual(expected.map(([id]) => id));
  actual.forEach(([, attempted, taken], i) => {
    expect(attempted).toBeCloseTo(expected[i][1], 12);
    expect(taken).toBeCloseTo(expected[i][2], 12);
  });
};

describe("A: stepStats(id).conditions lists what the engine's grantsTaken lists, in its order", () => {
  it("a condition that may land again and again is tried on every landing, even with nothing to read it", () => {
    // Wisdom save + 0 against DC 13 fails on 1-12: 0.6.
    const spec: TurnSpec = {
      attacks: [{ id: "a", source: ranged }],
      conditions: [
        { id: "c", on: "every-hit", of: ["a"], save: { ability: "wisdom", dc: 13, bonus: 0 }, grants: [{ saveDisadvantage: true, until: "end-of-turn" }] },
      ],
    };
    expectConditions(conditionsAt(spec, "a"), [["c", LAND, LAND * 0.6]]);
  });

  it("a once-per-turn condition is tried only where a later row would get something from it", () => {
    const spec: TurnSpec = {
      attacks: [{ id: "a", source: melee }],
      conditions: [
        {
          id: "stun",
          on: "first-hit",
          of: ["a"],
          save: { ability: "constitution", dc: 13, bonus: 3 },
          grants: [{ condition: "stunned", rule: RULES.stunned, until: "end-of-turn" }],
          onSave: [{ advantage: true, until: "next-attack" }],
        },
      ],
    };
    expectConditions(conditionsAt(spec, "a"), []);
    expect(Turn.from(spec).attemptProbability("stun")).toBe(0);
  });

  it("a later condition's save alone is no reader: the once-per-turn condition puts nothing in force for it", () => {
    // first-miss save disadvantage on a; b's every-hit condition saves with dexterity + 0 against DC 13: 0.6, not 0.84.
    const spec: TurnSpec = {
      attacks: [
        { id: "a", source: melee },
        { id: "b", source: melee },
      ],
      conditions: [
        { id: "shaken", on: "first-miss", of: ["a"], grants: [{ saveDisadvantage: true, until: "end-of-turn" }] },
        { id: "topple", on: "every-hit", of: ["b"], save: { ability: "dexterity", dc: 13, bonus: 0 }, grants: [prone] },
      ],
    };
    expectConditions(conditionsAt(spec, "b"), [["topple", LAND, LAND * 0.6]]);
  });

  it("in the order the row's outcomes are walked (hit, crit, then miss), not declaration order", () => {
    // On the last row the every-hit condition is often in force already (from a's landing); it is
    // still tried first, on the hit.
    const spec: TurnSpec = {
      attacks: [
        { id: "a", source: melee },
        { id: "b", source: melee },
      ],
      conditions: [
        { id: "miss", on: "any-miss", of: ["a", "b"], grants: [{ advantage: true, until: "next-attack" }] },
        { id: "hit", on: "every-hit", of: ["a", "b"], save: { ability: "constitution", dc: 13, bonus: 3 }, grants: [prone] },
      ],
    };
    expect(conditionsAt(spec, "b").map(([id]) => id)).toEqual(["hit", "miss"]);
    expectConditions(conditionsAt(spec, "a"), [
      ["hit", LAND, LAND * 0.45],
      ["miss", 0.35, 0.35],
    ]);
  });
});

describe("B and D: a row that lands without a roll reads no effect", () => {
  it("B: its d20 is its own (flat), whatever advantage is in force", () => {
    const t = Turn.from({
      attacks: [
        { id: "a", source: melee },
        { id: "z", source: auto },
      ],
      conditions: [{ id: "c", on: "any-miss", of: ["a"], grants: [{ advantage: true, until: "next-attack" }] }],
    });
    expect((t.marginal("z") as AttackMarginal).rollType.flat).toBeCloseTo(1, 12);
    expect(t.stepStats("z").live.advantage).toBe(0);
  });

  it("D: a rule that differs by range does not ask it for a range", () => {
    const t = Turn.from({
      attacks: [
        { id: "a", source: melee },
        { id: "z", source: auto },
      ],
      conditions: [{ id: "c", on: "first-hit", of: ["a"], grants: [prone] }],
    });
    expect((t.marginal("z") as AttackMarginal).rollType.flat).toBeCloseTo(1, 12);
    expect(t.marginal("z").pmf.mean()).toBeCloseTo(3.5, 12);
  });
});

describe("C: an every-hit condition already in force is still tried on every landing", () => {
  it("counts each landing as a try, as the engine does", () => {
    // Dexterity save + 0 against DC 13 fails on 1-12: 0.6. Prone (melee: advantage) is on b after a took it: 0.39.
    const spec: TurnSpec = {
      attacks: [
        { id: "a", source: melee },
        { id: "b", source: melee },
        { id: "c", source: melee },
      ],
      conditions: [{ id: "topple", on: "every-hit", of: ["a", "b"], save: { ability: "dexterity", dc: 13, bonus: 0 }, grants: [prone] }],
    };
    const taken = LAND * 0.6;
    const landsB = taken * (1 - 0.35 ** 2) + (1 - taken) * LAND;
    expectConditions(conditionsAt(spec, "b"), [["topple", landsB, landsB * 0.6]]);
  });
});

describe("E: validity never depends on the numbers in one context", () => {
  it("a save row that cannot fail at this DC simply never lands", () => {
    const neverFails: ContextualSource = { rowCheck: check({ kind: "save", ability: "dexterity" }), under: () => PMF.missNone() };
    const t = Turn.from({
      attacks: [{ id: "s", source: neverFails }],
      riders: [{ id: "r", on: "first-hit", of: ["s"], landing: "damage", damage: d6 }],
    });
    const rider = t.marginal("r") as RiderMarginal;
    expect(rider.pmf.pAt(0)).toBeCloseTo(1, 12);
    expect(rider.anyLanding).toBe(0);
    expect([...rider.landings]).toEqual([["s", { hit: 0, crit: 0, doubled: { hit: 0, crit: 0 } }]]);
  });

  it("an attack row that cannot land in this context simply never lands", () => {
    const neverHits: ContextualSource = { rowCheck: check({ range: "melee" }), under: () => PMF.missNone() };
    const t = Turn.from({ attacks: [{ id: "a", source: neverHits }], riders: [{ id: "r", on: "first-hit", of: ["a"], damage: d6 }] });
    expect(t.fireProbability("r")).toBe(0);
  });
});

describe("F: a rider that lands on anything books every landing as a hit", () => {
  it("never as a crit, never doubled", () => {
    const t = Turn.from({ attacks: [{ id: "a", source: melee }], riders: [{ id: "r", on: "first-hit", of: ["a"], landing: "any", damage: d4 }] });
    const landing = (t.marginal("r") as RiderMarginal).landings.get("a");
    expect(landing?.hit).toBeCloseTo(1, 12);
    expect(landing?.crit).toBe(0);
    expect(landing?.doubled).toEqual({ hit: 0, crit: 0 });
  });
});
