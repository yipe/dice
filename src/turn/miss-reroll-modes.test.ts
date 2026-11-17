import { describe, expect, it } from "vitest";
import { d20, d4, d6, d8, roll, turn, Turn } from "../builder";
import type { Rng } from "../common/rng";
import type { MissRerollSpec } from "../builder/types";
import { lcgRng } from "../../tests/helpers/lcg";
import { modesOdds, type ModesCase } from "../../tests/oracle/missRerollModes";

const SWORD = { hit: 7.5, crit: 12 }; // 1d8+3, dice doubled on a crit
const RIDER = { hit: 3.5, crit: 7 }; // 1d6 on the first landing, doubled on a crit

type Mode = "hit" | "crit";

const base = (bless: boolean) => ({ toHit: 5, toHitDice: bless ? [{ sides: 4 }] : [], ac: 15, critRange: 20 });
const attackOf = (roll_: ModesCase["roll"], bless: boolean) => {
  let c = d20.plus(5);
  if (bless) c = c.plus(d4);
  if (roll_ === "advantage") c = c.withAdvantage();
  if (roll_ === "disadvantage") c = c.withDisadvantage();
  return c.ac(15).onHit(roll(1, d8).plus(3));
};

/** P(first roll) as hit/crit/miss, by the oracle's own enumeration of the unrerolled row. */
function asRolled(roll_: ModesCase["roll"], bless: boolean): { hit: number; crit: number; miss: number } {
  // A zero-mode oracle row: every face of the dice as rolled, no reroll.
  const all = { hit: 0, crit: 0, miss: 0 };
  const rolled = roll_ === "flat" ? 1 : 2;
  const totals = new Map<number, number>([[5, 1]]);
  if (bless) {
    totals.clear();
    for (let f = 1; f <= 4; f++) totals.set(5 + f, 0.25);
  }
  const faces = (dice: number[], p: number, bonus: number): void => {
    if (dice.length < rolled) {
      for (let f = 1; f <= 20; f++) faces([...dice, f], p / 20, bonus);
      return;
    }
    const k = roll_ === "disadvantage" ? Math.min(...dice) : Math.max(...dice);
    const key = k === 20 ? "crit" : k === 1 || k + bonus < 15 ? "miss" : "hit";
    all[key] += p;
  };
  for (const [bonus, p] of totals) faces([], p, bonus);
  return all;
}

type Outcomes = { name: string; p: number; value: Mode | "miss"; spends: boolean }[];

/**
 * A row's outcomes in the turn: as rolled (hit, crit), and each miss: unspent (`spends: false`) or rolled again to a hit, a
 * crit or a miss (`spends: true`). Every probability is the oracle's own enumeration.
 */
function outcomesOf(roll_: ModesCase["roll"], bless: boolean, modes: ModesCase["modes"]): Outcomes {
  const rolled = asRolled(roll_, bless);
  const again = modesOdds({ ...base(bless), roll: roll_, modes });
  const out: Outcomes = [
    { name: "hit", p: rolled.hit, value: "hit", spends: false },
    { name: "crit", p: rolled.crit, value: "crit", spends: false },
  ];
  if (again.unspent > 0) out.push({ name: "miss kept", p: again.unspent, value: "miss", spends: false });
  out.push(
    { name: "again hit", p: again.hit, value: "hit", spends: true },
    { name: "again crit", p: again.crit, value: "crit", spends: true },
    { name: "again miss", p: again.miss - again.unspent, value: "miss", spends: true }
  );
  return out;
}

/** A row once the reroll is spent: as rolled. */
function spentOutcomes(roll_: ModesCase["roll"], bless: boolean): Outcomes {
  const rolled = asRolled(roll_, bless);
  return [
    { name: "hit", p: rolled.hit, value: "hit", spends: false },
    { name: "crit", p: rolled.crit, value: "crit", spends: false },
    { name: "miss", p: rolled.miss, value: "miss", spends: false },
  ];
}

