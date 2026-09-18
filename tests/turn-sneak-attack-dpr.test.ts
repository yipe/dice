import { describe, expect, it } from "vitest";
import "../src/builder/ac";
import "../src/builder/dc";
import { d20, d4, d6, roll } from "../src/builder/factory";
import { parse } from "../src/parser/parser";
import { DiceQuery } from "../src/pmf/query";
import { turn } from "../src/turn";

/**
 * Pinned DPRs for the canonical two-dagger rogue with once-per-turn Sneak Attack,
 * inherited from `sneak-attack-variants.test.ts` — six hand-rolled constructions
 * of this turn that all agreed on these means before `Turn` existed. Their
 * literals were rounded to 4dp (18.6225 / 23.3866 / 12.5445); these are the exact
 * values, which agree to that precision.
 *
 * They are asserted through both entry points, because the string parser and the
 * fluent builder must not drift:
 *   `(d20 + 8 AC 16) * (1d4 + 4) crit (2d4 + 4)` + `3d6` once per turn.
 */
const CASES = [
  { name: "normal", check: "d20", dpr: 18.6225 },
  { name: "advantage", check: "d20 > d20", dpr: 23.38659375 },
  { name: "disadvantage", check: "d20 < d20", dpr: 12.54459375 },
] as const;

describe("Sneak Attack DPR", () => {
  for (const { name, check, dpr } of CASES) {
    it(`matches the pinned ${name} DPR from a parsed expression`, () => {
      const attack = parse(
        `(${check} + 8 AC 16) * (1d4 + 4) crit (2d4 + 4)`
      );
      const rogue = turn([attack, attack]).rider({
        damage: roll(3, d6),
        critDamage: roll(6, d6),
        on: "first-hit",
      });

      expect(rogue.mean()).toBeCloseTo(dpr, 8);
    });
  }

  it("matches the pinned normal DPR from the fluent builder", () => {
    const dagger = d20.plus(8).ac(16).onHit(d4.plus(4));
    const rogue = turn([dagger, dagger]).rider({
      damage: roll(3, d6),
      on: "first-hit",
    });

    expect(rogue.mean()).toBeCloseTo(18.6225, 4);
  });

  it("adds exactly the rider's conditional expectation to the attacks", () => {
    const dagger = d20.plus(8).ac(16).onHit(d4.plus(4));
    const attacks = new DiceQuery([dagger.pmf, dagger.pmf]);
    const rogue = turn([dagger, dagger]).rider({
      id: "sneak",
      damage: roll(3, d6),
      on: "first-hit",
    });

    // P(fires) = P(at least one attack lands); the damage itself is 3d6 or 6d6
    // depending on whether the FIRST landing attack crit.
    expect(rogue.fireProbability("sneak")).toBeCloseTo(0.8775, 10);
    expect(rogue.mean() - attacks.mean()).toBeCloseTo(18.6225 - 8.7, 8);
  });
});
