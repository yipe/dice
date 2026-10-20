import { describe, expect, it } from "vitest";
import { d6, d8, d10, d20, roll, turn, Turn, TurnSpecError } from "../src/builder";
import type { AttackBuilder } from "../src/builder";
import type { PMF } from "../src/pmf/pmf";
import { enumerateSyntheticTurn, type SyntheticTurn } from "./oracle/bruteForce";
import { THREE_ROWS } from "./oracle/v2/cases/convertFirstMiss";
import { CONVERT_ID, oracleTurnToSpec } from "./oracle/v2/toSpec";

function expectPmf(actual: PMF, expected: Map<number, number>): void {
  for (const value of new Set([...expected.keys(), ...actual.support()])) {
    expect(Math.abs(actual.pAt(value) - (expected.get(value) ?? 0)), `at ${value}`).toBeLessThanOrEqual(1e-12);
  }
}

// 60% / 60% / 50% to land (crits included) against AC 15, mean hit damage 12 / 12 / 20.
const a = d20.plus(6).ac(15).onHit(roll(2, d6).plus(5));
const b = d20.plus(6).ac(15).onHit(roll(2, d6).plus(5));
const c = d20.plus(4).ac(15).onHit(roll(2, d10).plus(9));
const missOf = (attack: AttackBuilder): number => attack.resolve().weights.miss;

