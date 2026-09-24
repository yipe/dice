import { describe, expect, it } from "vitest";
import "../src/builder/ac";
import { d4, d6, d8, d20, roll } from "../src/builder/factory";
import { sumRolls, type RollBuilder } from "../src/builder/roll";
import { parse } from "../src/parser/parser";
import { AmbiguousCritDoublingError } from "../src/parser/scaleDice";
import type { PMF } from "../src/pmf/pmf";

/**
 * `parse(builder.toExpression())` must resolve to the builder's own distribution, bin for bin. Each
 * expected distribution below is an exact enumeration of the physical dice process (integer
 * weights), written here without the library.
 */

type Dist = { weights: Map<number, bigint>; total: bigint };

const constant = (value: number): Dist => ({ weights: new Map([[value, 1n]]), total: 1n });

/** One die: faces 1..reroll are rerolled once (the second roll kept), then floored at `minimum`. */
function die(sides: number, { reroll = 0, minimum = 0 } = {}): Dist {
  const weights = new Map<number, bigint>();
  const bump = (value: number, weight: bigint) =>
    weights.set(Math.max(value, minimum), (weights.get(Math.max(value, minimum)) ?? 0n) + weight);
  for (let first = 1; first <= sides; first++) {
    if (first <= reroll) for (let second = 1; second <= sides; second++) bump(second, 1n);
    else bump(first, BigInt(sides));
  }
  return { weights, total: BigInt(sides * sides) };
}

/** Independent `a` and `b` combined outcome by outcome. */
function combine(a: Dist, b: Dist, op: (x: number, y: number) => number): Dist {
  const weights = new Map<number, bigint>();
  for (const [x, wx] of a.weights) {
    for (const [y, wy] of b.weights) {
      const v = op(x, y);
      weights.set(v, (weights.get(v) ?? 0n) + wx * wy);
    }
  }
  return { weights, total: a.total * b.total };
}

const add = (...parts: Dist[]) => parts.reduce((sum, part) => combine(sum, part, (x, y) => x + y), constant(0));
const sub = (a: Dist, b: Dist) => combine(a, b, (x, y) => x - y);
const max = (a: Dist, b: Dist) => combine(a, b, Math.max);
const min = (a: Dist, b: Dist) => combine(a, b, Math.min);
const repeat = (count: number, a: Dist) => add(...Array<Dist>(count).fill(a));

function map(a: Dist, f: (x: number) => number): Dist {
  return combine(a, constant(0), (x) => f(x));
}

function mean(a: Dist): number {
  let sum = 0n;
  for (const [v, w] of a.weights) sum += BigInt(v) * w;
  return Number(sum) / Number(a.total);
}

function expectBins(actual: PMF, expected: Dist, context: string): void {
  const support = new Set([...actual.support(), ...expected.weights.keys()]);
  for (const value of support) {
    const p = Number(expected.weights.get(value) ?? 0n) / Number(expected.total);
    expect(Math.abs(actual.pAt(value) - p), `${context}: bin ${value}`).toBeLessThanOrEqual(1e-12);
  }
}

/** The builder, and its printed string re-parsed, both resolve to `expected`. */
function expectRoundTrip(builder: RollBuilder, expected: Dist, exactMean: number): void {
  expect(mean(expected)).toBeCloseTo(exactMean, 12);
  const expression = builder.toExpression();
  expectBins(builder.toPMF(), expected, `builder ${expression}`);
  expectBins(parse(expression), expected, expression);
}

describe("a ruled term after another term applies only to its own dice", () => {
  it("a reroll or a minimum after a sum", () => {
    expectRoundTrip(roll(1, d20).plus(5).plus(d8.reroll(1)), add(die(20), constant(5), die(8, { reroll: 1 })), 327 / 16);
    expectRoundTrip(d8.reroll(1).plus(d6.minimum(3)), add(die(8, { reroll: 1 }), die(6, { minimum: 3 })), 143 / 16);
    expectRoundTrip(
      d8.reroll(1).plus(d6.reroll(2)).plus(3),
      add(die(8, { reroll: 1 }), die(6, { reroll: 2 }), constant(3)),
      581 / 48
    );
  });

  it("advantage and disadvantage on a non-d20 die, alone or after other dice", () => {
    expectRoundTrip(roll(1, d6).plus(d4.withAdvantage()), add(die(6), max(die(4), die(4))), 53 / 8);
    const floored = die(6, { minimum: 3 });
    expectRoundTrip(d6.minimum(3).withDisadvantage(), min(floored, floored), 61 / 18);
    const rerolled = die(6, { reroll: 1 });
    expectRoundTrip(d6.reroll(1).withAdvantage(), max(rerolled, rerolled), 6161 / 1296);
  });

  it("a subtracted die with a minimum stays one die", () => {
    expectRoundTrip(
      roll(1, d8).minimum(2).minus(d4.minimum(3)),
      sub(die(8, { minimum: 2 }), die(4, { minimum: 3 })),
      11 / 8
    );
  });
});

