/**
 * Conditions as `ConditionRule` data (attack rolls by range, saves by ability,
 * the grant's own save), `until-damaged` with the condition it leaves behind (`onEnd`), a rider
 * that wakes the creature, and optional grants. Each shape runs through `Turn.from` and the
 * brute-force oracle at 1e-12; the new error codes are raised and fixed.
 */
import { describe, expect, it } from "vitest";
import { d20, d6, d8, roll, Turn, TurnSpecError } from "../src/builder";
import { RULES } from "../src/dnd5e";
import type { PMF } from "../src/pmf/pmf";
import type { ContextualSource, RowCheck, TurnSpec } from "../src/turn/types";
import { enumerateSyntheticTurn, type SyntheticTurn } from "./oracle/bruteForce";
import { attack, condition, CONSTITUTION, DEXTERITY, grant, save, sneak, STRENGTH } from "./oracle/v2/shapes";
import { oracleTurnToSpec, riderId, rowId } from "./oracle/v2/toSpec";

const TOLERANCE = 1e-12;

function worst(actual: PMF, expected: ReadonlyMap<number, number>): number {
  let diff = 0;
  for (const value of new Set([...actual.support(), ...expected.keys()])) {
    diff = Math.max(diff, Math.abs(actual.pAt(value) - (expected.get(value) ?? 0)));
  }
  return diff;
}

function expectOracle(synthetic: SyntheticTurn): void {
  const t = Turn.from(oracleTurnToSpec(synthetic));
  const oracle = enumerateSyntheticTurn(synthetic, { detail: true });
  expect(worst(t.pmf, oracle.pmf)).toBeLessThanOrEqual(TOLERANCE);
  oracle.sources.forEach((pmf, k) => expect(worst(t.marginal(rowId(k)).pmf, pmf)).toBeLessThanOrEqual(TOLERANCE));
  oracle.detail?.riders.forEach((rider, k) => expect(worst(t.marginal(riderId(k)).pmf, rider.pmf)).toBeLessThanOrEqual(TOLERANCE));
}

const KNOCK_OUT = { kind: "condition", condition: "unconscious", lifetime: "until-damaged" } as const;

describe("conditions: conditions against the oracle", () => {
  it.each<[string, SyntheticTurn]>([
    [
      "Prone on a failed Strength save: melee advantage, ranged disadvantage",
      {
        attacks: [attack(), attack(), attack({ range: "ranged" }), attack()],
        grants: [grant({ of: [0], save: STRENGTH, effects: [condition("prone")] })],
      },
    ],
    [
      "Stunned fails a Dexterity save, Restrained gives it disadvantage",
      {
        attacks: [attack(), attack()],
        saves: [save({ ability: "dexterity" }), save({ ability: "constitution" })],
        grants: [grant({ of: [0], save: CONSTITUTION, effects: [condition("stunned")] }), grant({ of: [1], effects: [condition("restrained")] })],
      },
    ],
    [
      "the grant's own save picks the ability its conditions spare",
      {
        attacks: [attack(), attack(), attack()],
        grants: [
          grant({ of: [0], effects: [condition("restrained")] }),
          grant({ of: [1], save: { ...DEXTERITY, alternatives: [{ ability: "strength", saveBonus: 0 }] }, effects: [condition("prone")] }),
        ],
      },
    ],
    [
      "Knock Out: Unconscious until damaged, then Prone for the turn",
      { attacks: [attack(), attack(), attack({ range: "ranged" }), attack()], grants: [grant({ of: [0], cap: "once", save: CONSTITUTION, effects: [KNOCK_OUT] })] },
    ],
    [
      "optional Topple: taken only where it raises the mean",
      {
        attacks: [attack(), attack({ range: "ranged" }), attack({ range: "ranged" })],
        grants: [grant({ of: [0], optional: true, save: STRENGTH, effects: [condition("prone")] })],
      },
    ],
  ])("%s", (_name, synthetic) => {
    expectOracle(synthetic);
  });
});

