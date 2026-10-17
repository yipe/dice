import { describe, expect, it } from "vitest";
import { d, d20, roll } from "../src/builder/factory";
import { turn } from "../src/turn/turn";
import type { Rng } from "../src/common/rng";

const script = (faces: number[], coins: boolean[] = []): Rng => ({
  die: () => {
    const f = faces.shift();
    if (f === undefined) throw new Error("out of dice");
    return f;
  },
  chance: () => {
    const c = coins.shift();
    if (c === undefined) throw new Error("out of coins");
    return c;
  },
});
const sword = d20.plus(5).ac(15).onHit(roll(1, 8, 3));

describe("Turn.sample", () => {
  it("one attack: a hit wave with its dice and outcome", () => {
    const t = turn([{ source: sword, id: "sword" }]);
    const trace = t.sample(script([12, 6]));
    expect(trace.total).toBe(9);
    expect(trace.waves).toHaveLength(1);
    expect(trace.waves[0].outcomes).toEqual([{ source: "sword", result: "hit", damage: 9 }]);
    expect(trace.waves[0].dice.map((x) => [x.sides, x.face, x.role])).toEqual([
      [20, 12, "attack"],
      [8, 6, "damage"],
    ]);
  });
  it("first-hit rider fires once, on the first landing, doubled on a crit", () => {
    const t = turn([
      { source: sword, id: "a" },
      { source: sword, id: "b" },
    ]).onFirstHit(roll(2, 6), { id: "sneak" });
    // a: d20=3 misses (no damage). b: d20=20 crits -> 1d8 doubled = 2 dice (4,4). sneak 2d6 doubled on the crit = 4 dice (1,2,3,4).
    const trace = t.sample(script([3, 20, 4, 4, 1, 2, 3, 4]));
    expect(trace.waves.map((w) => w.outcomes.map((o) => o.result))).toEqual([["miss"], ["crit"], ["fired"]]);
  });
  it("any-miss reroll fires only after a miss and reads the miss bit", () => {
    const t = turn([{ source: sword, id: "a" }]).onAnyMiss(sword, { id: "reroll" });
    const hitTrace = t.sample(script([15, 2]));
    expect(hitTrace.waves[hitTrace.waves.length - 1].outcomes[0]).toMatchObject({ source: "reroll", result: "skipped" });
    const missTrace = t.sample(script([2, 16, 5]));
    expect(missTrace.waves[missTrace.waves.length - 1].outcomes[0]).toMatchObject({ source: "reroll", result: "hit", damage: 8 });
  });
  it("a chance attack that does not happen is skipped and spends nothing", () => {
    const t = turn([{ source: sword, id: "a", chance: 0.5 }]);
    const trace = t.sample(script([], [false]));
    expect(trace.waves[0].outcomes[0]).toMatchObject({ result: "skipped", damage: 0 });
    expect(trace.total).toBe(0);
  });
  it("a parsed string source is a chip (no dice)", () => {
    // `d("…")` with an attack clause is a ParsedRollBuilder: its sample() is samplePMF over the labelled PMF (A2), no dice.
    const t = turn([{ source: d("(d20 + 5 AC 15) * (2d6)"), id: "parsed" }]);
    const alwaysLast = {
      die: () => {
        throw new Error("no dice expected");
      },
      chance: () => false,
    }; // inverse CDF picks the last bin
    const trace = t.sample(alwaysLast);
    expect(trace.waves[0].dice).toEqual([]);
    expect(trace.waves[0].outcomes[0].source).toBe("parsed");
  });
  it("returns the sampler version", () => {
    expect(turn([sword]).sample(script([1])).samplerVersion).toBe(1);
  });
});
