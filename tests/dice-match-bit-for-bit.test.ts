import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as api from "../src/builder";
import { fingerprint, shapeAt } from "./fixtures/dice-match-shapes";

/**
 * What a dice-match descriptor and the turns that read it computed in 0.15.0 must not move when a
 * pool of groups, or a reroll pool, gains one. `fixtures/dice-match-golden.json` holds a SHA-256 of
 * each of 400 random shapes of `fixtures/dice-match-shapes.ts` (a plain pool of one kind of die with
 * a `minimum`, a `reroll`, a flat, an explicit, auto or no crit, a separate channel and attack-level
 * rerolls, read by a bounce chain, a damage rider, an attack-shaped follow-on or a second attack),
 * captured from the 0.15.0 build: the hit and crit descriptors' every value and the turn's PMF, each
 * as its exact bits. A change of one ulp anywhere fails.
 */
const golden = JSON.parse(readFileSync(new URL("./fixtures/dice-match-golden.json", import.meta.url), "utf8")) as Record<
  string,
  string
>;

describe("dice-match descriptors and the turns that read them are bit for bit what 0.15.0 computed", () => {
  it("pins 400 shapes", () => {
    expect(Object.keys(golden)).toHaveLength(400);
  });

  // 400 full turn evaluations: well past vitest's 5 s default on a slow runner or under the compat recorder.
  it("moves none of them", { timeout: 60_000 }, () => {
    const moved = Object.entries(golden)
      .filter(([index, digest]) => fingerprint(api, shapeAt(Number(index))) !== digest)
      .map(([index]) => index);
    expect(moved).toEqual([]);
  });
});
