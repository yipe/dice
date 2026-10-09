import { describe, expect, it } from "vitest";
import { advantage, d20, d4, d8, saveDisadvantage, Turn, turn, TurnSpecError, vulnerability } from "../src/builder";
import { restrained } from "../src/dnd5e";
import type { TriggerSave } from "../src/turn/effects";

const sword = d20.plus(8).ac(16).melee().onHit(d8.plus(4));

const codeOf = (build: () => unknown): string | undefined => {
  try {
    build();
  } catch (error) {
    return error instanceof TurnSpecError ? error.code : `not a TurnSpecError: ${String(error)}`;
  }
  return undefined;
};

describe("a DC check used as a trigger's save is rolled in the target's state", () => {
  const gated = (save: TriggerSave) =>
    turn([sword, sword]).atStart(saveDisadvantage()).onFirstHit(advantage().untilEndOfTurn(), { id: "c", save });

  it("save disadvantage in force applies to a check that names no ability", () => {
    // Attack 1 lands with 0.65; P(d20 + 2 < 15 at disadvantage) = 1 − 0.4² = 0.84.
    expect(gated(d20.plus(2).dc(15)).fireProbability("c")).toBeCloseTo(0.65 * 0.84, 12);
    expect(gated({ dc: 15, bonus: 2 }).fireProbability("c")).toBeCloseTo(0.65 * 0.84, 12);
    // Bless: P(d20 + d4 + 2 < 15 at disadvantage) = Σ_k P(d4 = k) · (1 − ((20 − (12 − k)) / 20)²).
    const bless = [1, 2, 3, 4].reduce((sum, k) => sum + (1 - ((8 + k) / 20) ** 2) / 4, 0);
    expect(gated(d20.plus(2).plus(d4).dc(15)).fireProbability("c")).toBeCloseTo(0.65 * bless, 12);
  });

  it("a check that names no ability where a rule reads saves by ability is save-without-ability", () => {
    expect(
      codeOf(() => turn([sword, sword]).atStart(restrained()).onFirstHit(vulnerability().untilNextHit(), { save: d20.plus(1).dc(15) }))
    ).toBe("save-without-ability");
  });

  it("with nothing in force it is the 0.16 fixed chance, bit for bit", () => {
    const check = d20.plus(2).dc(15);
    const asSave = turn([sword, sword]).onFirstHit(advantage().untilEndOfTurn(), { id: "c", save: check });
    const asChance = turn([sword, sword]).onFirstHit(advantage().untilEndOfTurn(), { id: "c", chance: check.toPMF().pAt(1) });
    expect(asSave.pmf.mean()).toBe(asChance.pmf.mean());
    expect([...asSave.pmf.map]).toEqual([...asChance.pmf.map]);
    expect(asSave.fireProbability("c")).toBeCloseTo(asChance.fireProbability("c"), 12);
    const blessed = d20.plus(2).plus(d4).dc(15);
    const blessSave = turn([sword, sword]).onFirstHit(advantage().untilEndOfTurn(), { save: blessed });
    const blessChance = turn([sword, sword]).onFirstHit(advantage().untilEndOfTurn(), { chance: blessed.toPMF().pAt(1) });
    expect(blessSave.pmf.mean()).toBe(blessChance.pmf.mean());
  });

  it("a save with Elven Accuracy is refused at build time", () => {
    expect(
      codeOf(() =>
        Turn.from({
          attacks: [sword, sword],
          conditions: [{ on: "first-hit", save: { dc: 15, bonus: 2, rollType: "elven accuracy" }, grants: [{ advantage: true, until: "end-of-turn" }] }],
        })
      )
    ).toBe("unsupported-trigger");
  });
});
