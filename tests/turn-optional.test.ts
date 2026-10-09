/**
 * Optional ("you can") conditions decide as the engine's `optionalPolicies` does
 * (dpr `packages/ddb/src/turn/optionalGrants.ts`, `evaluate.ts` `meleeLeaning`): up to three are
 * searched (every subset, the full set first, a tie within 1e-12 keeps it); past three there is no
 * search, and each is attempted where the later attack rolls on its first source's creature are at
 * least as often melee as ranged. That fallback reads ranges, not the rule, so it is the same for
 * every condition in RULES; the test walks each.
 */
import { describe, expect, it } from "vitest";
import { d20, d8, roll, Turn } from "../src/builder";
import { prone as proneEffect, RULES } from "../src/dnd5e";
import type { ContextualSource, RowCheck, TurnSpec } from "../src/turn/types";

const sword = d20.plus(5).ac(14).onHit(roll(1, d8).plus(3));
const check = (range: "melee" | "ranged"): RowCheck => ({
  kind: "attack",
  range,
  rollType: "flat",
  advantageDice: 2,
  pinned: false,
  autoHit: false,
  autoCrit: false,
  autoFail: false,
});
const row = (range: "melee" | "ranged"): ContextualSource => ({
  rowCheck: check(range),
  under: (context) =>
    (context.rollType === "advantage"
      ? sword.withCheck((base) => ({ ...base, rollType: "advantage" }))
      : context.rollType === "disadvantage"
        ? sword.withCheck((base) => ({ ...base, rollType: "disadvantage" }))
        : sword
    ).toPMF(),
});

/** The engine's fallback, restated: melee readers after the first source at least match ranged ones. */
function engineLeans(ranges: readonly ("melee" | "ranged")[], first: number): boolean {
  const later = ranges.slice(first + 1);
  return later.filter((range) => range === "melee").length >= later.filter((range) => range === "ranged").length;
}

describe("optional conditions past the search: the engine's melee-leaning fallback", () => {
  const layouts: ReadonlyArray<readonly ("melee" | "ranged")[]> = [
    ["melee", "melee", "ranged", "melee", "ranged", "ranged"],
    ["ranged", "melee", "ranged", "ranged", "ranged", "melee"],
    ["melee", "ranged", "melee", "melee", "melee", "ranged"],
  ];
  for (const [name, rule] of Object.entries(RULES)) {
    it(`${name}: each of four optional conditions is attempted exactly where the engine attempts it`, () => {
      for (const ranges of layouts) {
        const spec: TurnSpec = {
          attacks: ranges.map((range, i) => ({ id: `a${i}`, source: row(range) })),
          conditions: [0, 1, 2, 3].map((first) => ({
            id: `c${first}`,
            on: "every-hit" as const,
            of: [`a${first}`],
            optional: true as const,
            grants: [{ condition: name, rule, until: "end-of-turn" as const }],
          })),
        };
        const t = Turn.from(spec);
        for (const first of [0, 1, 2, 3]) {
          const attempted = t.fireProbability(`c${first}`) > 0;
          expect(attempted, `${name} ${ranges.join(",")} c${first}`).toBe(engineLeans(ranges, first));
        }
      }
    });
  }
});

describe("optional conditions within the search", () => {
  it("a Prone that only ranged attacks follow is declined; one melee attacks follow is taken", () => {
    const prone = { condition: "prone", rule: RULES.prone, until: "end-of-turn" as const };
    const ranged = Turn.from({
      attacks: [{ id: "a", source: row("melee") }, { id: "b", source: row("ranged") }],
      conditions: [{ id: "c", on: "every-hit", of: ["a"], optional: true, grants: [prone] }],
    });
    expect(ranged.fireProbability("c")).toBe(0);
    const melee = Turn.from({
      attacks: [{ id: "a", source: row("melee") }, { id: "b", source: row("melee") }],
      conditions: [{ id: "c", on: "every-hit", of: ["a"], optional: true, grants: [prone] }],
    });
    expect(melee.fireProbability("c")).toBeCloseTo(0.6, 12); // d20 + 5 vs AC 14 lands on 9..20
  });
});

describe("optional conditions attached to a source", () => {
  it("are searched like the turn's own: an attached Topple followed by bow shots is declined", () => {
    const sword = d20.plus(8).ac(16).melee().onHit(d8.plus(4));
    const bow = d20.plus(8).ac(16).ranged().onHit(d8.plus(4));
    const save = d20.plus(2).dc(15);
    const prone = { condition: "prone", rule: RULES.prone, until: "end-of-turn" as const };
    const attached = Turn.from({
      attacks: [sword.onEveryHit(proneEffect().untilEndOfTurn(), { save, optional: true }), bow, bow],
    });
    // A DC check's PMF puts a failed save at 1: d20 + 2 vs DC 15 fails on 1..12.
    const fail = save.toPMF().pAt(1);
    expect(fail).toBeCloseTo(0.6, 12);
    const gate = (optional: boolean) =>
      Turn.from({
        attacks: [sword, bow, bow],
        conditions: [{ on: "every-hit", of: ["attack 1"], chance: fail, ...(optional ? { optional: true as const } : {}), grants: [prone] }],
      });
    const plain = Turn.from({ attacks: [sword, bow, bow] });
    expect(attached.mean()).toBeCloseTo(plain.mean(), 12);
    expect(gate(true).mean()).toBeCloseTo(plain.mean(), 12);
    // Forced on, the Prone costs the bows: the search above declined something that mattered.
    expect(gate(false).mean()).toBeLessThan(plain.mean() - 0.1);
  });
});
