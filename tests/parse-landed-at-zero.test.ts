import { describe, expect, it } from "vitest";
import { d20, d6, roll } from "../src/builder";
import { parse } from "../src/index";
import type { Dist } from "./enumerate-dice";
import { add, attack, expectLabelled, expectSameLabelled, map, max, mixLabelled, negate, point, repeat, uniform } from "./enumerate-dice";

/**
 * An attack check whose total is exactly 0 lands when its target is 0 or less, like any total that
 * meets the target, though its value, 0, is also where a miss sits. parse() carries that landing
 * through the check's `*`, its crit, `&` mixes and the miss, pc and save clauses. The oracle is
 * parse()'s own rule (a check lands where its total meets the target; no natural-1 or natural-20
 * rule), enumerated over every natural roll and bonus; where the builder's rule gives the same
 * outcomes, the builder is checked too.
 */

const D20 = uniform(20);
const D6 = uniform(6);
const TWO_D6 = repeat(D6, 2);

describe("an attack check that totals exactly 0 against a target of 0 or less lands", () => {
  it("(d20 - 5 AC 0) * (1d6): a natural 5 hits, like the builder's attack", () => {
    const parsed = parse("(d20 - 5 AC 0) * (1d6)");
    expectLabelled(parsed, attack({ natural: D20, bonus: point(-5), target: 0, critFrom: 20, hit: D6, crit: TWO_D6 }));
    expectSameLabelled(parsed, d20.minus(5).ac(0).onHit(roll(1, d6)).toPMF());
    expect(parsed.mean()).toBeCloseTo(2.975, 12);
    expect(parsed.outcomeProbability("hit")).toBeCloseTo(0.75, 12);
    expect(parsed.outcomeProbability("missNone")).toBeCloseTo(0.2, 12);
  });

  it("the builder's printed string reads back to the builder", () => {
    const built = d20.minus(5).ac(0).onHit(roll(1, d6));
    expectSameLabelled(parse(built.toExpression()), built.toPMF());
  });

  it("a crit clause applies to the hits that total 0", () => {
    const parsed = parse("(d20 - 5 AC 0) * (1d6) crit (2d6)");
    expectLabelled(parsed, attack({ natural: D20, bonus: point(-5), target: 0, critFrom: 20, hit: D6, crit: TWO_D6 }));
  });

  it("a natural 20 that totals exactly 0 crits", () => {
    const parsed = parse("(d20 - 20 AC 0) * (1d6)");
    expectLabelled(parsed, attack({ natural: D20, bonus: point(-20), target: 0, critFrom: 20, hit: D6, crit: TWO_D6 }));
    expectSameLabelled(parsed, d20.minus(20).ac(0).onHit(roll(1, d6)).toPMF());
  });

  it("an xcrit range crits on a natural face whose total is exactly 0", () => {
    const parsed = parse("(d20 - 19 AC 0) * (1d6) xcrit2 (2d6)");
    expectLabelled(parsed, attack({ natural: D20, bonus: point(-19), target: 0, critFrom: 19, hit: D6, crit: TWO_D6 }));
  });

  it("after xcrit0 every landing is a hit, one that totals 0 included", () => {
    const parsed = parse("(d20 - 5 AC 0) * (1d6) xcrit0 (1d6)");
    expectLabelled(parsed, attack({ natural: D20, bonus: point(-5), target: 0, critFrom: 21, hit: D6, crit: D6 }));
    expectSameLabelled(parsed, d20.minus(5).ac(0).onHit(roll(1, d6)).noCrit().toPMF());
  });

  it("with advantage the kept natural roll lands at 0 and crits on a 20", () => {
    const parsed = parse("(d20 > d20 - 5 AC 0) * (1d6)");
    const natural = max(D20, D20);
    expectLabelled(parsed, attack({ natural, bonus: point(-5), target: 0, critFrom: 20, hit: D6, crit: TWO_D6 }));
    expectSameLabelled(parsed, d20.withAdvantage().minus(5).ac(0).onHit(roll(1, d6)).toPMF());
  });

  it.each<[string, Dist]>([
    ["(d20 - 8 + 1d4 AC 0) * (1d6)", add(point(-8), uniform(4))],
    ["(d20 - 1d10 AC 0) * (1d6)", negate(uniform(10))],
    ["(d20 - 12 - 1d4 AC -3) * (1d6)", add(point(-12), negate(uniform(4)))],
  ])("%s: a total of 0 from bonus or subtracted dice lands", (expression, bonus) => {
    const target = Number(expression.match(/AC (-?\d+)/)![1]);
    expectLabelled(parse(expression), attack({ natural: D20, bonus, target, critFrom: 20, hit: D6, crit: TWO_D6 }));
  });

  it("a check with no die that totals 0 always lands", () => {
    expectLabelled(parse("(5 - 5 AC 0) * (1d6)"), attack({ natural: point(0), bonus: point(0), target: 0, critFrom: 21, hit: D6, crit: D6 }));
  });

  it("the check on its own labels a landed total of 0 a hit", () => {
    const hits = map(D20, (natural) => natural - 5);
    const expected = new Map([...hits].filter(([total]) => total > 0).map(([total, p]) => [total, { hit: p }]));
    expected.set(0, { hit: 1 / 20, missNone: 4 / 20 });
    expectLabelled(parse("d20 - 5 AC 0"), expected);
  });
});

