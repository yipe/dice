import { describe, expect, it } from "vitest";
import { d20, d6, keepBestDamage, roll, Turn, turn } from "../src/builder";

// d20+9 vs AC 18 for 1d12+18, plus a 1d4 channel.
const kensei = d20.plus(9).ac(18).onHit(roll(1, 12).plus(18)).plusSeparateDamage(roll(1, 4));

function expectSamePMF(actual: Turn, expected: Turn): void {
  const support = new Set([...actual.pmf.support(), ...expected.pmf.support()]);
  for (const value of support) expect(actual.pmf.pAt(value)).toBeCloseTo(expected.pmf.pAt(value), 14);
}

describe("an omitted `of` in plain data", () => {
  it("watches the attack-shaped rerolls too, like the chaining spelling", () => {
    const spec = Turn.from({
      attacks: [kensei, kensei],
      riders: [{ id: "reroll", on: "any-miss", damage: kensei }],
      substitutes: [{ id: "sub", on: "first-hit", substitute: "reroll-keep-higher" }],
    });
    const chain = turn([kensei, kensei]).onAnyMiss(kensei, { id: "reroll" }).onFirstHit(keepBestDamage(), { id: "sub" });

    expect(spec.mean()).toBeCloseTo(39638071 / 864000, 12);
    expect(spec.fireProbability("sub")).toBeCloseTo(117 / 125, 14);
    expectSamePMF(spec, chain);
  });

  it("gives a rider the rerolls listed before it, as the chain snapshots them", () => {
    const after = Turn.from({
      attacks: [kensei, kensei],
      riders: [
        { id: "reroll", on: "first-miss", damage: kensei },
        { id: "mark", on: "every-hit", damage: d6 },
      ],
    });
    expectSamePMF(after, turn([kensei, kensei]).onFirstMiss(kensei, { id: "reroll" }).onEveryHit(d6, { id: "mark" }));

    const before = Turn.from({
      attacks: [kensei, kensei],
      riders: [
        { id: "mark", on: "every-hit", damage: d6 },
        { id: "reroll", on: "first-miss", damage: kensei },
      ],
    });
    expectSamePMF(before, turn([kensei, kensei]).onEveryHit(d6, { id: "mark" }).onFirstMiss(kensei, { id: "reroll" }));
  });
});
