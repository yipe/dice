import { describe, expect, it } from "vitest";
import { d20, d4, d8 } from "./";
import type { AttackSample } from "./attack";
import type { Rng } from "../common/rng";
import { lcgRng } from "../../tests/helpers/lcg";

/** An rng that shows the given faces in order. */
const scripted = (faces: number[]): Rng => ({
  die: () => {
    const face = faces.shift();
    if (face === undefined) throw new Error("scripted rng ran out");
    return face;
  },
  chance: () => false,
});

describe("sampleMissReroll reads the check's dice by their own roll", () => {
  it("a subtracted d20 is a bonus die, not a natural face", () => {
    // Brute force /tmp/wirex/cr-sample/bf.py: hit share with the reroll, 77/200 = 0.385 (crit 0.084375).
    const attack = d20.plus(5).minus(d20).ac(10).rerollMisses().onHit(1, d8);
    const rng = lcgRng(7);
    const draws = 20_000;
    let hits = 0;
    for (let i = 0; i < draws; i++) if (attack.sample(rng).outcome === "hit") hits++;
    expect(Math.abs(hits / draws - 0.385)).toBeLessThan(0.01);
  });

  it("a bonus die with advantage counts its kept face", () => {
    const attack = d20.plus(d4.withAdvantage()).ac(15).rerollMisses().onHit(1, d8);
    // Natural 5; bonus d4 faces 1 and 4, the 4 kept: a miss at 9. Rerolled natural 11 + 4 = 15 hits (11 + 1 would miss).
    const first: AttackSample = {
      outcome: "miss",
      check: [
        { sides: 20, face: 5, kept: true },
        { sides: 4, face: 1, kept: false },
        { sides: 4, face: 4, kept: true },
      ],
      damage: [],
      total: 0,
    };
    const again = attack.sampleMissReroll(first, "add-d20", scripted([11, 6]));
    expect(again.outcome).toBe("hit");
  });
});
