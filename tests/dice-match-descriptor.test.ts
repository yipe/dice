import { describe, expect, it } from "vitest";
import { bounce, d20, d8, flat, roll, TurnSpecError } from "../src/builder";
import type { AttackBuilder } from "../src/builder";

/**
 * A dice-match descriptor reads "the dice" of a payload as a plain pool whose faces add up to the
 * damage. A pool where that is not true — dice that explode into extra dice, a die rolled with
 * advantage (one kept die, not a pool), or a subtracted pool — has no descriptor, so a
 * `dice-match` rider on it is refused instead of reading the wrong match odds.
 */

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof TurnSpecError) return error.code;
    throw error;
  }
  return undefined;
}

const cases: [string, AttackBuilder][] = [
  ["an exploding pool", d20.plus(5).ac(17).onHit(roll(3, d8).explode(1))],
  ["an advantaged pool", d20.plus(5).ac(17).onHit(roll(3, d8).withAdvantage()).noCrit()],
  ["a subtracted pool", d20.plus(5).ac(17).onHit(flat(30).minus(roll(3, d8)))],
];

describe("a pool that is not a plain sum of faces has no dice-match descriptor", () => {
  for (const [name, attack] of cases) {
    it(`bounce() on ${name} is refused`, () => {
      expect(codeOf(() => bounce({ source: attack, max: 1 }).mean())).toBe("no-dice-descriptor");
    });

    it(`diceMatchInfo() on ${name} has no hit descriptor`, () => {
      expect(attack.diceMatchInfo().hit).toBeNull();
    });
  }

  it("a plain pool still has one", () => {
    const attack = d20.plus(5).ac(17).onHit(roll(3, d8));
    expect(attack.diceMatchInfo().hit).not.toBeNull();
    expect(codeOf(() => bounce({ source: attack, max: 1 }).mean())).toBeUndefined();
  });
});