describe("the miss clauses leave the landed totals of 0 with the hits", () => {
  it("a miss clause deals its damage to the misses only", () => {
    const parsed = parse("(d20 - 5 AC 0) * (1d6) crit (2d6) miss (1)");
    const spec = { natural: D20, bonus: point(-5), target: 0, critFrom: 20, hit: D6, crit: TWO_D6, miss: point(1) };
    expectLabelled(parsed, attack(spec));
    expectSameLabelled(parsed, d20.minus(5).ac(0).onHit(roll(1, d6)).onMiss(1).toPMF());
  });

  it("with a negative target the misses are the checks that fall short, not the lowest landed total", () => {
    const parsed = parse("(d20 - 10 AC -5) * (1d6) crit (2d6) miss (1)");
    const spec = { natural: D20, bonus: point(-10), target: -5, critFrom: 20, hit: D6, crit: TWO_D6, miss: point(1) };
    expectLabelled(parsed, attack(spec));
    expectSameLabelled(parsed, d20.minus(10).ac(-5).onHit(roll(1, d6)).onMiss(1).toPMF());
  });

  it("pc deals half its damage to the misses only", () => {
    const halved = map(D6, (value) => Math.floor(value / 2));
    const spec = { natural: D20, bonus: point(-5), target: 0, critFrom: 20, hit: D6, crit: TWO_D6, miss: halved, missLabel: "pc" };
    expectLabelled(parse("(d20 - 5 AC 0) * (1d6) crit (2d6) pc (1d6)"), attack(spec));
  });
});

describe("an `&` mix of attack checks lands each side's totals of 0", () => {
  it("((d20 - 5 AC 0) & (d20 AC 10)) * (1d6) is an even mix of the two attacks", () => {
    const low = attack({ natural: D20, bonus: point(-5), target: 0, critFrom: 20, hit: D6, crit: TWO_D6 });
    const plain = attack({ natural: D20, bonus: point(0), target: 10, critFrom: 20, hit: D6, crit: TWO_D6 });
    expectLabelled(parse("((d20 - 5 AC 0) & (d20 AC 10)) * (1d6)"), mixLabelled([low, 1 / 2], [plain, 1 / 2]));
    expectLabelled(parse("((d20 AC 10) & (d20 - 5 AC 0)) * (1d6)"), mixLabelled([low, 1 / 2], [plain, 1 / 2]));
  });
});
