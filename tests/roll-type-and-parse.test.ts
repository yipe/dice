import { describe, expect, it } from "vitest";
import { PMF } from "../src/pmf/pmf";
import { DiceQuery } from "../src/pmf/query";
import { parse } from "../src/parser/parser";
import { tryParse, withRollType } from "../src/parser/rollType";

describe("tryParse", () => {
  it("parses a valid expression like parse", () => {
    const expression = "(d20 + 5 AC 15) * (1d6 + 2)";
    expect(tryParse(expression).mean()).toBeCloseTo(parse(expression).mean(), 12);
  });

  it("treats a bare number as that much damage", () => {
    expect(tryParse("7").mean()).toBeCloseTo(7, 12);
    expect(tryParse("0").mean()).toBeCloseTo(0, 12);
    expect(tryParse("-3").mean()).toBeCloseTo(-3, 12);
  });

  it("returns an empty PMF for input that is neither", () => {
    for (const bad of ["", "   ", "1d", "AC 15", "(((", "2.5", "seven"]) {
      expect(tryParse(bad).mass()).toBe(PMF.empty().mass());
    }
  });
});

describe("withRollType", () => {
  const attack = "(d20 + 8 AC 16) * (1d4 + 4) crit (2d4 + 4)";

  it("rewrites the attack roll and nothing else", () => {
    expect(withRollType(attack, "advantage")).toBe(
      "(d20 > d20 + 8 AC 16) * (1d4 + 4) crit (2d4 + 4)"
    );
    expect(withRollType(attack, "disadvantage")).toBe(
      "(d20 < d20 + 8 AC 16) * (1d4 + 4) crit (2d4 + 4)"
    );
    expect(withRollType(attack, "elven accuracy")).toBe(
      "(d20 > d20 > d20 + 8 AC 16) * (1d4 + 4) crit (2d4 + 4)"
    );
    expect(withRollType(attack, "flat")).toBe(attack);
  });

  it("round-trips between roll types", () => {
    const advantage = withRollType(attack, "advantage");
    expect(withRollType(advantage, "flat")).toBe(attack);
    expect(withRollType(advantage, "disadvantage")).toBe(
      withRollType(attack, "disadvantage")
    );
  });

  it("keeps a halfling-luck prefix", () => {
    const halfling = "(hd20 + 8 AC 16) * (1d4 + 4)";
    expect(withRollType(halfling, "advantage")).toBe(
      "(hd20 > d20 + 8 AC 16) * (1d4 + 4)"
    );
    expect(withRollType(halfling, "flat")).toBe(halfling);
  });

  it("leaves a saving throw alone: the attacker's advantage is not the target's", () => {
    const save = "(d20 + 5 DC 16) * (8d6) save half";
    for (const rollType of ["advantage", "disadvantage", "flat"] as const) {
      expect(withRollType(save, rollType)).toBe(save);
    }
  });

  it("leaves expressions with no attack roll alone", () => {
    for (const expression of ["3d6", "2(1d8 + 3)", ""]) {
      expect(withRollType(expression, "advantage")).toBe(expression);
    }
  });

  it("produces expressions the parser accepts, with the expected ordering", () => {
    const means = (["disadvantage", "flat", "advantage", "elven accuracy"] as const).map(
      (rollType) => parse(withRollType(attack, rollType)).mean()
    );
    for (let i = 1; i < means.length; i++) {
      expect(means[i]).toBeGreaterThan(means[i - 1]);
    }
  });
});

describe("DiceQuery.outcomeStats", () => {
  it("agrees with snapshot for a single attack", () => {
    const query = new DiceQuery([parse("(d20 + 8 AC 16) * (1d4 + 4)")]);
    const stats = query.outcomeStats();
    const snapshot = query.snapshot();

    expect(stats.size).toBeGreaterThan(0);
    for (const [outcome, stat] of stats) {
      const reference = snapshot.outcomes.get(outcome)!;
      expect(stat.atLeastOneProbability).toBeCloseTo(
        reference.atLeastOneProbability,
        10
      );
      expect(stat.damageRange.avg).toBeCloseTo(reference.damageRange.avg, 10);
    }
  });

  it("scales the damage range by the number of contributing attacks", () => {
    const single = parse("(d20 + 8 AC 16) * (1d4 + 4)");
    const one = new DiceQuery([single]).outcomeStats().get("hit")!;
    const two = new DiceQuery([single, single]).outcomeStats().get("hit")!;

    expect(two.damageRange.avg).toBeCloseTo(2 * one.damageRange.avg, 10);
    expect(two.damageRange.max).toBeCloseTo(2 * one.damageRange.max, 10);
  });

  it("omits outcomes that cannot occur", () => {
    const stats = new DiceQuery([
      parse("(d20 + 8 AC 16) * (1d4 + 4) crit (2d4 + 4)"),
    ]).outcomeStats();
    expect(stats.has("hit")).toBe(true);
    expect(stats.has("crit")).toBe(true);
    expect(stats.has("saveFail")).toBe(false);
    expect(stats.has("missDamage")).toBe(false);
  });

  it("reports P(all attacks produced the outcome)", () => {
    const single = parse("(d20 + 8 AC 16) * (1d4 + 4)");
    const query = new DiceQuery([single, single]);
    const hit = query.outcomeStats().get("hit")!;

    expect(hit.allProbability).toBeCloseTo(query.probExactlyK("hit", 2), 10);
    expect(hit.allProbability).toBeLessThan(hit.atLeastOneProbability);
  });
});