describe("Turn.rerollFirstMiss with advantage, composed modes and add-dN", () => {
  const cases: { roll: ModesCase["roll"]; bless: boolean; modes: ModesCase["modes"] }[] = [
    { roll: "flat", bless: false, modes: ["advantage"] },
    { roll: "flat", bless: true, modes: ["advantage", "add-d20"] },
    { roll: "advantage", bless: false, modes: ["reroll", "add-d20"] },
    { roll: "disadvantage", bless: true, modes: ["advantage", "reroll"] },
    { roll: "flat", bless: false, modes: ["add-d8"] },
    { roll: "flat", bless: true, modes: ["add-d4"] },
    { roll: "advantage", bless: true, modes: ["add-d12"] },
    { roll: "disadvantage", bless: false, modes: ["add-d8"] },
  ];
  for (const c of cases) {
    it(`${c.roll}${c.bless ? " +1d4" : ""}: ${c.modes.join(" > ")} is exact against enumeration`, () => {
      const spec: MissRerollSpec = c.modes.length === 1 ? c.modes[0] : c.modes;
      const attack = attackOf(c.roll, c.bless);
      const t = turn([attack, attack]).onFirstHit(roll(1, d6)).rerollFirstMiss({ id: "spend", mode: spec });

      // Before the reroll is spent, a row plays the oracle's outcomes; after, as rolled.
      const outcomes = outcomesOf(c.roll, c.bless, c.modes);
      const plain = spentOutcomes(c.roll, c.bless);
      let mean = 0;
      let spent = 0;
      const stepValue = (value: Mode | "miss", landed: Mode | undefined): number =>
        value === "miss" ? 0 : SWORD[value] + (landed === undefined ? RIDER[value] : 0);
      for (const first of outcomes) {
        const landed1 = first.value === "miss" ? undefined : first.value;
        if (first.spends) {
          // The reroll is gone: the second attack plays as rolled.
          for (const second of plain) {
            const p = first.p * second.p;
            mean += p * (stepValue(first.value, undefined) + stepValue(second.value, landed1));
            spent += p;
          }
        } else {
          for (const second of outcomes) {
            // The second attack may still spend the reroll only if the first did not: a hit/crit/kept miss leaves it.
            const p = first.p * second.p;
            mean += p * (stepValue(first.value, undefined) + stepValue(second.value, landed1));
            if (second.spends) spent += p;
          }
        }
      }
      expect(t.mean()).toBeCloseTo(mean, 9);
      expect(t.fireProbability("spend")).toBeCloseTo(spent, 9);
    });
  }

  it("a Precision die is not spent on a miss it cannot cover: it stays for a later attack", () => {
    // +5 vs 15, 1d4 die: a roll of 5 misses by 5 (uncoverable); 10 misses by 0.. keep it for the second attack.
    const attack = d20.plus(5).ac(15).onHit(roll(1, d8).plus(3));
    const covers = turn([attack, attack]).rerollFirstMiss({ id: "p", mode: "add-d4" });
    const greedy = turn([attack, attack]).rerollFirstMiss({ id: "p", mode: "add-d20" });
    // A d4 can only cover shortfalls 1..4 (naturals 6..9): fewer misses are covered than rerolled by add-d20, and
    // the die is spent on fewer first attacks.
    expect(covers.fireProbability("p")).toBeLessThan(greedy.fireProbability("p"));
    expect(covers.fireProbability("p")).toBeGreaterThan(0);
  });

  it("pins the guide's examples", () => {
    const r7 = d20.plus(7).ac(16).onHit(roll(1, d8).plus(4));
    const t = turn([r7, r7]).onFirstHit(roll(2, d6));
    expect(t.rerollFirstMiss({ id: "z", mode: "add-d8" }).mean()).toBeCloseTo(20.70046875, 8);
    expect(t.rerollFirstMiss({ id: "z", mode: "add-d8" }).fireProbability("z")).toBeCloseTo(0.5775, 8);
    expect(t.rerollFirstMiss({ mode: "advantage" }).mean()).toBeCloseTo(22.9666, 8);
    const b = d20.plus(5).ac(15);
    expect(b.rerollMisses("advantage").onHit(1, d8).mean()).toBeCloseTo(4.512375, 9);
    expect(b.rerollMisses(["advantage", "add-d20"]).onHit(1, d8).mean()).toBeCloseTo(4.7584125, 9);
    expect(b.rerollMisses("add-d8").onHit(1, d8).mean()).toBeCloseTo(3.7125, 9);
  });

  it("sampling agrees with the exact mean", () => {
    const attack = attackOf("flat", true);
    for (const mode of ["advantage", ["advantage", "add-d20"], "add-d8"] as MissRerollSpec[]) {
      const t = turn([attack, attack]).onFirstHit(roll(1, d6)).rerollFirstMiss({ id: "r", mode });
      const rng: Rng = lcgRng(7);
      const n = 60000;
      let sum = 0;
      for (let i = 0; i < n; i++) {
        sum += t.sample(rng).total;
      }
      expect(Math.abs(sum / n - t.mean())).toBeLessThan(0.08);
    }
  });

  it("round-trips through Turn.from as plain data", () => {
    const attack = attackOf("flat", false);
    const mode = JSON.parse(JSON.stringify(["advantage", "add-d20"])) as MissRerollSpec;
    const spec = Turn.from({ attacks: [attack, attack], substitutes: [{ id: "r", on: "first-miss", substitute: "reroll", mode }] });
    expect(spec.mean()).toBeCloseTo(turn([attack, attack]).rerollFirstMiss({ id: "r", mode }).mean(), 12);
    expect(spec.mean()).toBeGreaterThan(turn([attack, attack]).rerollFirstMiss({ mode: "advantage" }).mean());
  });

  it("refuses a bad mode in a spec", () => {
    const attack = attackOf("flat", false);
    expect(() => turn([attack, attack]).rerollFirstMiss({ mode: ["advantage", "add-d8"] }).mean()).toThrow(/cannot be composed|unusable/);
    expect(() => turn([attack, attack]).convertFirstMiss({ id: "c" }).rerollFirstMiss().mean()).toThrow();
  });
});

describe("mode lists are copied", () => {
  it("rerollFirstMiss and Turn.from keep their own copy", () => {
    const attack = attackOf("flat", false);
    const modes: MissRerollSpec = ["advantage", "add-d20"];
    const built = turn([attack, attack]).rerollFirstMiss({ id: "r", mode: modes });
    const spec = Turn.from({ attacks: [attack, attack], substitutes: [{ id: "r", on: "first-miss", substitute: "reroll", mode: modes }] });
    const before = [built.mean(), spec.mean()];
    (modes as string[])[0] = "reroll";
    expect([built.mean(), spec.mean()]).toEqual(before);
    const rng = lcgRng(3);
    expect(() => built.sample(rng)).not.toThrow();
    expect(built.mean()).toBeCloseTo(before[0], 12);
  });
});
