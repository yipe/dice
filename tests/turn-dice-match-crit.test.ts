import { describe, expect, it } from "vitest";
import { d20, d8, roll, turn } from "../src/builder";

/** Every ordered roll of `count` d`faces`: total → [P(total ∧ a face repeats), P(total ∧ all differ)]. */
function totalsByMatch(count: number, faces: number): Map<number, [number, number]> {
  const out = new Map<number, [number, number]>();
  const p = 1 / faces ** count;
  const walk = (values: number[]): void => {
    if (values.length === count) {
      const total = values.reduce((a, b) => a + b, 0);
      const entry = out.get(total) ?? [0, 0];
      entry[new Set(values).size < count ? 0 : 1] += p;
      out.set(total, entry);
      return;
    }
    for (let face = 1; face <= faces; face++) walk([...values, face]);
  };
  walk([]);
  return out;
}

/** P(total) of `count` d`faces`. */
function sumOf(count: number, faces: number): Map<number, number> {
  const out = new Map<number, number>();
  for (const [total, [matched, distinct]] of totalsByMatch(count, faces)) out.set(total, matched + distinct);
  return out;
}

describe("a damage rider on a dice match", () => {
  it("doubles its dice when the matching landing was a crit", () => {
    // Orb: d20+5 vs AC 17 — hit 8/20 (3d8), crit 1/20 (6d8), miss 11/20. Rider 2d6, 4d6 on a crit.
    const orb = d20.plus(5).ac(17).onHit(roll(3, d8));
    const t = turn(orb).onDiceMatch(["attack 1"], roll(2, 6), { id: "dm" });

    const expected = new Map<number, number>([[0, 11 / 20]]);
    const add = (value: number, mass: number): void => {
      expected.set(value, (expected.get(value) ?? 0) + mass);
    };
    for (const [chance, dice, rider] of [
      [8 / 20, 3, sumOf(2, 6)],
      [1 / 20, 6, sumOf(4, 6)],
    ] as const) {
      for (const [total, [matched, distinct]] of totalsByMatch(dice, 8)) {
        add(total, chance * distinct);
        for (const [extra, p] of rider) add(total + extra, chance * matched * p);
      }
    }

    const support = new Set([...t.pmf.support(), ...expected.keys()]);
    for (const value of support) expect(t.pmf.pAt(value)).toBeCloseTo(expected.get(value) ?? 0, 12);
    expect(t.mean()).toBeCloseTo(342371 / 40960, 12);
  });
});
