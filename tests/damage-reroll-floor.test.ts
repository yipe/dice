import { describe, expect, it } from "vitest";
import { d20, d6, roll } from "../src/builder";
import type { AttackBuilder } from "../src/builder";
import type { PMF } from "../src/pmf/pmf";

/**
 * `rerollDamage(k)` and `minimumDamageDie(m)` add to a payload's own reroll and minimum rather than
 * replacing them, and the reroll cap is the optimal policy for the die as floored: reroll a face
 * `f` exactly when its kept value `max(f, m)` is below the expected value of a fresh floored die.
 *
 * The reference enumerates one die: faces `1..t` reroll once (the reroll is kept), then every
 * value is raised to at least `m`; the payload is the sum of independent dice.
 */

type Dist = Map<number, number>;

function oneDie(sides: number, rerollUpTo: number, minimum: number): Dist {
  const out: Dist = new Map();
  const add = (v: number, p: number) => {
    const floored = Math.max(v, minimum);
    out.set(floored, (out.get(floored) ?? 0) + p);
  };
  for (let f = 1; f <= sides; f++) {
    if (f <= rerollUpTo) {
      for (let g = 1; g <= sides; g++) add(g, 1 / sides / sides);
    } else add(f, 1 / sides);
  }
  return out;
}

function dice(count: number, sides: number, rerollUpTo: number, minimum: number): Dist {
  let dist: Dist = new Map([[0, 1]]);
  const die = oneDie(sides, rerollUpTo, minimum);
  for (let i = 0; i < count; i++) {
    const next: Dist = new Map();
    for (const [a, pa] of dist) for (const [b, pb] of die) next.set(a + b, (next.get(a + b) ?? 0) + pa * pb);
    dist = next;
  }
  return dist;
}

function expectBins(actual: PMF, expected: Dist): void {
  for (const k of new Set<number>([...actual.support(), ...expected.keys()])) {
    expect(actual.pAt(k), `bin ${k}`).toBeCloseTo(expected.get(k) ?? 0, 14);
  }
}

const hitOf = (attack: AttackBuilder): PMF => attack.resolve(0).hit;
const weapon = (payload = roll(2, d6)) => d20.plus(5).ac(10).onHit(payload);

describe("rerollDamage and minimumDamageDie keep a payload's own reroll and minimum", () => {
  it("rerollDamage(0) keeps the payload's reroll of 1s", () => {
    const hit = hitOf(weapon(roll(2, d6).reroll(1)).rerollDamage(0));
    expect(hit.mean()).toBeCloseTo(47 / 6, 14);
    expectBins(hit, dice(2, 6, 1, 0));
  });

  it("a lower rerollDamage never downgrades the payload's reroll", () => {
    const hit = hitOf(weapon(roll(2, d6).reroll(2)).rerollDamage(1));
    expect(hit.mean()).toBeCloseTo(25 / 3, 14);
    expectBins(hit, dice(2, 6, 2, 0));
  });

  it("a lower minimumDamageDie never lowers the payload's floor", () => {
    const hit = hitOf(weapon(roll(2, d6).minimum(3)).minimumDamageDie(2));
    expect(hit.mean()).toBeCloseTo(8, 14);
    expectBins(hit, dice(2, 6, 0, 3));
  });
});

describe("the reroll cap is optimal for the floored die", () => {
  it("with a floor of 4, rerolling a raw 4 is worth it (in either call order)", () => {
    // E[max(d6, 4)] = 27/6 = 4.5 > 4: faces 1..4 reroll, 5 and 6 stay.
    const expected = dice(2, 6, 4, 4);
    for (const attack of [
      weapon().minimumDamageDie(4).rerollDamage(6),
      weapon().rerollDamage(6).minimumDamageDie(4),
      weapon().minimumDamageDie(4).rerollDamage(4),
      weapon().rerollDamage(4).minimumDamageDie(4),
    ]) {
      const hit = hitOf(attack);
      expect(hit.mean()).toBeCloseTo(29 / 3, 14);
      expectBins(hit, expected);
    }
  });

  it("a cap below the optimum is a permission cap, not raised", () => {
    const hit = hitOf(weapon().minimumDamageDie(4).rerollDamage(2));
    expectBins(hit, dice(2, 6, 2, 4));
  });

  it("without a floor the cap is half the die", () => {
    // Rerolling 1..3 on a d6 (E 3.5): 17/4 per die.
    expect(hitOf(weapon().rerollDamage(5)).mean()).toBeCloseTo(17 / 2, 14);
    expectBins(hitOf(weapon().rerollDamage(5)), dice(2, 6, 3, 0));
  });
});
