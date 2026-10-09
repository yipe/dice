/**
 * Effects live per creature (`AttackOptions.target`), a once-per-turn condition
 * waits for a landing with a reader after it on that creature, and `start` conditions are in force
 * from before the first row. Each shape runs through `Turn.from` and the oracle at 1e-12.
 */
import { describe, expect, it } from "vitest";
import { Turn } from "../src/builder";
import type { PMF } from "../src/pmf/pmf";
import { enumerateSyntheticTurn, type SyntheticTurn } from "./oracle/bruteForce";
import { attack, condition, grant, NEXT_ADVANTAGE } from "./oracle/v2/shapes";
import { oracleTurnToSpec, rowId } from "./oracle/v2/toSpec";

const TOLERANCE = 1e-12;

function worst(actual: PMF, expected: ReadonlyMap<number, number>): number {
  let diff = 0;
  for (const value of new Set([...actual.support(), ...expected.keys()])) {
    diff = Math.max(diff, Math.abs(actual.pAt(value) - (expected.get(value) ?? 0)));
  }
  return diff;
}

const ogre = (extra = {}) => attack({ target: 1, ...extra });

describe("creatures: creatures, reader-wait and start against the oracle", () => {
  it.each<[string, SyntheticTurn]>([
    ["a grant on one creature is not read by attacks on another", { attacks: [attack(), ogre(), attack()], grants: [grant({ of: [0], effects: [NEXT_ADVANTAGE] })] }],
    [
      "once a turn: a landing with no reader after it on its creature keeps the try",
      {
        attacks: [ogre(), attack(), attack()],
        grants: [grant({ of: [0, 1], cap: "once", effects: [{ kind: "advantage", lifetime: "turn" }] })],
      },
    ],
    [
      "once a turn over two creatures, readers on both",
      {
        attacks: [attack(), ogre(), attack(), ogre()],
        grants: [grant({ of: [0, 1, 2], cap: "once", effects: [condition("prone")] })],
      },
    ],
    [
      "a start condition on the second creature",
      { attacks: [attack(), ogre(), ogre({ range: "ranged" })], grants: [{ of: [1], trigger: "start", cap: "once", effects: [condition("prone")] }] },
    ],
    [
      "Path to the Grave: vulnerability from the start, used up by the first hit",
      { attacks: [attack(), attack(), attack()], grants: [{ of: [0], trigger: "start", cap: "once", effects: [{ kind: "vulnerability", lifetime: "next-hit" }] }] },
    ],
    ["a starting condition", { attacks: [attack(), attack({ range: "ranged" })], startingCondition: "prone" }],
  ])("%s", (_name, synthetic) => {
    const t = Turn.from(oracleTurnToSpec(synthetic));
    const oracle = enumerateSyntheticTurn(synthetic);
    expect(worst(t.pmf, oracle.pmf)).toBeLessThanOrEqual(TOLERANCE);
    oracle.sources.forEach((pmf, k) => expect(worst(t.marginal(rowId(k)).pmf, pmf)).toBeLessThanOrEqual(TOLERANCE));
  });

  it("a start condition is applied for certain", () => {
    const t = Turn.from(oracleTurnToSpec({ attacks: [attack(), attack()], startingCondition: "restrained" }));
    expect(t.fireProbability("start")).toBeCloseTo(1, 12);
  });
});