describe("convertFirstMiss", () => {
  it("matches the enumerator's joint PMF on three rows with distinct odds and damage", () => {
    for (const of of [[0, 1, 2], [1, 2], [0]]) {
      const synthetic: SyntheticTurn = { attacks: THREE_ROWS, convertFirstMiss: { of } };
      expectPmf(Turn.from(oracleTurnToSpec(synthetic)).pmf, enumerateSyntheticTurn(synthetic).pmf);
    }
  });

  it("adds the first miss's hit, once: the spec's 11.28 example", () => {
    const plain = turn([a, b, c]);
    const converted = plain.convertFirstMiss({ id: "boon" });
    expect(converted.mean() - plain.mean()).toBeCloseTo(0.4 * 12 + 0.6 * 0.4 * 12 + 0.6 * 0.6 * 0.5 * 20, 12);
    // Spent exactly when some row missed.
    expect(converted.fireProbability("boon")).toBeCloseTo(1 - 0.6 * 0.6 * 0.5, 12);
  });

  it("converts a natural 1, even where only a natural 20 hits", () => {
    const hopeless = d20.plus(0).ac(30).onHit(roll(1, d8).plus(3));
    expect(turn([hopeless]).convertFirstMiss().mean()).toBeCloseTo(0.05 * 12 + 0.95 * 7.5, 12);
    const sure = d20.plus(20).ac(15).onHit(roll(1, d8).plus(3));
    expect(turn([sure]).convertFirstMiss().mean()).toBeCloseTo(0.05 * 12 + 0.95 * 7.5, 12);
  });

  it("converts to a plain hit where every hit crits", () => {
    const paralyzed = d20.plus(5).ac(15).alwaysCrits().onHit(roll(1, d8).plus(3));
    expect(turn([paralyzed]).convertFirstMiss().mean()).toBeCloseTo(0.55 * 12 + 0.45 * 7.5, 12);
  });

  it("is never a crit: the crit odds and a crit-only rider are unchanged", () => {
    const plain = turn([a, b, c]).onAnyCrit(roll(2, d8), { id: "smite" });
    const converted = turn([a, b, c]).convertFirstMiss().onAnyCrit(roll(2, d8), { id: "smite" });
    expect(converted.fireProbability("smite")).toBeCloseTo(plain.fireProbability("smite"), 12);
    expect(converted.marginal("smite").pmf.mean()).toBeCloseTo(plain.marginal("smite").pmf.mean(), 12);
  });

  it("converts only the miss left after advantage or a reroll", () => {
    const advantaged = d20.withAdvantage().plus(6).ac(15).onHit(roll(2, d6).plus(5));
    expect(missOf(advantaged)).toBeCloseTo(0.16, 12);
    expect(turn([advantaged]).convertFirstMiss().mean() - advantaged.mean()).toBeCloseTo(0.16 * 12, 12);
  });

  it("lands Sneak Attack on the converted row when it is the first landing, and not again", () => {
    const sneak = roll(3, d6);
    const synthetic: SyntheticTurn = {
      attacks: THREE_ROWS,
      riders: [{ of: [0, 1, 2], trigger: "hit", damage: { count: 3, sides: 6 } }],
      convertFirstMiss: { of: [0, 1, 2] },
    };
    expectPmf(Turn.from(oracleTurnToSpec(synthetic)).pmf, enumerateSyntheticTurn(synthetic).pmf);
    // With a conversion over every row, something always lands: Sneak Attack always fires.
    expect(turn([a, b, c]).convertFirstMiss().onFirstHit(sneak, { id: "sa" }).fireProbability("sa")).toBeCloseTo(1, 12);
  });

  it("feeds grants: later rows read the state with or without the conversion", () => {
    const synthetic: SyntheticTurn = {
      attacks: THREE_ROWS,
      grants: [{ of: [0, 1], trigger: "hit", cap: "unlimited", effects: [{ kind: "advantage", lifetime: "next-attack" }] }],
      convertFirstMiss: { of: [0, 1, 2] },
    };
    expectPmf(Turn.from(oracleTurnToSpec(synthetic)).pmf, enumerateSyntheticTurn(synthetic).pmf);
  });

  it("starts fresh on a reaction, which is a turn of its own", () => {
    const action = turn([a, b]).convertFirstMiss();
    const reaction = turn([c]).convertFirstMiss();
    // The reaction converts its own miss whether or not the action spent the conversion.
    expect(reaction.mean() - c.mean()).toBeCloseTo(0.5 * 20, 12);
    expect(action.mean() + reaction.mean()).toBeGreaterThan(turn([a, b, c]).convertFirstMiss().mean());
  });

  it("is a substitute in the spec, and refuses what it cannot convert", () => {
    const spec = oracleTurnToSpec({ attacks: THREE_ROWS, convertFirstMiss: { of: [0] } });
    expect(spec.substitutes).toEqual([{ id: CONVERT_ID, on: "first-miss", substitute: "hit", of: ["row:0"] }]);
    const refused = (build: () => Turn): TurnSpecError => {
      try {
        build().mean();
      } catch (error) {
        if (error instanceof TurnSpecError) return error;
        throw error;
      }
      throw new Error("accepted");
    };
    const fireball = d20.plus(3).dc(15).onSaveFailure(roll(8, d6)).saveHalf();
    expect(refused(() => turn([fireball]).convertFirstMiss()).code).toBe("not-an-attack");
    expect(refused(() => turn([a]).onFirstMiss(a, { id: "reroll" }).convertFirstMiss({ of: ["attack 1"] })).code).toBe(
      "unsupported-trigger"
    );
    expect(turn([a]).onFirstMiss(a, { id: "reroll" }).convertFirstMiss({ of: ["reroll"] }).mean()).toBeGreaterThan(
      turn([a]).onFirstMiss(a, { id: "reroll" }).mean()
    );
    expect(refused(() => turn([a, b]).onAnyMiss(a, { id: "reroll" }).convertFirstMiss({ of: ["reroll"] })).code).toBe(
      "unsupported-trigger"
    );
    expect(
      refused(() => Turn.from({ attacks: [a], substitutes: [{ on: "first-miss", substitute: "hit", policy: { kind: "always" } }] })).code
    ).toBe("unsupported-policy");
    expect(refused(() => turn([a]).convertFirstMiss().convertFirstMiss()).code).toBe("duplicate-substitute");
  });
});