describe("conditions: a rider wakes the creature on the row it lands on", () => {
  it("a Sneak Attack landing on a hit that deals nothing ends Unconscious there", () => {
    const synthetic: SyntheticTurn = {
      attacks: [attack(), attack({ damage: { count: 1, sides: 4, flat: -4, floorAtZero: true } }), attack()],
      grants: [grant({ of: [0], effects: [KNOCK_OUT] })],
      riders: [sneak({ of: [1, 2] })],
    };
    const spec = oracleTurnToSpec(synthetic);
    // The rider's payload as a plain builder (the oracle's 2d6, doubled on a crit).
    const riders = (spec.riders ?? []).map((rider) => ({ ...rider, damage: roll(2, d6) }) as typeof rider);
    const t = Turn.from({ ...spec, riders });
    const oracle = enumerateSyntheticTurn(synthetic, { detail: true });
    expect(worst(t.pmf, oracle.pmf)).toBeLessThanOrEqual(TOLERANCE);
    oracle.sources.forEach((pmf, k) => expect(worst(t.marginal(rowId(k)).pmf, pmf)).toBeLessThanOrEqual(TOLERANCE));
    expect(worst(t.marginal(riderId(0)).pmf, oracle.detail!.riders[0]!.pmf)).toBeLessThanOrEqual(TOLERANCE);
  });
});

describe("conditions: the rule error codes", () => {
  const sword = d20.plus(5).ac(12).onHit(roll(1, d8).plus(3));
  const rowCheck = (extra: Partial<RowCheck>): RowCheck => ({
    kind: "attack",
    rollType: "flat",
    advantageDice: 2,
    pinned: false,
    autoHit: false,
    autoCrit: false,
    autoFail: false,
    ...extra,
  });
  const fireball = d20.plus(2).dc(15).onSaveFailure(roll(8, d6));
  const row = (extra: Partial<RowCheck>): ContextualSource => ({
    rowCheck: rowCheck(extra),
    under: () => (extra.kind === "save" ? fireball.toPMF() : sword.toPMF()),
  });
  const prone = { condition: "prone", rule: RULES.prone, until: "end-of-turn" as const };
  const codeOf = (spec: TurnSpec): string | undefined => {
    try {
      Turn.from(spec).mean();
    } catch (error) {
      return error instanceof TurnSpecError ? error.code : String(error);
    }
    return undefined;
  };

  it("unknown-range: a rule that differs by range needs the row's range", () => {
    const spec = (range?: "melee" | "ranged"): TurnSpec => ({
      attacks: [sword, row(range === undefined ? {} : { range })],
      conditions: [{ on: "every-hit", of: ["attack 1"], grants: [prone] }],
    });
    expect(codeOf(spec())).toBe("unknown-range");
    expect(codeOf(spec("ranged"))).toBeUndefined();
    // A rule the same at every range needs none.
    expect(codeOf({ ...spec(), conditions: [{ on: "every-hit", of: ["attack 1"], grants: [{ ...prone, rule: RULES.blinded }] }] })).toBeUndefined();
  });

  it("save-without-ability and unknown-ability: saves where a rule reads saves by ability", () => {
    const stunned = { condition: "stunned", rule: RULES.stunned, until: "end-of-turn" as const };
    const spec = (save: TurnSpec["attacks"][number]): TurnSpec => ({
      attacks: [sword, save],
      conditions: [{ on: "every-hit", of: ["attack 1"], grants: [stunned] }],
    });
    expect(codeOf(spec(fireball))).toBe("save-without-ability");
    expect(codeOf(spec(fireball.ability("dex")))).toBeUndefined();
    expect(codeOf(spec(row({ kind: "save", ability: "luck" })))).toBe("unknown-ability");
    expect(
      codeOf({ attacks: [sword], conditions: [{ on: "every-hit", save: { dc: 12, bonus: 1 }, grants: [stunned] }] })
    ).toBe("save-without-ability");
  });
});