describe("a term after a running total that can be 0 is still added", () => {
  it("after a negative flat or a subtracted die", () => {
    expectRoundTrip(d20.minus(5).plus(d4), add(die(20), constant(-5), die(4)), 8);
    expectRoundTrip(roll(1, d8).minus(d6).plus(d4), add(sub(die(8), die(6)), die(4)), 7 / 2);
  });

  it("after a pool whose lowest trial can be 0", () => {
    const trial = add(die(4), constant(-1));
    expectRoundTrip(roll(1, 4).minus(1).keepLowestAll(2, 1).plus(d6), add(min(trial, trial), die(6)), 35 / 8);
  });
});

describe("repeated keep and roll-type groups stay separate trials", () => {
  it("two keep-highest groups are two maxima, not the max of two sums", () => {
    const best = max(die(6), die(6));
    expectRoundTrip(d6.keepHighest(2, 1).plus(d6.keepHighest(2, 1)), add(best, best), 161 / 18);
    const best8 = max(die(8), die(8));
    expectRoundTrip(
      d8.keepHighest(2, 1).plus(d8.keepHighest(2, 1)).plus(d8.keepHighest(2, 1)),
      add(best8, best8, best8),
      279 / 16
    );
    const worst = min(die(6), die(6));
    expectRoundTrip(d6.keepLowest(2, 1).plus(d6.keepLowest(2, 1)), add(worst, worst), 91 / 18);
  });

  it("two advantage groups are two advantage rolls", () => {
    const best = max(die(6), die(6));
    expectRoundTrip(d6.withAdvantage().plus(d6.withAdvantage()), add(best, best), 161 / 18);
  });
});

describe("sumRolls parts keep their own transforms", () => {
  it("a halved or scaled part beside plain parts", () => {
    expectRoundTrip(
      sumRolls([d8.plus(3), d6.half()]),
      add(die(8), constant(3), map(die(6), (v) => Math.floor(v / 2))),
      9
    );
    expectRoundTrip(sumRolls([d6.half(), d8]), add(map(die(6), (v) => Math.floor(v / 2)), die(8)), 6);
    expectRoundTrip(sumRolls([d8, d6.scaleResult(2)]), add(die(8), map(die(6), (v) => 2 * v)), 23 / 2);
    expectRoundTrip(
      sumRolls([roll(2, d6).plus(3), roll(2, d8).scaleResult(1, 2)]),
      add(repeat(2, die(6)), constant(3), map(repeat(2, die(8)), (v) => Math.floor(v / 2))),
      57 / 4
    );
  });
});

describe("a sum with no positive leading term", () => {
  it("parses: the grammar has no unary minus", () => {
    expectRoundTrip(roll(1, d6).minus(d8), sub(die(6), die(8)), -1);
    expectRoundTrip(roll.flat(-3), constant(-3), -3);
    expectRoundTrip(roll.flat(5).minus(d8), sub(constant(5), die(8)), 1 / 2);
    expectRoundTrip(roll.flat(0).minus(d8).minus(d6), sub(sub(constant(0), die(8)), die(6)), -8);
  });
});

describe("pools print only when the expression is asked for", () => {
  it("an exploding die can be pooled, and printing it throws the explode refusal", () => {
    const exploding = combine(die(8), die(8), (x, y) => (x === 8 ? 8 + y : x));
    const pool = roll(1, d8).explode(1).keepHighestAll(2, 1);
    expectBins(pool.toPMF(), max(exploding, exploding), "pool");
    expect(() => pool.toExpression()).toThrow(/cannot represent an exploding die/);
    const worst = roll(1, d8).explode(1).keepLowestAll(2, 1).times(2);
    expectBins(worst.toPMF(), repeat(2, min(exploding, exploding)), "times");
    expect(() => worst.toExpression()).toThrow(/cannot represent an exploding die/);
  });

  it("doubling an exploding die with no single doubled meaning still names the ambiguity", () => {
    expect(() => roll(1, d8).explode(1).withAdvantage().doubleDice()).toThrow(AmbiguousCritDoublingError);
  });

  it("a pool of zero trials prints 0", () => {
    expectRoundTrip(roll(2, d6).keepHighestAll(2, 1).times(0), constant(0), 0);
  });
});

describe("maxOf prints as a keep-highest-of-1 over its roll", () => {
  it("re-parses to the max of independent rolls", () => {
    const sum2d6 = repeat(2, die(6));
    expectRoundTrip(roll(2, d6).maxOf(2), max(sum2d6, sum2d6), 5425 / 648);
    const withFlat = add(sum2d6, constant(3));
    expectBins(parse(roll(2, d6).plus(3).maxOf(3).toExpression()), max(max(withFlat, withFlat), withFlat), "maxOf 3");
  });
});
