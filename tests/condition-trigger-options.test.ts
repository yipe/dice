import { describe, expect, it } from "vitest";
import { advantage, d20, d4, d6, d8, roll, saveDisadvantage, Turn, turn, TurnSpecError, vulnerability } from "../src/builder";
import { prone, restrained, RULES } from "../src/dnd5e";
import type { TriggerSave } from "../src/turn/effects";
import type { ContextualSource, ToPMF } from "../src/turn/types";

const sword = d20.plus(8).ac(16).melee().onHit(d8.plus(4));

const codeOf = (build: () => unknown): string | undefined => {
  try {
    build();
  } catch (error) {
    return error instanceof TurnSpecError ? error.code : `not a TurnSpecError: ${String(error)}`;
  }
  return undefined;
};

describe("a grants-only trigger call keeps or refuses its rider options", () => {
  const base = turn([sword, sword, sword]).onFirstHit(roll(2, d6), { id: "sneak" });
  const proneGrant = { condition: "prone", rule: RULES.prone, until: "end-of-turn" as const };

  it("where limits the rows a rider's landing fires the condition on", () => {
    const fluent = base.onEveryHit(prone().untilEndOfTurn(), { of: ["sneak"], where: { sneak: ["attack 3"] } });
    const plain = Turn.from({
      attacks: [sword, sword, sword],
      riders: [{ id: "sneak", on: "first-hit", damage: roll(2, d6) }],
      conditions: [{ on: "every-hit", of: ["sneak"], where: { sneak: ["attack 3"] }, grants: [proneGrant] }],
    });
    // Prone can only land on the third attack, after which nothing reads it: three swords
    // (3 × 5.75) plus Sneak Attack on the first hit (7 × (1 − 0.35³) × 14/13).
    expect(fluent.mean()).toBeCloseTo(24.46525, 10);
    expect(fluent.mean()).toBe(plain.mean());
    const unscoped = base.onEveryHit(prone().untilEndOfTurn(), { of: ["sneak"] });
    expect(unscoped.mean()).toBeGreaterThan(fluent.mean() + 1);
  });

  it("joins is refused: a grant rolls no dice into a row", () => {
    expect(() => base.onEveryHit(prone().untilEndOfTurn(), { of: ["sneak"], joins: ["attack 2"] })).toThrow(/joins/);
  });
});

describe("joins names rows the rider can land on", () => {
  // A source that pools joined riders' dice: one d6 per rider in `context.joined`.
  const pooling: ContextualSource & ToPMF = {
    rowCheck: sword.rowCheck,
    under: (context, eps = 0) =>
      (context.joined.length === 0 ? sword : d20.plus(8).ac(16).melee().onHit(d8.plus(4).add(roll(context.joined.length, d6)))).under(context, eps),
    toPMF: (eps = 0) => sword.toPMF(eps),
  };

  it("a row the rider does not watch is unknown-id", () => {
    const rider = { id: "a", on: "first-hit" as const, damage: d6, of: ["attack 1"] };
    expect(codeOf(() => Turn.from({ attacks: [pooling, pooling], riders: [{ ...rider, joins: ["attack 1"] }] }).mean())).toBeUndefined();
    expect(codeOf(() => Turn.from({ attacks: [pooling, pooling], riders: [{ ...rider, joins: ["attack 2"] }] }).mean())).toBe("unknown-id");
  });

  it("a not-fired rider has no row to join", () => {
    const first = { id: "a", on: "first-hit" as const, damage: d6, of: ["attack 1"] };
    expect(
      codeOf(() => Turn.from({ attacks: [pooling, pooling], riders: [first, { on: "not-fired", of: "a", damage: d6, joins: ["attack 2"] }] }).mean())
    ).toBe("unsupported-trigger");
  });
});

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
