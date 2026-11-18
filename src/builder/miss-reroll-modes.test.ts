import { describe, expect, it } from "vitest";
import { d20, d4, d8 } from "./";
import { clearAttackCache } from "./attack";
import { missRerollOdds } from "./miss-reroll";
import type { MissRerollMode, MissRerollSpec } from "./types";
import { lcgRng } from "../../tests/helpers/lcg";
import { modesOdds, type ModesCase } from "../../tests/oracle/missRerollModes";

type Roll = ModesCase["roll"];

const check = (roll: Roll, toHit: number, ac: number, bless: boolean, critRange: number) => {
  let c = d20.plus(toHit);
  if (bless) c = c.plus(d4);
  if (roll === "advantage") c = c.withAdvantage();
  if (roll === "disadvantage") c = c.withDisadvantage();
  if (roll === "elven") c = c.withElvenAccuracy();
  const row = c.ac(ac);
  return critRange === 20 ? row : row.critOn(critRange);
};

const CASES: { name: string; roll: Roll; toHit: number; ac: number; bless: boolean; critRange: number; modes: MissRerollMode[] }[] = [];
const rolls: Roll[] = ["flat", "advantage", "disadvantage", "elven"];
for (const roll of rolls) {
  for (const [toHit, ac, bless, critRange] of [[5, 15, false, 20], [4, 18, true, 19], [9, 12, true, 20]] as const) {
    for (const modes of [
      ["advantage"],
      ["advantage", "add-d20"],
      ["advantage", "reroll"],
      ["advantage", "advantage"],
      ["reroll", "add-d20"],
      ["add-d20", "reroll"],
      ["add-d4"],
      ["add-d8"],
      ["add-d12"],
    ] as MissRerollMode[][]) {
      // A disadvantage roll composes only after an advantage reroll cancels it.
      if (roll === "disadvantage" && modes.length > 1 && modes[0] !== "advantage") continue;
      // The oracle plays every face of every die: elven accuracy (three d20s a roll) keeps to the one-die modes.
      if (roll === "elven" && (modes.length > 1 || modes[0] === "advantage")) continue;
      CASES.push({ name: `${roll} +${toHit} vs ${ac}${bless ? " +1d4" : ""} crit ${critRange}: ${modes.join(" > ")}`, roll, toHit, ac, bless, critRange, modes });
    }
  }
}

describe("rerollMisses: advantage, composed modes and add-dN, against brute force", () => {
  for (const c of CASES) {
    it(c.name, () => {
      const spec: MissRerollSpec = c.modes.length === 1 ? c.modes[0] : c.modes;
      const built = check(c.roll, c.toHit, c.ac, c.bless, c.critRange);
      const odds = missRerollOdds(built, spec);
      const oracle = modesOdds({
        toHit: c.toHit,
        toHitDice: c.bless ? [{ sides: 4 }] : [],
        ac: c.ac,
        critRange: c.critRange,
        roll: c.roll,
        modes: c.modes,
      });
      expect(odds.hit).toBeCloseTo(oracle.hit, 9);
      expect(odds.crit).toBeCloseTo(oracle.crit, 9);
      expect(odds.miss).toBeCloseTo(oracle.miss, 9);
      expect(odds.unspent).toBeCloseTo(oracle.unspent, 9);
    });
  }

  it("a single reroll or add-d20 is unchanged by the list spelling", () => {
    const built = check("flat", 5, 15, true, 20);
    expect(missRerollOdds(built, ["reroll"])).toEqual(missRerollOdds(built, "reroll"));
  });

  it("refuses an add-dN beside another mode, an unknown mode and an empty list", () => {
    const built = d20.plus(5).ac(15);
    expect(() => built.rerollMisses(["advantage", "add-d8"])).toThrow(/cannot be composed/);
    expect(() => built.rerollMisses("add-d7" as MissRerollMode)).toThrow(/unknown mode/);
    expect(() => built.rerollMisses([])).toThrow(/at least one/);
    expect(() => d20.plus(5).withDisadvantage().ac(15).rerollMisses(["reroll", "add-d20"]).onHit(1, d8).mean()).toThrow(/disadvantage/);
  });
});

describe("AttackBuilder.sample under the new modes agrees with the exact mean", () => {
  const specs: MissRerollSpec[] = ["advantage", ["advantage", "add-d20"], ["reroll", "add-d20"], "add-d8"];
  for (const roll of ["flat", "advantage", "disadvantage"] as Roll[]) {
    for (const spec of specs) {
      if (roll === "disadvantage" && typeof spec !== "string" && spec[0] !== "advantage") continue;
      it(`${roll}: ${JSON.stringify(spec)}`, () => {
        const attack = check(roll, 5, 16, true, 19).rerollMisses(spec).onHit(1, d8);
        const rng = lcgRng(20260511);
        const n = 60000;
        let sum = 0;
        for (let i = 0; i < n; i++) sum += attack.sample(rng).total;
        expect(Math.abs(sum / n - attack.mean())).toBeLessThan(0.06);
      }, 60_000);
    }
  }
});

describe("review regressions", () => {
  it("a reroll replaces the kept die: the sample reports the surviving best die", () => {
    // Advantage roll misses (3, 2); the advantage reroll shows 8, 7 (still a miss); the reroll replaces the 8 and shows 1.
    const faces = [3, 2, 8, 7, 1];
    const rng = { die: () => faces.shift() as number, chance: () => false };
    const attack = d20.withAdvantage().ac(20).rerollMisses(["advantage", "reroll"]).onHit(1, d8);
    const s = attack.sample(rng);
    expect(s.outcome).toBe("miss");
    const keptFaces = s.check.filter((die) => die.kept).map((die) => die.face);
    expect(keptFaces).toEqual([7]);
  });

  it("a fractional AC rounds the shortfall up, as sampling's integer comparison does", () => {
    const whole = missRerollOdds(d20.plus(5).ac(16), "add-d4");
    const half = missRerollOdds(d20.plus(5).ac(15.5), "add-d4");
    expect(half.hit).toBeCloseTo(whole.hit, 12);
    expect(half.miss).toBeCloseTo(whole.miss, 12);
    expect(half.unspent).toBeCloseTo(whole.unspent, 12);
  });

  it("stores its own copy of a mode list", () => {
    const row = d20.plus(5).ac(15);
    const expected = row.rerollMisses(["advantage", "add-d20"]).onHit(1, d8).mean();
    const mutated = row.rerollMisses(["reroll", "add-d20"]).onHit(1, d8).mean();
    expect(mutated).not.toBeCloseTo(expected, 6);
    const modes: MissRerollMode[] = ["advantage", "add-d20"];
    const attack = row.rerollMisses(modes).onHit(1, d8);
    modes[0] = "reroll";
    // Nothing has read the attack yet, and no cached PMF can answer for it: a kept reference would price the mutated list.
    clearAttackCache();
    expect(attack.mean()).toBe(expected);
  });
});
