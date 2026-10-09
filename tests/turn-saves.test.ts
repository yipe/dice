/**
 * Save rows read save-side effects (disadvantage, penalty dice, `next-save`,
 * `to`), and a condition's grant save is rolled in the target's state with the option it fails
 * least. Each shape runs through `Turn.from` and the brute-force oracle at 1e-12.
 */
import { describe, expect, it } from "vitest";
import { d20, d8, roll, Turn } from "../src/builder";
import type { PMF } from "../src/pmf/pmf";
import { enumerateSyntheticTurn, type GrantSpec, type SyntheticTurn } from "./oracle/bruteForce";
import { attack, CONSTITUTION, DEXTERITY, grant, save } from "./oracle/v2/shapes";
import { oracleTurnToSpec, rowId } from "./oracle/v2/toSpec";

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
  const oracle = enumerateSyntheticTurn(synthetic);
  expect(worst(t.pmf, oracle.pmf)).toBeLessThanOrEqual(TOLERANCE);
  oracle.sources.forEach((pmf, k) => expect(worst(t.marginal(rowId(k)).pmf, pmf)).toBeLessThanOrEqual(TOLERANCE));
}

const rows = { attacks: [attack(), attack()], saves: [save({ ability: "dexterity" }), save({ ability: "wisdom" })] };
const onHit = (extra: Partial<GrantSpec>): GrantSpec => grant({ of: [0, 1], ...extra });

describe("saves: save-side effects and grant saves against the oracle", () => {
  it.each<[string, SyntheticTurn]>([
    ["save disadvantage for the turn", { ...rows, grants: [onHit({ effects: [{ kind: "saveDisadvantage" }] })] }],
    ["save disadvantage until the next save", { ...rows, grants: [onHit({ effects: [{ kind: "saveDisadvantage", lifetime: "next-save" }] })] }],
    ["Frostbite: 1d4 off the next save, once a turn", { ...rows, grants: [onHit({ cap: "once", effects: [{ kind: "savePenalty", count: 1, sides: 4, lifetime: "next-save" }] })] }],
    ["Bane-like penalty for the turn, two sources stack", {
      ...rows,
      grants: [
        onHit({ of: [0], effects: [{ kind: "savePenalty", count: 1, sides: 4 }] }),
        onHit({ of: [1], effects: [{ kind: "savePenalty", count: 1, sides: 6 }] }),
      ],
    }],
    ["save effect scoped to one save row", { ...rows, grants: [onHit({ effects: [{ kind: "saveDisadvantage", to: [3] }] })] }],
    ["a grant save with dc and bonus, onSave branch", {
      ...rows,
      grants: [onHit({ save: CONSTITUTION, effects: [{ kind: "advantage", lifetime: "turn" }], onPass: [{ kind: "advantage", lifetime: "next-attack" }] })],
    }],
    ["a grant save reads earlier save effects, and the target picks its best ability", {
      ...rows,
      grants: [
        onHit({ of: [0], effects: [{ kind: "saveDisadvantage" }, { kind: "savePenalty", count: 1, sides: 4 }] }),
        onHit({ of: [1], save: { ...DEXTERITY, alternatives: [{ ability: "strength", saveBonus: 1 }] }, effects: [{ kind: "saveDisadvantage" }] }),
      ],
    }],
  ])("%s", (_name, synthetic) => {
    expectOracle(synthetic);
  });
});

describe("saves: grant saves as plain data", () => {
  const sword = d20.plus(5).ac(12).onHit(roll(1, d8).plus(3));
  const grants = [{ advantage: true as const, until: "end-of-turn" as const }];

  it("a failChance save gets the target's context, and a constant one equals a chance", () => {
    const withChance = Turn.from({ attacks: [sword, sword], conditions: [{ on: "first-hit", of: ["attack 1"], chance: 0.35, grants }] });
    const seen: string[] = [];
    const withSave = Turn.from({
      attacks: [sword, sword],
      conditions: [
        {
          on: "first-hit",
          of: ["attack 1"],
          save: { failChance: (context) => (seen.push(context.rollType), 0.35) },
          grants,
        },
      ],
    });
    expect(withSave.mean()).toBeCloseTo(withChance.mean(), 12);
    expect(seen).toContain("flat");
  });

  it("refuses a save beside a chance, and a save that is neither shape", () => {
    expect(() => Turn.from({ attacks: [sword], conditions: [{ on: "every-hit", chance: 0.5, save: { dc: 10, bonus: 0 }, grants }] })).toThrow(
      /both a save and a chance/
    );
    expect(() =>
      Turn.from({ attacks: [sword], conditions: [{ on: "every-hit", save: { dc: 10 } as unknown as { dc: number; bonus: number }, grants }] })
    ).toThrow(/neither/);
  });
});

