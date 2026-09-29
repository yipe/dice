import { describe, expect, it } from "vitest";
import "../src/builder/ac";
import "../src/builder/dc";
import { d10, d20, d6, d8, roll, turn } from "../src/builder";

// +9 against AC 16: 6/20 miss, 13/20 hit, 1/20 crit. A hit deals d6+5 (8.5), a crit 2d6+5 (12).
const sword = d20.plus(9).ac(16).onHit(d6.plus(5));
const P_MISS = 6 / 20;
const P_CRIT = 1 / 20;
const P_LAND = 14 / 20;
const MEAN_PER_ATTACK = (13 / 20) * 8.5 + P_CRIT * 12;

/**
 * Every convolve and merge of a walk used to append the identifiers of both operands to the
 * result's, so the identifier of a step-30 state was longer than a JS string can be: a turn of
 * 20 attacks with a rider threw `RangeError: Invalid string length`.
 */
describe("a turn of 34 attacks with riders", () => {
  const rows = 34;

  it("walks to the exact mean of every rider", () => {
    const t = turn()
      .attacks(rows, sword)
      .onFirstHit(roll(3, d6), { id: "sneak" })
      .onAnyCrit(roll(2, d8), { id: "smite" })
      .onEveryHit(d6, { id: "mark" })
      .onAnyMiss(d10, { id: "reroll" });

    const anyLanded = 1 - P_MISS ** rows;
    const anyCrit = 1 - (1 - P_CRIT) ** rows;
    const anyMiss = 1 - P_LAND ** rows;
    // The first landing is a crit with probability P_CRIT / P_LAND; Sneak's 3d6 doubles then.
    const sneak = anyLanded * (10.5 * (1 - P_CRIT / P_LAND) + 21 * (P_CRIT / P_LAND));
    const smite = anyCrit * 18; // 2d8 doubled, always in crit mode
    const mark = rows * ((13 / 20) * 3.5 + P_CRIT * 7);
    const reroll = anyMiss * 5.5;
    const expected = rows * MEAN_PER_ATTACK + sneak + smite + mark + reroll;

    expect(t.mean()).toBeCloseTo(expected, 8);
    expect(t.pmf.mean()).toBeCloseTo(expected, 8);
    expect(t.pmf.mass()).toBeCloseTo(1, 12);
    expect(t.fireProbability("sneak")).toBeCloseTo(anyLanded, 12);
    expect(t.fireProbability("smite")).toBeCloseTo(anyCrit, 12);
    expect(t.fireProbability("reroll")).toBeCloseTo(anyMiss, 12);
  });

  it("keeps the whole distribution, not just its mean", () => {
    const t = turn().attacks(rows, sword).onEveryHit(d6);
    // Every attack lands with probability P_LAND, so P(deal nothing) is P_MISS ** rows.
    expect(t.pmf.pAt(0)).toBeCloseTo(P_MISS ** rows, 12);
    expect(t.pmf.mass()).toBeCloseTo(1, 12);
    expect(t.mean()).toBeCloseTo(rows * (MEAN_PER_ATTACK + (13 / 20) * 3.5 + P_CRIT * 7), 8);
  });
});
